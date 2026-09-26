import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createProxyServer } from "../src/server/index.js";
import {
  DEFAULT_CONFIG,
  listConfigHistory,
  saveConfig,
  saveKey,
  type Config,
  type ModelEntry,
} from "../src/config.js";
import { renderAgent, type AgentOptions } from "../src/agentTemplate.js";
import type { AgentSummary } from "../src/agentDiscovery.js";
import { resetAlertState } from "../src/alerts.js";
import type { TestModelResult } from "../src/modelTest.js";
import type { UsageRecord } from "../src/usageLog.js";
import { recordRequest, resetMetrics, type MetricsSummary } from "../src/metrics.js";

let upstream: Server;
let proxy: Server;
let upstreamUrl: string;
let proxyUrl: string;

let models: ModelEntry[];
let hasKey: boolean;
let budget: Config["budget"];
let alerts: Config["alerts"];
let keyResponse: () => { status: number; body: unknown };
let savedConfigs: Config[];
let syncCalls: ModelEntry[][];
let revertCalls: number;
let fakeAgents: AgentSummary[];
let writtenAgents: { name: string; modelId: string; scope: AgentOptions["scope"] }[];
let deletedAgentFiles: string[];
let fakeUsage: UsageRecord[];
let dashboardRecorded: Omit<UsageRecord, "ts">[];
let fakeNow: number;
let syncedFlag: boolean;
let fakeLogLines: string[];
let testModelResponse: TestModelResult;
let stopCalls: number;
let restartCalls: number;
let requestedLogLines: number[];
/** Isolated agents root for the endpoints that call into the real agentDiscovery. */
let agentsRoot: string;
/** Resolved per request by the injected loadConfig, so tests can see mutations. */
let currentConfig: Config;
/** Cache key for the fake upstream catalog (the real one caches for 10 minutes). */
let baseUrlSuffix = "/api/v1";
let catalogFreshness = 0;
/** URL -> canned answer, for the endpoints that reach upstream through global fetch. */
let upstreamAnswers: Record<string, { status: number; body: unknown }>;
const originalFetch = globalThis.fetch;
const originalEnvKey = process.env.OPENROUTER_API_KEY;

function jsonAnswer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readFileText(path: string): string {
  return readFileSync(path, "utf8");
}

/** Sets the shared env key the resolution order reads first, then clears it. */
function withEnvApiKey<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.OPENROUTER_API_KEY;
  if (value === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
}

/**
 * Stands in for globalThis.fetch while a test drives the endpoints that reach
 * OpenRouter through it. Answers a canned response for the fixture's own
 * base url (which the endpoint composes after loadConfig) and passes
 * everything else — the dashboard itself, and the fixture server's /key,
 * /models and /endpoints routes — through the real fetch. The one OpenRouter
 * route the fixture has no handler for is rejected, so no test can reach the
 * real network.
 */
function fetchStub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(url).pathname;
  const answer = upstreamAnswers[url] ?? upstreamAnswers[pathname];
  if (answer) return Promise.resolve(jsonAnswer(answer.status, answer.body));

  if (pathname.endsWith("/chat/completions")) {
    return Promise.reject(new Error(`stubbed fetch got an unexpected url: ${url}`));
  }
  // Everything else — the dashboard itself, and the fixture server's own
  // /key, /models and /endpoints routes — goes through the real fetch.
  return originalFetch(input, init);
}

/**
 * Points the catalog endpoint at a fake upstream. getCachedCatalog keys its
 * cache on the base url, so each fixture gets a fresh one; otherwise the
 * previous test's catalog would be served instead of the stub's.
 */
function stubCatalogFetch(models: Record<string, unknown>[]): void {
  catalogFreshness += 1;
  baseUrlSuffix = `/api/v1/probe-${catalogFreshness}`;
  upstreamAnswers[`${upstreamUrl}${baseUrlSuffix}/models`] = { status: 200, body: { data: models } };
}

