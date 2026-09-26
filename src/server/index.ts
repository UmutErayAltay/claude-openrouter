import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { findModel, loadConfig } from "../config.js";
import { isFreeQuotaExhausted } from "../quotaGuard.js";
import { anthropicError } from "../translate/errors.js";
import { systemToText } from "../translate/anthropicToOpenAI.js";
import type { AnthropicRequest } from "../translate/types.js";
import { routeFor } from "../router.js";
import { passthroughToAnthropic } from "./anthropicPassthrough.js";
import { handleOpenRouter } from "./openrouterHandler.js";
import { forwardableHeaders, readBody, sendJson } from "./http.js";
import { recordUsage as recordUsageToLog, readUsage as readUsageToLog, type UsageRecord } from "../usageLog.js";
import { recordRequest, recordUsageMetrics, renderMetrics, getMetricsSummary } from "../metrics.js";
import { checkBudget } from "../budget.js";
import { evaluateAlerts } from "../alerts.js";
import { defaultDashboardDeps, handleDashboard, type DashboardDeps } from "./dashboardApi.js";
import { buildDashboardHtml } from "./dashboardPage.js";

export interface ProxyOptions {
  /** Re-read on every request so `cor add` takes effect without a restart. */
  loadConfig?: () => Config;
  log?: (message: string) => void;
  /** Overridable so tests don't write to the real config file. */
  markNonStreaming?: (modelId: string) => boolean;
  /** Overridable so tests don't write to the real usage log. */
  recordUsage?: (entry: Omit<UsageRecord, "ts">) => void;
  /** Overridable so tests don't read the real usage log (the budget gate does). */
  readUsage?: () => UsageRecord[];
  /** Overridable so tests don't touch the real Claude settings/agent files. */
  dashboard?: Partial<DashboardDeps>;
}

interface HandleContext {
  load: () => Config;
  log: (message: string) => void;
  markNonStreaming?: (modelId: string) => boolean;
  recordUsage: (entry: Omit<UsageRecord, "ts">) => void;
  readUsage: () => UsageRecord[];
  dashboardDeps: DashboardDeps;
}

export function createProxyServer(options: ProxyOptions = {}): Server {
  const recordUsageToBase = options.recordUsage ?? recordUsageToLog;

  const context: HandleContext = {
    load: options.loadConfig ?? loadConfig,
    log: options.log ?? (() => {}),
    markNonStreaming: options.markNonStreaming,
    // Every real request feeds both the durable usage.jsonl log and the
    // in-memory /metrics counters from the same entry, so they never drift.
    recordUsage: (entry) => {
      recordUsageToBase(entry);
      recordUsageMetrics(entry);
    },
    readUsage: options.readUsage ?? readUsageToLog,
    dashboardDeps: { ...defaultDashboardDeps(), ...options.dashboard },
  };

  return createServer((req, res) => {
    void handle(req, res, context).catch((err: unknown) => {
      context.log(`beklenmeyen hata: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, anthropicError(500, `Proxy hatasi: ${(err as Error).message}`));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, context: HandleContext): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const { load, log, markNonStreaming, recordUsage, readUsage } = context;

  // Claude Code's connection-warming probe.
  if (req.method === "HEAD" && path === "/api/hello") {
    res.writeHead(200).end();
    return;
  }

  if (req.method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", service: "claude-openrouter" });
    return;
  }

  if (req.method === "GET" && path === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(renderMetrics());
    return;
  }

  const config = load();

  if (path === "/dashboard" || path.startsWith("/dashboard/")) {
    if (await handleDashboard(req, res, config, context.dashboardDeps, buildDashboardHtml)) return;
  }

  if (req.method === "GET" && path === "/v1/models") {
    await handleModels(config, req, res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 404, anthropicError(404, `Bilinmeyen yol: ${req.method} ${path}`));
    return;
  }

  const body = await readBody(req);

  if (path !== "/v1/messages" && path !== "/v1/messages/count_tokens") {
    await passthroughToAnthropic(config, req, res, body);
    return;
  }

  let request: AnthropicRequest;
  try {
    request = JSON.parse(body.toString("utf8")) as AnthropicRequest;
  } catch {
    sendJson(res, 400, anthropicError(400, "Istek govdesi gecerli JSON degil."));
    return;
  }

  let route = routeFor(config, request.model);
  if (route.target === "anthropic") {
    await passthroughToAnthropic(config, req, res, body);
    return;
  }

  if (path === "/v1/messages/count_tokens") {
    sendJson(res, 200, { input_tokens: estimateInputTokens(request) });
    return;
  }

  // OpenRouter's :free tier shares one account-wide daily quota; an agentic
  // session can burn through it in a handful of turns. Once we've seen the
  // quota reject a request today, route away from it automatically instead
  // of failing every subsequent turn for the rest of the day.
  // wasFree is set going forward (see modelOps.autofillFromCatalog), but a
  // model added before that existed has no such flag; the ":free" suffix is
  // OpenRouter's own convention and catches those too.
  const isFreeTierModel = route.entry.wasFree || route.entry.id.endsWith(":free");
  if (isFreeTierModel && isFreeQuotaExhausted()) {
    const fallback = route.entry.fallbackModel ? findModel(config, route.entry.fallbackModel) : undefined;
    if (fallback) {
      log(`gunluk ucretsiz kota tukendi: ${route.entry.id} -> ${fallback.id} (fallbackModel)`);
      route = { target: "openrouter", entry: fallback };
    } else {
      log(`gunluk ucretsiz kota tukendi: ${route.entry.id} engellendi (fallbackModel tanimli degil)`);
      sendJson(res, 429, {
        type: "error",
        error: {
          type: "rate_limit_error",
          message:
            `cor: '${route.entry.id}' icin OpenRouter'in gunluk ucretsiz-model kotasi (free-models-per-day) ` +
            "tukenmis gorunuyor. Yarin UTC 00:00'da sifirlanir, ya da bu modele dashboard'dan bir " +
            "fallbackModel tanimla.",
        },
      });
      recordRequest({
        model: route.entry.id,
        outcome: "quota_exhausted",
        durationSeconds: 0,
        error: "cor: gunluk ucretsiz kota tukendi",
      });
      return;
    }
  }

  if (config.budget?.action === "block") {
    const usage = readUsage();
    if (checkBudget(config, usage, Date.now()).exceeded && !isKnownFreeModel(usage, route.entry.id)) {
      log(`butce asildi, ${route.entry.id} engellendi`);
      sendJson(res, 402, {
        type: "error",
        error: {
          type: "billing_error",
          message:
            "cor: butce asildi. Ucretli modeller icin istekler durduruldu " +
            "(config.budget.dailyUsd / monthlyUsd). Kapami yukselt veya butceyi sifirla.",
        },
      });
      recordRequest({
        model: route.entry.id,
        outcome: "budget_blocked",
        durationSeconds: 0,
        error: "cor: butce asildi",
      });
      return;
    }
  }

  if (route.entry.priceDrift) {
    const { promptPrice, completionPrice } = route.entry.priceDrift;
    log(`ucretsiz->ucretli gecisi: ${route.entry.id} engellendi`);
    sendJson(res, 402, {
      type: "error",
      error: {
        type: "billing_error",
        message: `cor: '${route.entry.id}' modeli ucretsizdi, artik ucretli gorunuyor ` +
          `($${promptPrice ?? "?"}/M girdi, $${completionPrice ?? "?"}/M cikti). Promosyon ` +
          `bitmis olabilir. Kullanmaya devam etmek icin dashboard'dan modeli guncelle ` +
          `(priceDrift'i temizle) veya kaldir.`,
      },
    });
    recordRequest({
      model: route.entry.id,
      outcome: "price_drift_blocked",
      durationSeconds: 0,
      error: "cor: ucretsizden ucretliye gecti",
    });
    return;
  }

  log(`openrouter -> ${route.entry.id}${request.stream ? " (stream)" : ""}`);
  const startedAt = Date.now();
  // The proxy only learns why a request failed once it's already been answered,
  // so the handler reports the text it sent and it lands in the recent-errors list.
  let errorMessage: string | undefined;
  const outcome = await handleOpenRouter(config, route.entry, request, res, {
    log,
    markNonStreaming,
    recordUsage,
    onError: (message) => {
      errorMessage = message;
    },
  });
  recordRequest({
    model: route.entry.id,
    outcome,
    durationSeconds: (Date.now() - startedAt) / 1000,
    error: errorMessage,
  });

  void evaluateAlerts(config, getMetricsSummary(), Date.now()).catch((err: unknown) => {
    context.log(`alarm hatasi: ${(err as Error).message}`);
  });
}

