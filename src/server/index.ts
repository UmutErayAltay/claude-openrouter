import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { anthropicError } from "../translate/errors.js";
import { systemToText } from "../translate/anthropicToOpenAI.js";
import type { AnthropicRequest } from "../translate/types.js";
import { routeFor } from "../router.js";
import { passthroughToAnthropic } from "./anthropicPassthrough.js";
import { handleOpenRouter } from "./openrouterHandler.js";
import { forwardableHeaders, readBody, sendJson } from "./http.js";

export interface ProxyOptions {
  /** Re-read on every request so `cor add` takes effect without a restart. */
  loadConfig?: () => Config;
  log?: (message: string) => void;
  /** Overridable so tests don't write to the real config file. */
  markNonStreaming?: (modelId: string) => boolean;
}

export function createProxyServer(options: ProxyOptions = {}): Server {
  const load = options.loadConfig ?? loadConfig;
  const log = options.log ?? (() => {});

  return createServer((req, res) => {
    void handle(req, res, load, log, options.markNonStreaming).catch((err: unknown) => {
      log(`beklenmeyen hata: ${(err as Error).stack ?? String(err)}`);
      if (!res.headersSent) {
        sendJson(res, 500, anthropicError(500, `Proxy hatasi: ${(err as Error).message}`));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  load: () => Config,
  log: (message: string) => void,
  markNonStreaming?: (modelId: string) => boolean,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  // Claude Code's connection-warming probe.
  if (req.method === "HEAD" && path === "/api/hello") {
    res.writeHead(200).end();
    return;
  }

  if (req.method === "GET" && path === "/healthz") {
    sendJson(res, 200, { status: "ok", service: "claude-openrouter" });
    return;
  }

  const config = load();

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

  const route = routeFor(config, request.model);
  if (route.target === "anthropic") {
    await passthroughToAnthropic(config, req, res, body);
    return;
  }

  if (path === "/v1/messages/count_tokens") {
    sendJson(res, 200, { input_tokens: estimateInputTokens(request) });
    return;
  }

  log(`openrouter -> ${route.entry.id}${request.stream ? " (stream)" : ""}`);
  await handleOpenRouter(config, route.entry, request, res, { log, markNonStreaming });
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
