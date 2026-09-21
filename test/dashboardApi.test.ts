import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxyServer } from "../src/server/index.js";
import { DEFAULT_CONFIG, type Config, type ModelEntry } from "../src/config.js";
import type { AgentOptions } from "../src/agentTemplate.js";
import type { AgentSummary } from "../src/agentDiscovery.js";
import type { UsageRecord } from "../src/usageLog.js";

let upstream: Server;
let proxy: Server;
let upstreamUrl: string;
let proxyUrl: string;

let models: ModelEntry[];
let hasKey: boolean;
let keyResponse: () => { status: number; body: unknown };
let savedConfigs: Config[];
let syncCalls: ModelEntry[][];
let revertCalls: number;
let fakeAgents: AgentSummary[];
let writtenAgents: { name: string; modelId: string; scope: AgentOptions["scope"] }[];
let fakeUsage: UsageRecord[];
let fakeNow: number;

function config(): Config {
  return {
    ...DEFAULT_CONFIG,
    openrouterApiKey: hasKey ? "sk-or-test" : undefined,
    openrouterBaseUrl: `${upstreamUrl}/api/v1`,
    anthropicBaseUrl: upstreamUrl,
    models,
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
    loadConfig: config,
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

beforeEach(() => {
  models = [];
  hasKey = true;
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
  fakeUsage = [];
  fakeNow = new Date("2026-09-21T12:00:00Z").getTime();
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
