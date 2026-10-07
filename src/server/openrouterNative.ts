import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config, ModelEntry } from "../config.js";
import { resolveOpenRouterKey } from "../config.js";
import type { RequestOutcome } from "../metrics.js";
import { looksLikeFreeQuotaError, markFreeQuotaExhausted } from "../quotaGuard.js";
import { anthropicError } from "../translate/errors.js";
import { SseDataParser } from "../translate/sse.js";
import { recordUsage as recordUsageToLog, type UsageRecord } from "../usageLog.js";
import { forwardableHeaders, sendJson } from "./http.js";
import type { OpenRouterHandlerOptions } from "./openrouterHandler.js";

/** Credentials Claude Code sent for Anthropic; they must never reach OpenRouter. */
const DROPPED = new Set(["x-api-key", "authorization", "accept-encoding"]);

/**
 * Sends Claude Code's request to OpenRouter's Anthropic-compatible /messages
 * endpoint without translating it — the same request Claude Code would make
 * with ANTHROPIC_BASE_URL pointed at OpenRouter, with only the credential
 * swapped for the OpenRouter key. Some free models (Inkling) are served only
 * to agentic harnesses OpenRouter recognizes; the translated path replaces
 * Claude Code's own headers and is refused, this one keeps them.
 */
export async function handleOpenRouterNative(
  config: Config,
  entry: ModelEntry,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  options: OpenRouterHandlerOptions = {},
): Promise<RequestOutcome> {
  const apiKey = resolveOpenRouterKey(config);
  if (!apiKey) {
    const message =
      "OpenRouter anahtari yok. `cor key <anahtar>` calistir veya OPENROUTER_API_KEY ayarla.";
    sendJson(res, 401, anthropicError(401, message));
    options.onError?.(message);
    return "no_key";
  }

  const headers = forwardableHeaders(req);
  for (const name of Object.keys(headers)) {
    if (DROPPED.has(name.toLowerCase())) delete headers[name];
  }
  headers.authorization = `Bearer ${apiKey}`;

  const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";

  let upstream: Response;
  try {
    upstream = await fetch(`${config.openrouterBaseUrl}/messages${query}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (err) {
    const message = `OpenRouter'a ulasilamadi: ${(err as Error).message}`;
    sendJson(res, 502, anthropicError(502, message));
    options.onError?.(message);
    return "network_error";
  }

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (name === "content-encoding" || name === "content-length" || name === "connection") return;
    responseHeaders[name] = value;
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    if (looksLikeFreeQuotaError(text)) markFreeQuotaExhausted();
    res.writeHead(upstream.status, responseHeaders);
    res.end(text);
    options.onError?.(errorMessageOf(text) ?? `OpenRouter ${upstream.status}`);
    return "upstream_error";
  }

  res.writeHead(upstream.status, responseHeaders);
  const record = options.recordUsage ?? recordUsageToLog;
  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");

  if (!upstream.body) {
    res.end();
    return "ok";
  }

  // Relayed chunk by chunk, never buffered: buffering a stream stalls Claude
  // Code. The usage figures are read off the bytes on their way through.
  const usage = new UsageCollector();
  const parser = new SseDataParser();
  const decoder = new TextDecoder();
  let jsonText = "";
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      const text = decoder.decode(value, { stream: true });
      if (isStream) {
        for (const payload of parser.push(text)) usage.addEvent(payload);
      } else {
        jsonText += text;
      }
    }
  } catch (err) {
    const message = `OpenRouter akisi kesildi: ${(err as Error).message}`;
    options.onError?.(message);
    res.end();
    return "network_error";
  }
  res.end();

  if (!isStream) usage.addMessage(jsonText);
  record({ ...usage.toEntry(entry.id), stream: isStream });
  return "ok";
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number };
  cost?: number;
}

/** Folds message_start / message_delta usage (or a whole message) into one record. */
class UsageCollector {
  private promptTokens = 0;
  private completionTokens = 0;
  private reasoningTokens: number | undefined;
  private cachedTokens: number | undefined;
  private cost: number | null = null;

  addEvent(payload: string): void {
    const event = parseJson(payload) as
      | { type?: string; message?: { usage?: AnthropicUsage }; usage?: AnthropicUsage }
      | undefined;
    if (event?.type === "message_start") this.merge(event.message?.usage);
    else if (event?.type === "message_delta") this.merge(event.usage);
  }

  addMessage(text: string): void {
    const message = parseJson(text) as { usage?: AnthropicUsage } | undefined;
    this.merge(message?.usage);
  }

  /** Later events carry running totals, so a non-zero value replaces the earlier one. */
  private merge(usage: AnthropicUsage | undefined): void {
    if (!usage) return;
    if (usage.input_tokens) this.promptTokens = usage.input_tokens;
    if (usage.output_tokens) this.completionTokens = usage.output_tokens;
    const thinking = usage.output_tokens_details?.thinking_tokens;
    if (typeof thinking === "number") this.reasoningTokens = thinking;
    if (typeof usage.cache_read_input_tokens === "number") {
      this.cachedTokens = usage.cache_read_input_tokens;
    }
    if (typeof usage.cost === "number") this.cost = usage.cost;
  }

  toEntry(model: string): Omit<UsageRecord, "ts" | "stream"> {
    // OpenRouter counts cached tokens apart from input_tokens on this endpoint;
    // the log's promptTokens is the whole prompt, as on the translated path.
    return {
      model,
      promptTokens: this.promptTokens + (this.cachedTokens ?? 0),
      completionTokens: this.completionTokens,
      reasoningTokens: this.reasoningTokens,
      cachedTokens: this.cachedTokens,
      cost: this.cost,
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorMessageOf(text: string): string | undefined {
  const body = parseJson(text) as { error?: { message?: string } } | undefined;
  return body?.error?.message;
}
