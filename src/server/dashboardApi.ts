import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentOptions } from "../agentTemplate.js";
import { agentsDir } from "../agentTemplate.js";
import { listAgents as listAgentsImpl, type AgentSummary } from "../agentDiscovery.js";
import { writeAgent as writeAgentImpl } from "../agentTemplate.js";
import {
  configPath,
  findModel,
  resolveOpenRouterKey,
  saveConfig as saveConfigImpl,
  type Config,
  type ModelEntry,
} from "../config.js";
import {
  revertModelPicker as revertModelPickerImpl,
  syncModelPicker as syncModelPickerImpl,
} from "../claudeSettings.js";
import { fetchCatalog, fetchEndpoints, searchCatalog } from "../openrouterCatalog.js";
import { addModel, ModelOpError, removeModel, updateModel, type ModelInput } from "../modelOps.js";
import {
  aggregateUsage,
  readUsage as readUsageImpl,
  type UsageRecord,
} from "../usageLog.js";
import { readBody, sendJson } from "./http.js";

export interface DashboardDeps {
  saveConfig: (config: Config) => void;
  readUsage: () => UsageRecord[];
  syncModelPicker: (models: ModelEntry[]) => { path: string; removed: boolean };
  revertModelPicker: () => { path: string; restored: boolean };
  listAgents: (config: Config) => AgentSummary[];
  writeAgent: (options: AgentOptions) => { path: string; overwritten: boolean };
  now: () => number;
}

export function defaultDashboardDeps(): DashboardDeps {
  return {
    saveConfig: saveConfigImpl,
    readUsage: readUsageImpl,
    syncModelPicker: syncModelPickerImpl,
    revertModelPicker: revertModelPickerImpl,
    listAgents: listAgentsImpl,
    writeAgent: writeAgentImpl,
    now: () => Date.now(),
  };
}

function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/**
 * Blocks two things a read-only proxy never had to worry about: DNS
 * rebinding (a hostname that resolves to 127.0.0.1 but isn't literally
 * "localhost") and a CSRF-style POST from any tab the user has open, which
 * could otherwise add/remove models or write a `.claude/agents/*.md` file
 * Claude Code would then load. No login — just host/origin/content-type
 * checks, since this is a single-user local tool.
 */
function guardDashboardRequest(req: IncomingMessage): string | undefined {
  if (!isLocalHost(req.headers.host)) {
    return "Bu istek sadece localhost'tan kabul edilir.";
  }

  if (req.method === "POST") {
    const origin = req.headers.origin;
    if (origin) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      if (originHost !== req.headers.host) {
        return "Origin dashboard ile eslesmiyor.";
      }
    }

    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return "Icerik turu application/json olmali.";
    }
  }

  return undefined;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T | undefined> {
  const body = await readBody(req);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

/** 10 minutes: search-as-you-type must not refetch OpenRouter's full catalog per keystroke. */
const CATALOG_TTL_MS = 10 * 60 * 1000;
let catalogCache: { at: number; baseUrl: string; models: Awaited<ReturnType<typeof fetchCatalog>> } | undefined;

async function getCachedCatalog(config: Config) {
  const now = Date.now();
  if (
    catalogCache &&
    catalogCache.baseUrl === config.openrouterBaseUrl &&
    now - catalogCache.at < CATALOG_TTL_MS
  ) {
    return catalogCache.models;
  }
  const models = await fetchCatalog(config);
  catalogCache = { at: now, baseUrl: config.openrouterBaseUrl, models };
  return models;
}

export type CreditInfo =
  | {
      ok: true;
      label?: string;
      usage: number;
      limit: number | null;
      limitRemaining: number | null;
      limitReset: string | null;
      isFreeTier: boolean;
      usageDaily: number;
      usageWeekly: number;
      usageMonthly: number;
      rateLimit?: { interval: string; requests: number };
    }
  | {
      ok: false;
      status?: number;
      reason: "no_key" | "invalid_key" | "unreachable" | "upstream_error";
      message: string;
    };

/**
 * Always resolves — never throws. The dashboard renders a state from `ok`
 * rather than treating a revoked key as a fetch failure.
 */
export async function fetchCreditInfo(config: Config): Promise<CreditInfo> {
  const apiKey = resolveOpenRouterKey(config);
  if (!apiKey) {
    return {
      ok: false,
      reason: "no_key",
      message: "OpenRouter anahtari yok. `cor key <anahtar>` calistir.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${config.openrouterBaseUrl}/key`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      message: `OpenRouter'a ulasilamadi: ${(err as Error).message}`,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      status: 401,
      reason: "invalid_key",
      message: "OpenRouter anahtari gecersiz veya iptal edilmis. `cor key <anahtar>` ile yenile.",
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      reason: "upstream_error",
      message: `OpenRouter ${response.status} dondu: ${text.slice(0, 200)}`,
    };
  }

  // The real response nests every field under `data` — confirmed live; the
  // publicly summarized docs describe a flat shape that doesn't match.
  const json = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown> };
  const data = json.data ?? {};
  const rateLimit = data.rate_limit as { interval?: unknown; requests?: unknown } | undefined;

  return {
    ok: true,
    label: typeof data.label === "string" ? data.label : undefined,
    usage: Number(data.usage ?? 0),
    limit: typeof data.limit === "number" ? data.limit : null,
    limitRemaining: typeof data.limit_remaining === "number" ? data.limit_remaining : null,
    limitReset: typeof data.limit_reset === "string" ? data.limit_reset : null,
    isFreeTier: Boolean(data.is_free_tier),
    usageDaily: Number(data.usage_daily ?? 0),
    usageWeekly: Number(data.usage_weekly ?? 0),
    usageMonthly: Number(data.usage_monthly ?? 0),
    rateLimit: rateLimit
      ? { interval: String(rateLimit.interval ?? ""), requests: Number(rateLimit.requests ?? -1) }
      : undefined,
  };
}

