import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testModel } from "../src/modelTest.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import type { UsageRecord } from "../src/usageLog.js";

let upstream: Server;
let upstreamUrl: string;
let respond: () => { status: number; body: unknown };
let recorded: Omit<UsageRecord, "ts">[];

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
      const answer = respond();
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
      // Body isn't asserted on here; other tests cover payload shape.
      void raw;
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
