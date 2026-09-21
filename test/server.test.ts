import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxyServer, estimateInputTokens } from "../src/server/index.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";

/** Records what the proxy sent upstream so the tests can assert on it. */
interface Capture {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let upstream: Server;
let proxy: Server;
let upstreamUrl: string;
let proxyUrl: string;
let captured: Capture[] = [];
/** Set per test to control what the fake upstream answers with. */
let respond: (path: string) => { status: number; headers: Record<string, string>; body: string };
/** Models the proxy asked to switch off streaming, instead of touching disk. */
let marked: string[] = [];
let streamlessModel = false;
/** Usage entries the proxy recorded, instead of writing to the real log. */
let recordedUsage: Record<string, unknown>[] = [];

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    openrouterApiKey: "sk-or-test",
    openrouterBaseUrl: `${upstreamUrl}/api/v1`,
    anthropicBaseUrl: upstreamUrl,
    models: [
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        maxOutputTokens: 8192,
        ...(streamlessModel ? { stream: false } : {}),
      },
    ],
  };
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push({
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const answer = respond(req.url ?? "");
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  proxy = createProxyServer({
    loadConfig: config,
    markNonStreaming: (modelId) => {
      marked.push(modelId);
      return true;
    },
    recordUsage: (entry) => {
      recordedUsage.push(entry);
    },
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function jsonUpstream(body: unknown, status = 200) {
  return () => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  captured = [];
  recordedUsage = [];
  return fetch(`${proxyUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("proxy routing", () => {
  it("translates a configured model into an OpenRouter call", async () => {
    respond = jsonUpstream({
      id: "gen-1",
      choices: [{ message: { content: "merhaba" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    const response = await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "selam" }],
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(captured[0]?.path).toBe("/api/v1/chat/completions");
    expect(captured[0]?.headers.authorization).toBe("Bearer sk-or-test");
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "openai/gpt-5",
      content: [{ type: "text", text: "merhaba" }],
      stop_reason: "end_turn",
    });
  });

  it("records cost and tokens for a non-streamed OpenRouter response", async () => {
    respond = jsonUpstream({
      id: "gen-1",
      choices: [{ message: { content: "merhaba" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.0003 },
    });

    await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "selam" }],
    });

    expect(recordedUsage).toEqual([
      {
        model: "openai/gpt-5",
        promptTokens: 5,
        completionTokens: 2,
        reasoningTokens: undefined,
        cost: 0.0003,
        stream: false,
      },
    ]);
  });

  it("passes a Claude model through with its credential and beta headers intact", async () => {
    respond = jsonUpstream({ id: "msg_1", type: "message", content: [] });

    await post(
      "/v1/messages",
      { model: "claude-opus-5", max_tokens: 100, messages: [] },
      { "x-api-key": "sk-ant-secret", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14" },
    );

    expect(captured[0]?.path).toBe("/v1/messages");
    expect(captured[0]?.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(captured[0]?.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
  });

  it("never leaks the Anthropic credential to OpenRouter", async () => {
    respond = jsonUpstream({ choices: [{ message: { content: "ok" } }] });

    await post(
      "/v1/messages",
      { model: "openai/gpt-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] },
      { "x-api-key": "sk-ant-secret", authorization: "Bearer oauth-token" },
    );

    const headers = captured[0]?.headers ?? {};
    expect(headers.authorization).toBe("Bearer sk-or-test");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("sk-ant-secret");
    expect(JSON.stringify(headers)).not.toContain("oauth-token");
  });

  it("streams an OpenRouter response as Anthropic events", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"id":"gen-2","choices":[{"delta":{"content":"Mer"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"haba"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\n' +
        "data: [DONE]\n\n",
    });

    const response = await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "selam" }],
    });
    const text = await response.text();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(captured[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    for (const event of [
      "event: message_start",
      "event: content_block_start",
      "event: content_block_delta",
      "event: content_block_stop",
      "event: message_delta",
      "event: message_stop",
    ]) {
      expect(text).toContain(event);
    }
    expect(text).toContain('"text":"Mer"');
    expect(text).toContain('"text":"haba"');
  });

  it("records cost from the final chunk of a streamed response", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"id":"gen-2","choices":[{"delta":{"content":"Mer"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],' +
        '"usage":{"prompt_tokens":9,"completion_tokens":2,"cost":0.0005}}\n\n' +
        "data: [DONE]\n\n",
    });

    await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "selam" }],
    });

    expect(recordedUsage).toEqual([
      {
        model: "openai/gpt-5",
        promptTokens: 9,
        completionTokens: 2,
        reasoningTokens: undefined,
        cost: 0.0005,
        stream: true,
      },
    ]);
  });

  it("records nothing when a mid-stream chunk reports an error", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n' +
        'data: {"error":{"message":"upstream oldu"}}\n\n' +
        "data: [DONE]\n\n",
    });

    await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "selam" }],
    });

    expect(recordedUsage).toEqual([]);
  });

  it("reports an OpenRouter failure in the Anthropic error shape", async () => {
    respond = jsonUpstream({ error: { message: "model bulunamadi" } }, 404);

    const response = await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "x" }],
    });
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("not_found_error");
    expect(body.error.message).toContain("model bulunamadi");
  });

  it("rescues a streamed tool call written as text and switches the model off streaming", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"id":"gen-3","choices":[{"delta":{"content":"<function=Read>\\n<parameter=file_path>\\n"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"a.txt\\n</parameter>\\n</function>"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
    });
    marked = [];

    const response = await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "a.txt oku" }],
      tools: [
        {
          name: "Read",
          input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        },
      ],
    });
    const text = await response.text();

    // The turn itself is rescued: a real tool_use block reaches Claude Code.
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"Read"');
    expect(text).toContain('"file_path\\":\\"a.txt');
    expect(text).toContain('"stop_reason":"tool_use"');
    // And the next turn avoids the streaming path entirely.
    expect(marked).toEqual(["openai/gpt-5"]);
  });

  it("recovers a text tool call from a non-streamed response too", async () => {
    streamlessModel = true;
    respond = jsonUpstream({
      id: "gen-7",
      choices: [
        {
          message: {
            content:
              "<function=Read>\n<parameter=file_path>\n/etc/hostname\n</parameter>\n</function>",
          },
          finish_reason: "stop",
        },
      ],
    });

    const response = await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "oku" }],
      tools: [
        {
          name: "Read",
          input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        },
      ],
    });
    const body = (await response.json()) as {
      content: { type: string; name?: string; input?: unknown }[];
      stop_reason: string;
    };
    streamlessModel = false;

    expect(body.stop_reason).toBe("tool_use");
    expect(body.content.find((block) => block.type === "tool_use")).toMatchObject({
      name: "Read",
      input: { file_path: "/etc/hostname" },
    });
  });

  it("leaves a model alone when the stream carries real tool calls", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"Read","arguments":"{}"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
        "data: [DONE]\n\n",
    });
    marked = [];

    await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "a.txt oku" }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
    });

    expect(marked).toEqual([]);
  });

  it("leaves a model alone when prose merely looks unusual and no tools were offered", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'data: {"choices":[{"delta":{"content":"<function=Read>"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
    });
    marked = [];

    await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "selam" }],
    });

    expect(marked).toEqual([]);
  });

  it("builds the stream itself for a model configured without upstream streaming", async () => {
    streamlessModel = true;
    respond = jsonUpstream({
      id: "gen-4",
      choices: [
        {
          message: {
            content: "Okuyorum.",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "Read", arguments: '{"p":1}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const response = await post("/v1/messages", {
      model: "openai/gpt-5",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "a.txt oku" }],
    });
    const text = await response.text();
    streamlessModel = false;

    // The upstream call went out without streaming...
    expect(captured[0]?.body).not.toHaveProperty("stream");
    // ...but Claude Code still receives a well-formed stream.
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain("event: message_stop");
  });

  it("rejects a body that is not JSON", async () => {
    captured = [];
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "bozuk",
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { type: string }).toMatchObject({ type: "error" });
  });

  it("estimates tokens locally for an OpenRouter model", async () => {
    respond = jsonUpstream({});

    const response = await post("/v1/messages/count_tokens", {
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "a".repeat(400) }],
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { input_tokens: number }).toMatchObject({
      input_tokens: 100,
    });
    // Nothing was sent upstream for the estimate.
    expect(captured).toHaveLength(0);
  });

  it("forwards count_tokens for a Claude model", async () => {
    respond = jsonUpstream({ input_tokens: 42 });

    const response = await post("/v1/messages/count_tokens", {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "x" }],
    });

    expect((await response.json()) as { input_tokens: number }).toMatchObject({ input_tokens: 42 });
    expect(captured[0]?.path).toBe("/v1/messages/count_tokens");
  });

  it("answers the connection-warming probe and the health check", async () => {
    expect((await fetch(`${proxyUrl}/api/hello`, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(`${proxyUrl}/healthz`)).status).toBe(200);
  });

  it("lists configured models alongside the upstream ones for discovery", async () => {
    respond = jsonUpstream({ data: [{ id: "claude-opus-5" }] });

    const response = await fetch(`${proxyUrl}/v1/models`);
    const body = (await response.json()) as { data: { id: string; display_name?: string }[] };

    expect(body.data.map((model) => model.id)).toEqual(["claude-opus-5", "openai/gpt-5"]);
    expect(body.data[1]?.display_name).toBe("GPT-5");
  });
});

describe("estimateInputTokens", () => {
  it("counts the system prompt, messages and tools", () => {
    const estimate = estimateInputTokens({
      model: "openai/gpt-5",
      system: "a".repeat(40),
      messages: [{ role: "user", content: "b".repeat(40) }],
    });

    expect(estimate).toBe(20);
  });
});