/** What renderAgent() writes plus a hand-authored key nobody manages. */
function agentFixture(name: string, modelId: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: Tek dosya uygulayicisi`,
    `model: ${modelId}`,
    "tools: Read, Edit, Write",
    "permissionMode: acceptEdits",
    "maxTurns: 30",
    "---",
    "",
    `Sen ${modelId} uzerinde calisan bir uygulayicisin.`,
    "",
    "Kurallar:",
    "",
    "1. Sadece sana verilen dosyayi degistir.",
    "",
  ].join("\n");
}

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    openrouterApiKey: hasKey ? "sk-or-test" : undefined,
    openrouterBaseUrl: `${upstreamUrl}${baseUrlSuffix}`,
    anthropicBaseUrl: upstreamUrl,
    models,
    // The budget and alerts endpoints read their thresholds off this object,
    // so unlike port or the base urls they can't be faked per request.
    budget,
    alerts,
  };
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/v1/key") {
      const answer = keyResponse();
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
      return;
    }
    if (url.pathname === "/api/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ id: "openai/gpt-5", name: "GPT-5", context_length: 400000 }] }),
      );
      return;
    }
    if (url.pathname === "/api/v1/models/openai/gpt-5/endpoints") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            endpoints: [
              { provider_name: "Test", pricing: { prompt: "0.000001", completion: "0.000002" } },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  proxy = createProxyServer({
    // One object per request, kept in `currentConfig` so a test can read back
    // what an endpoint mutated on it; the real handler does the same.
    loadConfig: () => {
      currentConfig = config();
      return currentConfig;
    },
    dashboard: {
      saveConfig: (cfg) => {
        savedConfigs.push(cfg);
        models = cfg.models;
      },
      readUsage: () => fakeUsage,
      syncModelPicker: (m) => {
        syncCalls.push(m);
        return { path: "/fake/settings.json", removed: m.length === 0 };
      },
      revertModelPicker: () => {
        revertCalls += 1;
        return { path: "/fake/settings.json", restored: true };
      },
      listAgents: () => fakeAgents,
      writeAgent: (options) => {
        writtenAgents.push({ name: options.name, modelId: options.modelId, scope: options.scope });
        return { path: `/fake/.claude/agents/${options.name}.md`, overwritten: false };
      },
      deleteAgent: (file) => {
        deletedAgentFiles.push(file);
      },
      isModelPickerSynced: () => syncedFlag,
      recordUsage: (entry) => {
        dashboardRecorded.push(entry);
      },
      testModel: async (_cfg, entry, recordUsage) => {
        recordUsage({
          model: entry.id,
          promptTokens: 1,
          completionTokens: 1,
          cost: 0,
          stream: false,
        });
        return testModelResponse;
      },
      tailLog: (maxLines) => {
        requestedLogLines.push(maxLines);
        return fakeLogLines;
      },
      stopProcess: () => {
        stopCalls += 1;
      },
      restartProcess: () => {
        restartCalls += 1;
      },
      now: () => fakeNow,
    },
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

let keyDir: string;
const originalKeyDir = process.env.CLAUDE_OPENROUTER_DIR;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  // keySource()/resolveOpenRouterKey() read the real key file from disk;
  // isolate that lookup so a leftover key on the machine running the tests
  // can't change what "config"/"file" resolve to below.
  keyDir = mkdtempSync(join(tmpdir(), "cor-dashboard-key-"));
  process.env.CLAUDE_OPENROUTER_DIR = keyDir;

  models = [];
  hasKey = true;
  budget = undefined;
  alerts = undefined;
  keyResponse = () => ({
    status: 200,
    body: {
      data: {
        label: "sk-or-...test",
        usage: 1.5,
        limit: 10,
        limit_remaining: 8.5,
        limit_reset: null,
        is_free_tier: false,
        usage_daily: 0.1,
        usage_weekly: 0.5,
        usage_monthly: 1.5,
        rate_limit: { interval: "10s", requests: -1 },
      },
    },
  });
  savedConfigs = [];
  syncCalls = [];
  revertCalls = 0;
  fakeAgents = [];
  writtenAgents = [];
  deletedAgentFiles = [];
  fakeUsage = [];
  dashboardRecorded = [];
  fakeNow = new Date("2026-09-21T12:00:00Z").getTime();
  syncedFlag = true;
  fakeLogLines = ["[2026-09-21T12:00:00.000Z] proxy dinliyor: http://127.0.0.1:8787"];
  testModelResponse = { ok: true, text: "merhaba", latencyMs: 42, promptTokens: 5, completionTokens: 2, cost: 0.0001 };
  stopCalls = 0;
  restartCalls = 0;
  requestedLogLines = [];

  // agentDiscovery resolves the *user* scope through CLAUDE_CONFIG_DIR and the
  // *project* scope through process.cwd(); CLAUDE_CONFIG_DIR is the lever that
  // keeps GET/POST /dashboard/api/agents/* off the machine's real ~/.claude/agents.
  agentsRoot = mkdtempSync(join(tmpdir(), "cor-dashboard-agents-"));
  process.env.CLAUDE_CONFIG_DIR = agentsRoot;

  resetAlertState();
  resetMetrics();
  upstreamAnswers = {};
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(keyDir, { recursive: true, force: true });
  rmSync(agentsRoot, { recursive: true, force: true });
  if (originalKeyDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalKeyDir;
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  if (originalEnvKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalEnvKey;
  globalThis.fetch = originalFetch;
});

async function getJson(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${proxyUrl}${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${proxyUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("GET /dashboard", () => {
  it("serves the page as HTML", async () => {
    const response = await fetch(`${proxyUrl}/dashboard`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

describe("GET /dashboard/api/status", () => {
  it("reports the resolved paths and counts", async () => {
    models = [{ id: "openai/gpt-5" }];
    fakeAgents = [
      { name: "a", file: "x", scope: "project", configured: true, claudeModel: false },
    ];

    const { status, body } = await getJson("/dashboard/api/status");
    expect(status).toBe(200);
    expect(body).toMatchObject({ modelCount: 1, agentCount: 1, keySource: "config" });
    expect(typeof body.cwd).toBe("string");
    expect(typeof body.configPath).toBe("string");
  });

  it("reports keySource 'file' when the key lives in the separate key file", async () => {
    hasKey = false;
    saveKey("sk-or-from-file");

    const { body } = await getJson("/dashboard/api/status");
    expect(body.keySource).toBe("file");
  });
});

describe("GET /dashboard/api/credit", () => {
  it("maps the real nested OpenRouter /key response", async () => {
    const { status, body } = await getJson("/dashboard/api/credit");
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      label: "sk-or-...test",
      usage: 1.5,
      limit: 10,
      limitRemaining: 8.5,
      limitReset: null,
      isFreeTier: false,
      usageDaily: 0.1,
      usageWeekly: 0.5,
      usageMonthly: 1.5,
      rateLimit: { interval: "10s", requests: -1 },
    });
  });

  it("reports invalid_key on a 401, still with HTTP 200", async () => {
    keyResponse = () => ({ status: 401, body: { error: { message: "User not found", code: 401 } } });

    const { status, body } = await getJson("/dashboard/api/credit");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, reason: "invalid_key" });
  });

  it("reports no_key without calling OpenRouter at all", async () => {
    hasKey = false;
    const { body } = await getJson("/dashboard/api/credit");
    expect(body).toMatchObject({ ok: false, reason: "no_key" });
  });
});

describe("GET /dashboard/api/usage", () => {
  it("aggregates the injected usage log", async () => {
    fakeUsage = [
      { ts: fakeNow, model: "a", promptTokens: 10, completionTokens: 5, cost: 0.02, stream: true },
    ];

    const { body } = await getJson("/dashboard/api/usage?days=3&recent=5");
    expect(body).toMatchObject({ totals: { requests: 1, cost: 0.02 } });
    expect((body.daily as unknown[]).length).toBe(3);
  });
});

describe("GET /dashboard/api/metrics-summary", () => {
  it("serves the live metrics counters as JSON", async () => {
    resetMetrics();
    try {
      recordRequest({ model: "openai/gpt-5", outcome: "ok", durationSeconds: 1 });
      recordRequest({ model: "openai/gpt-5", outcome: "upstream_error", durationSeconds: 1 });

      const response = await fetch(`${proxyUrl}/dashboard/api/metrics-summary`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as MetricsSummary;
      expect(body.models[0]?.model).toBe("openai/gpt-5");
      expect(body.models[0]?.total).toBe(2);
      expect(body.totals).toEqual({ ok: 1, errors: 1, total: 2, successRate: 0.5, errorRate1h: 0.5 });
    } finally {
      resetMetrics();
    }
  });
});

describe("model management", () => {
  it("adds, lists, updates and removes a model end to end", async () => {
    const add = await postJson("/dashboard/api/models/add", { id: "openai/gpt-5" });
    expect(add.status).toBe(200);
    expect(add.body.model).toMatchObject({ id: "openai/gpt-5", label: "GPT-5" });
    expect(savedConfigs).toHaveLength(1);

    const listed = await getJson("/dashboard/api/models");
    expect((listed.body.models as ModelEntry[])[0]?.id).toBe("openai/gpt-5");

    const updated = await postJson("/dashboard/api/models/update", {
      id: "openai/gpt-5",
      patch: { reasoning: "high" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.model).toMatchObject({ reasoning: "high" });

    const removed = await postJson("/dashboard/api/models/remove", { id: "openai/gpt-5" });
    expect(removed.body).toEqual({ removed: true });

    const listedAfter = await getJson("/dashboard/api/models");
    expect(listedAfter.body.models).toEqual([]);
  });

  it("rejects an invalid reasoning value with 400 and never saves", async () => {
    const { status, body } = await postJson("/dashboard/api/models/add", {
      id: "openai/gpt-5",
      reasoning: "ultra",
    });
    expect(status).toBe(400);
    expect(body.error).toContain("Gecersiz reasoning");
    expect(savedConfigs).toHaveLength(0);
  });

  it("400s an update for a model that isn't configured", async () => {
    const { status } = await postJson("/dashboard/api/models/update", { id: "missing", patch: {} });
    expect(status).toBe(400);
  });
});

describe("POST /dashboard/api/sync", () => {
  it("writes the model picker by default", async () => {
    models = [{ id: "openai/gpt-5" }];
    const { body } = await postJson("/dashboard/api/sync", {});
    expect(syncCalls).toEqual([[{ id: "openai/gpt-5" }]]);
    expect(body).toMatchObject({ path: "/fake/settings.json" });
  });

  it("reverts instead when asked", async () => {
    await postJson("/dashboard/api/sync", { revert: true });
    expect(revertCalls).toBe(1);
    expect(syncCalls).toHaveLength(0);
  });
});

describe("GET /dashboard/api/catalog", () => {
  it("searches the upstream catalog", async () => {
    const { body } = await getJson("/dashboard/api/catalog?q=gpt");
    expect(body.results).toEqual([
      expect.objectContaining({ id: "openai/gpt-5", name: "GPT-5" }),
    ]);
  });

  it("returns no results for an empty query without calling upstream", async () => {
    const { body } = await getJson("/dashboard/api/catalog?q=");
    expect(body).toEqual({ results: [] });
  });
});

describe("GET /dashboard/api/providers", () => {
  it("lists providers for a model whose id contains a slash", async () => {
    const { body } = await getJson("/dashboard/api/providers?id=openai/gpt-5");
    expect(body.providers).toEqual([
      expect.objectContaining({ providerName: "Test", promptPrice: 1, completionPrice: 2 }),
    ]);
  });
});

describe("agents", () => {
  it("lists agents with the resolved directories", async () => {
    fakeAgents = [{ name: "a", file: "x", scope: "user", configured: false, claudeModel: true }];
    const { body } = await getJson("/dashboard/api/agents");
    expect(body.agents).toEqual(fakeAgents);
    expect(typeof body.projectDir).toBe("string");
    expect(typeof body.userDir).toBe("string");
  });

  it("creates an agent via writeAgent", async () => {
    const { status, body } = await postJson("/dashboard/api/agents/create", {
      name: "kodcu",
      modelId: "openai/gpt-5",
      scope: "project",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ overwritten: false });
    expect(writtenAgents).toEqual([{ name: "kodcu", modelId: "openai/gpt-5", scope: "project" }]);
  });
});

describe("GET /dashboard/api/status", () => {
  it("reports whether the model picker is synced", async () => {
    syncedFlag = false;
    const { body } = await getJson("/dashboard/api/status");
    expect(body.synced).toBe(false);
  });
});

describe("GET /dashboard/api/health", () => {
  it("reports every check ok when everything is fine", async () => {
    models = [{ id: "openai/gpt-5" }];
    syncedFlag = true;

    const { status, body } = await getJson("/dashboard/api/health");
    expect(status).toBe(200);
    const checks = body.checks as { id: string; ok: boolean }[];
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.map((check) => check.id).sort()).toEqual([
      "credit",
      "free_quota",
      "key",
      "model_config",
      "models",
      "synced",
    ]);
  });

  it("flags the relevant checks as failing", async () => {
    models = [];
    hasKey = false;
    syncedFlag = false;

    const { body } = await getJson("/dashboard/api/health");
    const checks = body.checks as { id: string; ok: boolean; hint?: string }[];
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
    expect(byId.key?.ok).toBe(false);
    expect(byId.models?.ok).toBe(false);
    expect(byId.synced?.ok).toBe(false);
    expect(byId.credit?.ok).toBe(false);
    expect(byId.key?.hint).toBeTruthy();
  });

  it("flags model_config as failing for an invalid stored model entry", async () => {
    models = [{ id: "openai/gpt-5", quantizations: ["fp8 bf16 fp16"] }];
    syncedFlag = true;

    const { body } = await getJson("/dashboard/api/health");
    const checks = body.checks as { id: string; ok: boolean; hint?: string }[];
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
    expect(byId.model_config?.ok).toBe(false);
    expect(byId.model_config?.hint).toMatch(/openai\/gpt-5/);
  });

  it("includes free_tier_ checks for models with priceDrift detected", async () => {
    models = [
      { id: "openai/gpt-5", label: "GPT-5" },
      { id: "free/model", label: "Free Model", wasFree: true },
    ];
    syncedFlag = true;

    // Stub catalog to return paid prices for the free model
    stubCatalogFetch([
      { id: "openai/gpt-5", name: "GPT-5", context_length: 400000, pricing: { prompt: "0.0000015", completion: "0.000006" } },
      { id: "free/model", name: "Free Model", context_length: 8000, pricing: { prompt: "0.0000015", completion: "0.000006" } },
    ]);

    const { status, body } = await getJson("/dashboard/api/health");
    expect(status).toBe(200);
    const checks = body.checks as { id: string; ok: boolean; hint?: string }[];
    const freeTierChecks = checks.filter((c) => c.id.startsWith("free_tier_"));
    expect(freeTierChecks).toHaveLength(1);
    expect(freeTierChecks[0]?.id).toBe("free_tier_free/model");
    expect(freeTierChecks[0]?.ok).toBe(false);
    expect(freeTierChecks[0]?.hint).toContain("$1.5/M girdi");
    expect(freeTierChecks[0]?.hint).toContain("$6/M cikti");
    // Config should have been saved (priceDrift written)
    expect(savedConfigs).toHaveLength(1);
  });

  it("does not include free_tier_ check when model is still free in catalog", async () => {
    models = [{ id: "free/model", label: "Free Model", wasFree: true }];
    syncedFlag = true;

    // Stub catalog to return free prices
    stubCatalogFetch([
      { id: "free/model", name: "Free Model", context_length: 8000, pricing: { prompt: "0", completion: "0" } },
    ]);

    const { body } = await getJson("/dashboard/api/health");
    const checks = body.checks as { id: string; ok: boolean }[];
    const freeTierChecks = checks.filter((c) => c.id.startsWith("free_tier_"));
    expect(freeTierChecks).toHaveLength(0);
    // Config should NOT have been saved (no drift detected)
    expect(savedConfigs).toHaveLength(0);
  });

  it("does not include free_tier_ check for wasFree:false model", async () => {
    models = [{ id: "paid/model", label: "Paid Model", wasFree: false }];
    syncedFlag = true;

    stubCatalogFetch([
      { id: "paid/model", name: "Paid Model", context_length: 8000, pricing: { prompt: "0.0000015", completion: "0.000006" } },
    ]);

    const { body } = await getJson("/dashboard/api/health");
    const checks = body.checks as { id: string; ok: boolean }[];
    const freeTierChecks = checks.filter((c) => c.id.startsWith("free_tier_"));
    expect(freeTierChecks).toHaveLength(0);
  });
});

describe("GET /dashboard/api/logs", () => {
  it("returns the injected tail", async () => {
    fakeLogLines = ["birinci satir", "ikinci satir"];
    const { body } = await getJson("/dashboard/api/logs?lines=50");
    expect(body).toEqual({ lines: fakeLogLines });
  });

  it("caps an absurd line count before it reaches tailLog", async () => {
    const { status } = await getJson("/dashboard/api/logs?lines=999999");
    expect(status).toBe(200);
    expect(requestedLogLines).toEqual([2000]);
  });
});

describe("GET /dashboard/api/export", () => {
  it("serves the model list as a downloadable JSON file", async () => {
    models = [{ id: "openai/gpt-5", label: "GPT-5" }];
    const response = await fetch(`${proxyUrl}/dashboard/api/export`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.json()).toEqual({ models });
  });
});

describe("POST /dashboard/api/models/test", () => {
  it("runs the injected test and returns its result", async () => {
    models = [{ id: "openai/gpt-5" }];
    testModelResponse = {
      ok: true,
      text: "merhaba dunya",
      latencyMs: 120,
      promptTokens: 10,
      completionTokens: 4,
      cost: 0.0003,
    };

    const { status, body } = await postJson("/dashboard/api/models/test", { id: "openai/gpt-5" });
    expect(status).toBe(200);
    expect(body).toEqual(testModelResponse);
  });

  it("400s for a model that isn't configured", async () => {
    const { status } = await postJson("/dashboard/api/models/test", { id: "missing" });
    expect(status).toBe(400);
  });

  it("passes the dashboard's own recordUsage through to the test call", async () => {
    models = [{ id: "openai/gpt-5" }];
    await postJson("/dashboard/api/models/test", { id: "openai/gpt-5" });
    expect(dashboardRecorded).toEqual([
      { model: "openai/gpt-5", promptTokens: 1, completionTokens: 1, cost: 0, stream: false },
    ]);
  });
});

describe("POST /dashboard/api/agents/delete", () => {
  it("deletes the given file", async () => {
    const { status, body } = await postJson("/dashboard/api/agents/delete", {
      file: "/fake/.claude/agents/kodcu.md",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ deleted: true });
    expect(deletedAgentFiles).toEqual(["/fake/.claude/agents/kodcu.md"]);
  });

  it("400s when no file is given", async () => {
    const { status } = await postJson("/dashboard/api/agents/delete", {});
    expect(status).toBe(400);
  });
});

describe("proxy control", () => {
  it("responds to a stop request and then calls stopProcess", async () => {
    const response = await fetch(`${proxyUrl}/dashboard/api/proxy/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopping: true });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stopCalls).toBe(1);
  });

  it("responds to a restart request and then calls restartProcess", async () => {
    const response = await fetch(`${proxyUrl}/dashboard/api/proxy/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restarting: true });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(restartCalls).toBe(1);
  });
});

describe("local-only guard", () => {
  it("rejects a mutating request whose Origin doesn't match the dashboard", async () => {
    const { status, body } = await postJson(
      "/dashboard/api/models/add",
      { id: "openai/gpt-5" },
      { origin: "https://evil.example" },
    );
    expect(status).toBe(403);
    expect(body.error).toBeTruthy();
    expect(savedConfigs).toHaveLength(0);
  });

  it("rejects a mutating request that dodges the JSON content-type", async () => {
    const response = await fetch(`${proxyUrl}/dashboard/api/models/add`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ id: "openai/gpt-5" }),
    });
    expect(response.status).toBe(403);
    expect(savedConfigs).toHaveLength(0);
  });

  it("allows a mutating request with no Origin header at all (curl, cor itself)", async () => {
    const { status } = await postJson("/dashboard/api/sync", {});
    expect(status).toBe(200);
  });
});

describe("/dashboard/api/settings", () => {
  it("GET serves the stored budget and alerts", async () => {
    const { status, body } = await getJson("/dashboard/api/settings");
    expect(status).toBe(200);
    // JSON.stringify drops undefined values, so an unconfigured section simply
    // isn't in the payload — which is what the dashboard's `|| {}` handles.
    expect(body).toEqual({});
  });

  it("GET serves both sections as configured", async () => {
    budget = { dailyUsd: 5, action: "block" };
    alerts = { errorRatePct: 10 };

    const { status, body } = await getJson("/dashboard/api/settings");
    expect(status).toBe(200);
    expect(body).toEqual({
      budget: { dailyUsd: 5, monthlyUsd: undefined, action: "block" },
      alerts: { errorRatePct: 10, latencyP95Seconds: undefined, windowMinutes: undefined, webhookUrl: undefined },
    });
  });

  it("POST stores a valid budget through saveConfig and echoes it back", async () => {
    const { status, body } = await postJson("/dashboard/api/settings", {
      budget: { dailyUsd: 5, monthlyUsd: 50, action: "block" },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ budget: { dailyUsd: 5, monthlyUsd: 50, action: "block" }, alerts: undefined });
    expect(savedConfigs).toHaveLength(1);
    expect(savedConfigs[0]?.budget).toEqual({ dailyUsd: 5, monthlyUsd: 50, action: "block" });
  });

  it("POST stores a valid alerts section", async () => {
    const { status, body } = await postJson("/dashboard/api/settings", {
      alerts: { errorRatePct: 10, latencyP95Seconds: 30, windowMinutes: 60, webhookUrl: "https://hook.example/x" },
    });

    expect(status).toBe(200);
    expect(body.alerts).toEqual({
      errorRatePct: 10,
      latencyP95Seconds: 30,
      windowMinutes: 60,
      webhookUrl: "https://hook.example/x",
    });
    expect(savedConfigs[0]?.alerts?.errorRatePct).toBe(10);
  });

  it("POST 400s an invalid budget action and never saves", async () => {
    const { status, body } = await postJson("/dashboard/api/settings", {
      budget: { action: "yok" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("Gecersiz budget action");
    expect(savedConfigs).toHaveLength(0);
  });

  it("POST 400s a negative number and a non-http webhook", async () => {
    const negative = await postJson("/dashboard/api/settings", { budget: { dailyUsd: -1 } });
    expect(negative.status).toBe(400);
    expect(negative.body.error).toContain("budget.dailyUsd");

    const webhook = await postJson("/dashboard/api/settings", {
      alerts: { webhookUrl: "not-a-url" },
    });
    expect(webhook.status).toBe(400);
    expect(webhook.body.error).toContain("alerts.webhookUrl");

    expect(savedConfigs).toHaveLength(0);
  });
});

describe("GET /dashboard/api/budget", () => {
  it("spends today and this month against no caps configured", async () => {
    fakeUsage = [
      { ts: fakeNow, model: "a", promptTokens: 10, completionTokens: 5, cost: 3, stream: true },
      { ts: fakeNow - 40 * 24 * 3600_000, model: "a", promptTokens: 1, completionTokens: 1, cost: 40, stream: true },
    ];

    const { status, body } = await getJson("/dashboard/api/budget");

    expect(status).toBe(200);
    expect(body).toMatchObject({ todayUsd: 3, monthUsd: 3, level: "ok", exceeded: false });
    // Unset caps are dropped by JSON.stringify rather than sent as null.
    expect(Object.keys(body).sort()).toEqual(["exceeded", "level", "monthUsd", "todayUsd"]);
  });

  it("reads a cap the config already carries and warns at 80% of it", async () => {
    budget = { dailyUsd: 4, action: "warn" };
    fakeUsage = [{ ts: fakeNow, model: "a", promptTokens: 1, completionTokens: 1, cost: 3.5, stream: false }];

    const { body } = await getJson("/dashboard/api/budget");
    expect(body).toMatchObject({ todayUsd: 3.5, monthUsd: 3.5, dailyUsd: 4, level: "warn", exceeded: false });
  });

  it("reports level over and exceeded once the spend passes the cap", async () => {
    budget = { dailyUsd: 4, action: "block" };
    fakeUsage = [{ ts: fakeNow, model: "a", promptTokens: 1, completionTokens: 1, cost: 9, stream: false }];

    const { body } = await getJson("/dashboard/api/budget");
    expect(body).toMatchObject({ todayUsd: 9, level: "over", exceeded: true });
  });

  it("counts an earlier day of the same month toward monthUsd but not todayUsd", async () => {
    // fakeNow is 2026-09-21, so 10 days back is still September.
    fakeUsage = [
      { ts: fakeNow, model: "a", promptTokens: 10, completionTokens: 5, cost: 3, stream: true },
      { ts: fakeNow - 10 * 24 * 3600_000, model: "a", promptTokens: 1, completionTokens: 1, cost: 40, stream: true },
    ];

    const { body } = await getJson("/dashboard/api/budget");
    expect(body).toMatchObject({ todayUsd: 3, monthUsd: 43 });
  });

  it("ignores a record from a previous month in both windows", async () => {
    // 40 days before 2026-09-21 is in August: neither today nor this month.
    fakeUsage = [
      { ts: fakeNow, model: "a", promptTokens: 10, completionTokens: 5, cost: 3, stream: true },
      { ts: fakeNow - 40 * 24 * 3600_000, model: "a", promptTokens: 1, completionTokens: 1, cost: 40, stream: true },
    ];

    const { body } = await getJson("/dashboard/api/budget");
    expect(body).toMatchObject({ todayUsd: 3, monthUsd: 3, level: "ok" });
  });

  it("counts a record with no cost figure as zero rather than dropping it", async () => {
    // A real usage log writes cost: null when the upstream omitted it.
    fakeUsage = [
      { ts: fakeNow, model: "a", promptTokens: 1, completionTokens: 1, cost: null, stream: false },
      { ts: fakeNow, model: "b", promptTokens: 1, completionTokens: 1, cost: 2, stream: false },
    ];

    const { body } = await getJson("/dashboard/api/budget");
    expect(body).toMatchObject({ todayUsd: 2, monthUsd: 2 });
  });
});

describe("GET /dashboard/api/alerts", () => {
  it("serves the alert state as JSON with all three fields", async () => {
    const { status, body } = await getJson("/dashboard/api/alerts");
    expect(status).toBe(200);
    expect(body).toEqual({ lastFiredAt: null, lastReason: null, lastError: null });
  });
});

describe("GET /dashboard/api/metrics-recent", () => {
  it("serves recent requests, errors, the timeline and the 1h error rate", async () => {
    try {
      recordRequest({ model: "openai/gpt-5", outcome: "ok", durationSeconds: 1 });
      recordRequest({ model: "openai/gpt-5", outcome: "upstream_error", durationSeconds: 2, error: "500" });

      const { status, body } = await getJson("/dashboard/api/metrics-recent");

      expect(status).toBe(200);
      expect(body).toHaveProperty("recent");
      expect(body).toHaveProperty("errors");
      expect(body).toHaveProperty("timeline");
      expect(body).toHaveProperty("errorRate1h");

      const recent = body.recent as { model: string; outcome: string }[];
      expect(recent.map((entry) => entry.outcome)).toEqual(["upstream_error", "ok"]);

      const errors = body.errors as { model: string; error?: string }[];
      expect(errors).toHaveLength(1);
      expect(errors[0]?.error).toBe("500");

      const timeline = body.timeline as { model: string; count: number; errors: number }[];
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({ model: "openai/gpt-5", count: 2, errors: 1 });

      expect(body.errorRate1h).toBe(0.5);
    } finally {
      resetMetrics();
    }
  });

  it("reports a null error rate and empty collections when nothing was requested", async () => {
    resetMetrics();
    const { body } = await getJson("/dashboard/api/metrics-recent");
    expect(body).toEqual({ recent: [], errors: [], timeline: [], errorRate1h: null });
  });
});

describe("config history", () => {
  it("GET lists the snapshots, newest first", async () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 9000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    saveConfig({ ...DEFAULT_CONFIG, port: 9001, models: [{ id: "a" }] });

    const { status, body } = await getJson("/dashboard/api/config/history");

    expect(status).toBe(200);
    const history = body.history as { file: string; models: number; size: number; savedAt: string }[];
    expect(history).toHaveLength(1);
    // The single snapshot is the port 9000 config; port 9001 is still live.
    expect(history[0]).toMatchObject({ models: 0 });
    expect(history[0]?.size).toBeGreaterThan(0);
    expect(history[0]?.file).toMatch(/\.json$/);
    expect(history[0]?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.\d{3}Z$/);
    expect(history[0]?.file).toBe(listConfigHistory()[0]?.file);
  });

  it("counts the models in each snapshot", async () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 9000, models: [{ id: "ilk" }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    saveConfig({ ...DEFAULT_CONFIG, port: 9001, models: [{ id: "a" }, { id: "b" }] });

    const { body } = await getJson("/dashboard/api/config/history");
    const history = body.history as { models: number }[];
    expect(history).toHaveLength(1);
    expect(history[0]?.models).toBe(1);
  });

  it("POST 400s a name that isn't a plain .json history entry", async () => {
    for (const file of ["../config.json", "a/b.json", "config.json.tmp", ""]) {
      const { status } = await postJson("/dashboard/api/config/restore", { file });
      expect(status).toBe(400);
    }
    const missing = await postJson("/dashboard/api/config/restore", {
      file: "2020-01-01T00-00-00.000Z.json",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("Config gecmisi bulunamadi");
  });

  it("POST 400s when no file is given at all", async () => {
    const { status, body } = await postJson("/dashboard/api/config/restore", {});
    expect(status).toBe(400);
    expect(body.error).toBe("file zorunlu.");
  });

  it("POST updates the live config object in place for a valid snapshot", async () => {
    saveConfig({ ...DEFAULT_CONFIG, port: 9000, models: [{ id: "ilk" }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    saveConfig({ ...DEFAULT_CONFIG, port: 9001, models: [{ id: "ikinci" }] });
    const oldest = listConfigHistory()[0]?.file ?? "";

    const { status, body } = await postJson("/dashboard/api/config/restore", { file: oldest });

    expect(status).toBe(200);
    expect(body).toEqual({ restored: true, models: 1 });
    // Object.assign, not a rebind: the snapshot's models land in the very object
    // the proxy still holds, instead of a copy only the response can see.
    expect(currentConfig.models).toEqual([{ id: "ilk" }]);
    expect(currentConfig.port).toBe(9000);
    expect(currentConfig.budget).toBeUndefined();
  });
});

describe("POST /dashboard/api/models/compare", () => {
  it("400s a single id", async () => {
    models = [{ id: "openai/gpt-5" }];
    const { status, body } = await postJson("/dashboard/api/models/compare", {
      ids: ["openai/gpt-5"],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("2 ile 4");
  });

  it("400s an id that isn't in the config", async () => {
    models = [{ id: "openai/gpt-5" }];
    const { status, body } = await postJson("/dashboard/api/models/compare", {
      ids: ["openai/gpt-5", "yok/olmayan"],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("yok/olmayan");
  });

  it("400s a non-string id", async () => {
    models = [{ id: "openai/gpt-5" }];
    const { status } = await postJson("/dashboard/api/models/compare", {
      ids: ["openai/gpt-5", 7],
    });
    expect(status).toBe(400);
  });

  it("400s more than four ids", async () => {
    models = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
    const { status } = await postJson("/dashboard/api/models/compare", {
      ids: ["a", "b", "c", "d", "e"],
    });
    expect(status).toBe(400);
  });

  it("runs the two configured models and returns a result per model", async () => {
    models = [{ id: "openai/gpt-5" }, { id: "qwen/qwen3-max" }];
    // compareModels resolves the key the same way fetchCreditInfo does, so an
    // ambient env key would send it to the loopback; supply one explicitly.
    const openAiUrl = `${upstreamUrl}${baseUrlSuffix}/chat/completions`;
    upstreamAnswers[openAiUrl] = {
      status: 200,
      body: {
        id: "gen-1",
        choices: [{ message: { content: "Merhaba!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.0002 },
      },
    };

    const { status, body } = await withEnvApiKey("sk-or-test", async () =>
      postJson("/dashboard/api/models/compare", {
        ids: ["openai/gpt-5", "qwen/qwen3-max"],
        prompt: "tek kelime",
      }),
    );

    expect(status).toBe(200);
    const results = body.results as { model: string; result: TestModelResult }[];
    expect(results.map((entry) => entry.model)).toEqual(["openai/gpt-5", "qwen/qwen3-max"]);
    for (const entry of results) {
      expect(entry.result).toMatchObject({
        ok: true,
        text: "Merhaba!",
        promptTokens: 12,
        completionTokens: 4,
      });
    }
    // Both calls go through the dashboard's own usage recorder.
    expect(dashboardRecorded.map((entry) => entry.model).sort()).toEqual([
      "openai/gpt-5",
      "qwen/qwen3-max",
    ]);
  });
});

describe("GET /dashboard/api/agents/get", () => {
  it("400s when no file is given", async () => {
    const { status, body } = await getJson("/dashboard/api/agents/get");
    expect(status).toBe(400);
    expect(body.error).toBe("file gerekli.");
  });

  it("400s a file that doesn't exist", async () => {
    const { status, body } = await getJson(
      `/dashboard/api/agents/get?file=${encodeURIComponent(
        join(agentsRoot, "agents", "yok.md"),
      )}`,
    );
    expect(status).toBe(400);
    expect(body.error).toContain("Dosya bulunamadi");
  });

  it("serves the frontmatter and body of a real agent file in the temp dir", async () => {
    mkdirSync(join(agentsRoot, "agents"), { recursive: true });
    const file = join(agentsRoot, "agents", "kodcu.md");
    writeFileSync(file, renderAgent({ name: "kodcu", modelId: "openai/gpt-5", scope: "user" }));

    const { status, body } = await getJson(
      `/dashboard/api/agents/get?file=${encodeURIComponent(file)}`,
    );

    expect(status).toBe(200);
    const agent = body.agent as { file: string; name: string; model: string; tools: string; body: string };
    expect(agent.file).toBe(file);
    expect(agent.name).toBe("kodcu");
    expect(agent.model).toBe("openai/gpt-5");
    expect(agent.tools).toBe("Read, Edit, Write");
    expect(agent.body).toContain("Sen openai/gpt-5 uzerinde calisan bir uygulayicisin.");
  });

  it("400s a path outside the known agents directories", async () => {
    const outside = join(agentsRoot, "disarida.md");
    writeFileSync(outside, "---\nname: x\n---\nbody\n");

    const { status, body } = await getJson(
      `/dashboard/api/agents/get?file=${encodeURIComponent(outside)}`,
    );
    expect(status).toBe(400);
    expect(body.error).toContain("duzenlenemez");
  });
});

describe("POST /dashboard/api/agents/update", () => {
  it("400s when no file is given", async () => {
    const { status, body } = await postJson("/dashboard/api/agents/update", { model: "x" });
    expect(status).toBe(400);
    expect(body.error).toBe("file zorunlu.");
  });

  it("400s a file that doesn't exist", async () => {
    const { status, body } = await postJson("/dashboard/api/agents/update", {
      file: join(agentsRoot, "agents", "yok.md"),
    });
    expect(status).toBe(400);
    expect(body.error).toContain("Dosya bulunamadi");
  });

  it("400s a path outside the known agents directories", async () => {
    const outside = join(agentsRoot, "disarida.md");
    writeFileSync(outside, "---\nname: x\n---\nbody\n");

    const { status } = await postJson("/dashboard/api/agents/update", {
      file: outside,
      model: "openai/gpt-5",
    });
    expect(status).toBe(400);
    expect(readFileText(outside)).toContain("name: x");
  });
});

describe("GET /dashboard/api/catalog free tier", () => {
  // OpenRouter prices per token as strings; the API reports dollars per million.
  const free = { pricing: { prompt: "0", completion: "0" } };
  const paid = { pricing: { prompt: "0.0000015", completion: "0.000006" } };

  it("keeps only the models priced at $0 on both sides, with per-million prices", async () => {
    stubCatalogFetch([
      { id: "a/free-model", name: "Free model", context_length: 8000, ...free },
      { id: "z/free-model", name: "Free model", context_length: 8000, ...free },
      { id: "openai/gpt-5-free", name: "GPT-5", context_length: 400000, ...paid },
      { id: "free-model-2", name: "Free model 2", context_length: 8000, ...free },
    ]);

    const { status, body } = await getJson("/dashboard/api/catalog?q=free&free=1");

    expect(status).toBe(200);
    const results = body.results as { id: string; promptPrice: number; completionPrice: number }[];
    expect(results.map((entry) => entry.id)).toEqual(["a/free-model", "z/free-model", "free-model-2"]);
    for (const entry of results) expect(entry).toMatchObject({ promptPrice: 0, completionPrice: 0 });
  });

  it("does not count a free prompt billed on output, or an unpriced entry, as free", async () => {
    stubCatalogFetch([
      { id: "a/free-model", name: "Free model", ...free },
      { id: "b/free-output-billed", name: "Free-ish", pricing: { prompt: "0", completion: "0.000001" } },
      { id: "c/free-unpriced", name: "No pricing" },
    ]);

    const { body } = await getJson("/dashboard/api/catalog?q=free&free=1");
    expect((body.results as { id: string }[]).map((entry) => entry.id)).toEqual(["a/free-model"]);
  });

  it("browses the whole tier, not a search, when only the free flag is set", async () => {
    stubCatalogFetch([
      { id: "a/free-model", name: "Free model", ...free },
      { id: "openai/gpt-5", name: "GPT-5", ...paid },
      { id: "z/free-model", name: "Free model", ...free },
    ]);

    // An empty q with free=1 is the free-tier browser: no id matching, and an
    // empty list would wrongly tell the user there is nothing to pick.
    const { body } = await getJson("/dashboard/api/catalog?q=&free=1");
    expect((body.results as { id: string }[]).map((entry) => entry.id)).toEqual(["a/free-model", "z/free-model"]);
  });

  it("attaches real per-million prices, or null when unpriced, without free=1", async () => {
    stubCatalogFetch([
      { id: "openai/gpt-5", name: "GPT-5", context_length: 400000, ...paid },
      { id: "openai/gpt-5-unpriced", name: "GPT-5 (no price)" },
    ]);

    const { body } = await getJson("/dashboard/api/catalog?q=gpt");
    const results = body.results as { id: string; promptPrice: number | null; completionPrice: number | null }[];
    expect(results.map((entry) => entry.id)).toEqual(["openai/gpt-5", "openai/gpt-5-unpriced"]);
    expect(results[0]).toMatchObject({ promptPrice: 1.5, completionPrice: 6 });
    expect(results[1]).toMatchObject({ promptPrice: null, completionPrice: null });
  });

  it("caches the catalog per base url, so a second query doesn't refetch", async () => {
    stubCatalogFetch([{ id: "a/free-model", name: "Free model", context_length: 8000, ...free }]);
    await getJson("/dashboard/api/catalog?q=free&free=1");

    upstreamAnswers[`${upstreamUrl}${baseUrlSuffix}/models`] = {
      status: 500,
      body: { error: "ikinci istek sunucuya gitmemeliydi" },
    };

    const { status, body } = await getJson("/dashboard/api/catalog?q=free&free=1");
    expect(status).toBe(200);
    expect((body.results as { id: string }[]).map((entry) => entry.id)).toEqual(["a/free-model"]);
  });
});

