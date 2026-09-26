import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareModels, testModel } from "../src/modelTest.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import type { UsageRecord } from "../src/usageLog.js";

let upstream: Server;
let upstreamUrl: string;
let respond: () => { status: number; body: unknown };
let recorded: Omit<UsageRecord, "ts">[];
/** The body of the most recent request, so a test can answer per model. */
let lastRequestBody = "";

/**
 * Key resolution prefers OPENROUTER_API_KEY, then the key file, then the
 * legacy config field — a real key file on the test machine would otherwise
 * make the "no key" case impossible to reproduce. Isolate the data dir.
 */
const originalDir = process.env.CLAUDE_OPENROUTER_DIR;
const originalEnvKey = process.env.OPENROUTER_API_KEY;
let isolatedDir: string;

beforeAll(async () => {
  isolatedDir = mkdtempSync(join(tmpdir(), "cor-modeltest-"));
  process.env.CLAUDE_OPENROUTER_DIR = isolatedDir;
  delete process.env.OPENROUTER_API_KEY;

  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      lastRequestBody = raw;
      const answer = respond();
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  rmSync(isolatedDir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalDir;
  if (originalEnvKey !== undefined) process.env.OPENROUTER_API_KEY = originalEnvKey;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  recorded = [];
  lastRequestBody = "";
  respond = () => ({
    status: 200,
    body: {
      id: "gen-1",
      choices: [{ message: { content: "Hello there!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.0002 },
    },
  });
});

function config(): Config {
  return { ...DEFAULT_CONFIG, openrouterApiKey: "sk-or-test", openrouterBaseUrl: upstreamUrl };
}

describe("testModel", () => {
  it("returns the reply, timing and cost on success", async () => {
    const result = await testModel(config(), { id: "openai/gpt-5" }, (entry) => recorded.push(entry));

    expect(result).toMatchObject({
      ok: true,
      text: "Hello there!",
      promptTokens: 12,
      completionTokens: 4,
      cost: 0.0002,
    });
    if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records the call in the usage log like a real request", async () => {
    await testModel(config(), { id: "openai/gpt-5" }, (entry) => recorded.push(entry));

    expect(recorded).toEqual([
      {
        model: "openai/gpt-5",
        promptTokens: 12,
        completionTokens: 4,
        reasoningTokens: undefined,
        cost: 0.0002,
        stream: false,
      },
    ]);
  });

  it("reports no_key without ever calling the upstream", async () => {
    let called = false;
    respond = () => {
      called = true;
      return { status: 200, body: {} };
    };

    const result = await testModel(
      { ...config(), openrouterApiKey: undefined },
      { id: "openai/gpt-5" },
      (entry) => recorded.push(entry),
    );

    expect(result).toMatchObject({ ok: false });
    expect(called).toBe(false);
    expect(recorded).toEqual([]);
  });

  it("surfaces an upstream HTTP error without recording usage", async () => {
    respond = () => ({ status: 500, body: { error: { message: "kaboom" } } });

    const result = await testModel(config(), { id: "openai/gpt-5" }, (entry) => recorded.push(entry));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
    expect(recorded).toEqual([]);
  });

  it("surfaces an OpenRouter error body without recording usage", async () => {
    respond = () => ({ status: 200, body: { error: { message: "model unavailable" } } });

    const result = await testModel(config(), { id: "openai/gpt-5" }, (entry) => recorded.push(entry));

    expect(result).toEqual({ ok: false, error: "model unavailable" });
    expect(recorded).toEqual([]);
  });
});

describe("compareModels", () => {
  it("returns one { model, result } per entry, in the order given", async () => {
    const results = await compareModels(
      config(),
      [{ id: "openai/gpt-5" }, { id: "qwen/qwen3-max" }],
      "tek kelimeyle selam ver",
      (entry) => recorded.push(entry),
    );

    expect(results.map((entry) => entry.model)).toEqual(["openai/gpt-5", "qwen/qwen3-max"]);
    for (const entry of results) {
      expect(entry.result).toMatchObject({
        ok: true,
        text: "Hello there!",
        promptTokens: 12,
        completionTokens: 4,
        cost: 0.0002,
      });
    }
  });

  it("records both calls in the usage log, tagged with their own model", async () => {
    await compareModels(
      config(),
      [{ id: "openai/gpt-5" }, { id: "qwen/qwen3-max" }],
      "selam",
      (entry) => recorded.push(entry),
    );

    expect(recorded.map((entry) => entry.model).sort()).toEqual(["openai/gpt-5", "qwen/qwen3-max"]);
  });

  it("sends the same prompt to every model", async () => {
    const prompts: string[] = [];
    respond = () => {
      prompts.push(lastRequestBody);
      return {
        status: 200,
        body: { id: "gen-1", choices: [{ message: { content: "ok" } }], usage: {} },
      };
    };

    await compareModels(
      config(),
      [{ id: "a/one" }, { id: "b/two" }, { id: "c/three" }],
      "ayni soru",
      (entry) => recorded.push(entry),
    );

    expect(prompts).toHaveLength(3);
    for (const body of prompts) {
      expect((JSON.parse(body) as { messages: { content: string }[] }).messages[0]?.content).toBe("ayni soru");
    }
  });

  it("keeps the healthy model when the other one errors", async () => {
    // The two run concurrently, so the failing one is the one whose own id the
    // upstream rejects.
    respond = () => {
      if (lastRequestBody.includes("bozuk-model")) {
        return { status: 500, body: { error: { message: "kaboom" } } };
      }
      return {
        status: 200,
        body: {
          id: "gen-1",
          choices: [{ message: { content: "Hello there!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.0002 },
        },
      };
    };

    const results = await compareModels(
      config(),
      [{ id: "bozuk-model" }, { id: "openai/gpt-5" }],
      "selam",
      (entry) => recorded.push(entry),
    );

    const byModel = Object.fromEntries(results.map((entry) => [entry.model, entry.result]));
    expect(byModel["bozuk-model"]).toMatchObject({ ok: false });
    expect((byModel["bozuk-model"] as { error: string }).error).toContain("500");
    expect(byModel["openai/gpt-5"]).toMatchObject({ ok: true, text: "Hello there!" });
    // Only the successful call is billable, so only it reaches the usage log.
    expect(recorded.map((entry) => entry.model)).toEqual(["openai/gpt-5"]);
  });

  it("reports no_key for every model without calling the upstream", async () => {
    let called = false;
    respond = () => {
      called = true;
      return { status: 200, body: {} };
    };

    const results = await compareModels(
      { ...config(), openrouterApiKey: undefined },
      [{ id: "a/one" }, { id: "b/two" }],
      "selam",
      (entry) => recorded.push(entry),
    );

    expect(results.every((entry) => entry.result.ok === false)).toBe(true);
    expect(called).toBe(false);
    expect(recorded).toEqual([]);
  });

  it("returns an empty list for no models", async () => {
    expect(await compareModels(config(), [], "selam", (entry) => recorded.push(entry))).toEqual([]);
    expect(recorded).toEqual([]);
  });
});