/**
 * 402 unless the model is one we've only ever seen billed at $0. Costs are
 * only known after a request has been made, so a model with no usage record
 * yet is treated as paid and blocked — otherwise the cap could be evaded by
 * simply being the first model asked for after it was hit.
 */
function isKnownFreeModel(usage: UsageRecord[], model: string): boolean {
  let records = 0;
  let cost = 0;
  for (const record of usage) {
    if (record.model !== model) continue;
    records += 1;
    cost += record.cost ?? 0;
  }
  return records > 0 && cost === 0;
}

/**
 * Serves the gateway model-discovery endpoint. Claude Code keeps only entries
 * whose id contains "claude" or "anthropic", so most OpenRouter ids are
 * filtered out there — `cor sync` writing a modelPicker lineup is the path
 * that actually puts them in the picker. The endpoint still merges the
 * upstream Anthropic list so discovery works for Claude models.
 */
async function handleModels(
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const local = config.models.map((model) => ({
    id: model.id,
    type: "model",
    display_name: model.label ?? model.id,
    description: model.description ?? "OpenRouter uzerinden",
  }));

  let upstream: { id: string }[] = [];
  try {
    const response = await fetch(`${config.anthropicBaseUrl}/v1/models?limit=1000`, {
      headers: forwardableHeaders(req),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const json = (await response.json()) as { data?: { id: string }[] };
      upstream = json.data ?? [];
    }
  } catch {
    // Discovery is best-effort; Claude Code falls back to its built-in list.
  }

  sendJson(res, 200, { data: [...upstream, ...local], has_more: false });
}

/** Rough estimate used only for the context meter on OpenRouter models. */
export function estimateInputTokens(request: AnthropicRequest): number {
  let characters = systemToText(request.system).length;

  for (const message of request.messages ?? []) {
    if (typeof message.content === "string") {
      characters += message.content.length;
      continue;
    }
    for (const block of message.content ?? []) {
      characters += JSON.stringify(block).length;
    }
  }

  for (const tool of request.tools ?? []) {
    characters += JSON.stringify(tool).length;
  }

  return Math.ceil(characters / 4);
}