/** Returns true when this request was for the dashboard and has been handled. */
export async function handleDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  deps: DashboardDeps,
  renderHtml: () => string,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!(path === "/dashboard" || path.startsWith("/dashboard/"))) return false;

  const guardError = guardDashboardRequest(req);
  if (guardError) {
    sendJson(res, 403, { error: guardError });
    return true;
  }

  if (req.method === "GET" && path === "/dashboard") {
    const html = renderHtml();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/status") {
    sendJson(res, 200, {
      port: config.port,
      cwd: process.cwd(),
      configPath: configPath(),
      keySource: process.env.OPENROUTER_API_KEY ? "env" : config.openrouterApiKey ? "config" : "none",
      modelCount: config.models.length,
      agentCount: deps.listAgents(config).length,
    });
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/credit") {
    sendJson(res, 200, await fetchCreditInfo(config));
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/usage") {
    const days = Number(url.searchParams.get("days") ?? "14") || 14;
    const recent = Number(url.searchParams.get("recent") ?? "20") || 20;
    sendJson(res, 200, aggregateUsage(deps.readUsage(), { days, recent, now: deps.now() }));
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/models") {
    sendJson(res, 200, { models: config.models });
    return true;
  }

  if (req.method === "POST" && path === "/dashboard/api/models/add") {
    const body = await readJsonBody<{ id?: string } & ModelInput>(req);
    if (!body?.id) {
      sendJson(res, 400, { error: "id zorunlu." });
      return true;
    }
    try {
      const result = await addModel(config, body.id, body);
      deps.saveConfig(config);
      sendJson(res, 200, {
        model: result.entry,
        catalogStatus: result.status,
        catalogError: result.errorMessage,
      });
    } catch (err) {
      sendJson(res, err instanceof ModelOpError ? 400 : 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/dashboard/api/models/update") {
    const body = await readJsonBody<{ id?: string; patch?: ModelInput }>(req);
    if (!body?.id) {
      sendJson(res, 400, { error: "id zorunlu." });
      return true;
    }
    try {
      const model = updateModel(config, body.id, body.patch ?? {});
      deps.saveConfig(config);
      sendJson(res, 200, { model });
    } catch (err) {
      sendJson(res, err instanceof ModelOpError ? 400 : 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "POST" && path === "/dashboard/api/models/remove") {
    const body = await readJsonBody<{ id?: string }>(req);
    if (!body?.id) {
      sendJson(res, 400, { error: "id zorunlu." });
      return true;
    }
    const removed = removeModel(config, body.id);
    if (removed) deps.saveConfig(config);
    sendJson(res, 200, { removed });
    return true;
  }

  if (req.method === "POST" && path === "/dashboard/api/sync") {
    const body = (await readJsonBody<{ revert?: boolean }>(req)) ?? {};
    sendJson(res, 200, body.revert ? deps.revertModelPicker() : deps.syncModelPicker(config.models));
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/catalog") {
    const q = url.searchParams.get("q") ?? "";
    if (!q.trim()) {
      sendJson(res, 200, { results: [] });
      return true;
    }
    try {
      const catalog = await getCachedCatalog(config);
      sendJson(res, 200, { results: searchCatalog(catalog, q).slice(0, 30) });
    } catch (err) {
      sendJson(res, 502, { error: `Katalog alinamadi: ${(err as Error).message}` });
    }
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/providers") {
    const id = url.searchParams.get("id");
    if (!id) {
      sendJson(res, 400, { error: "id gerekli." });
      return true;
    }
    try {
      sendJson(res, 200, { providers: await fetchEndpoints(config, id) });
    } catch (err) {
      sendJson(res, 502, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === "GET" && path === "/dashboard/api/agents") {
    sendJson(res, 200, {
      agents: deps.listAgents(config),
      projectDir: agentsDir("project"),
      userDir: agentsDir("user"),
    });
    return true;
  }

  if (req.method === "POST" && path === "/dashboard/api/agents/create") {
    const body = await readJsonBody<{ name?: string; modelId?: string; scope?: string }>(req);
    if (!body?.name || !body.modelId) {
      sendJson(res, 400, { error: "name ve modelId zorunlu." });
      return true;
    }
    const scope = body.scope === "user" ? "user" : "project";
    const entry = findModel(config, body.modelId);
    sendJson(
      res,
      200,
      deps.writeAgent({ name: body.name, modelId: body.modelId, scope, label: entry?.label }),
    );
    return true;
  }

  sendJson(res, 404, { error: `Bilinmeyen dashboard yolu: ${req.method} ${path}` });
  return true;
}
