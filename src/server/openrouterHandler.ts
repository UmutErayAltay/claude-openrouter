import type { ServerResponse } from "node:http";
import type { Config, ModelEntry } from "../config.js";
import { markModelNonStreaming, resolveOpenRouterKey } from "../config.js";
import { anthropicToOpenAI } from "../translate/anthropicToOpenAI.js";
import { anthropicError, openRouterErrorToAnthropic } from "../translate/errors.js";
import { openAIToAnthropic } from "../translate/openAIToAnthropic.js";
import { PING_EVENT, SseDataParser, sseEvent } from "../translate/sse.js";
import { StreamTranslator, synthesizeStream } from "../translate/stream.js";
import {
  looksLikeTextToolCall,
  parseTextToolCalls,
  recoverToolCalls,
} from "../translate/textToolCall.js";
import type {
  AnthropicRequest,
  AnthropicTool,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIUsage,
} from "../translate/types.js";
import { recordUsage as recordUsageToLog, type UsageRecord } from "../usageLog.js";
import { sendJson } from "./http.js";

/** Claude Code aborts a stream that sends no bytes for 300s; stay well under. */
const PING_INTERVAL_MS = 15_000;

export interface OpenRouterHandlerOptions {
  log?: (message: string) => void;
  /** Overridable so tests don't write to the real config file. */
  markNonStreaming?: (modelId: string) => boolean;
  /** Overridable so tests don't write to the real usage log. */
  recordUsage?: (entry: Omit<UsageRecord, "ts">) => void;
}

/** Maps an OpenRouter usage object to the shape the dashboard's log stores. */
export function toUsageEntry(
  model: string,
  usage: OpenAIUsage | undefined,
  stream: boolean,
): Omit<UsageRecord, "ts"> {
  return {
    model,
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cost: usage?.cost ?? null,
    stream,
  };
}

export async function handleOpenRouter(
  config: Config,
  entry: ModelEntry,
  request: AnthropicRequest,
  res: ServerResponse,
  options: OpenRouterHandlerOptions = {},
): Promise<void> {
  const apiKey = resolveOpenRouterKey(config);
  if (!apiKey) {
    sendJson(
      res,
      401,
      anthropicError(
        401,
        "OpenRouter anahtari yok. `cor key <anahtar>` calistir veya OPENROUTER_API_KEY ayarla.",
      ),
    );
    return;
  }

  const payload = anthropicToOpenAI(request, entry);

  let upstream: Response;
  try {
    upstream = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "http-referer": "https://github.com/UmutErayAltay/Claude-code-ve-di-er-modeller",
        "x-title": "claude-openrouter",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (err) {
    sendJson(
      res,
      502,
      anthropicError(502, `OpenRouter'a ulasilamadi: ${(err as Error).message}`),
    );
    return;
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    sendJson(res, upstream.status, openRouterErrorToAnthropic(upstream.status, text));
    return;
  }

  const record = options.recordUsage ?? recordUsageToLog;

  if (payload.stream) {
    await streamResponse(upstream, request.model, res, {
      // Only a turn that offered tools can reveal the failure.
      tools: request.tools ?? [],
      modelId: entry.id,
      log: options.log ?? (() => {}),
      markNonStreaming: options.markNonStreaming ?? markModelNonStreaming,
      recordUsage: record,
    });
    return;
  }

  const raw = (await upstream.json().catch(() => ({}))) as OpenAIResponse;
  if (raw.error) {
    sendJson(res, 502, anthropicError(502, `OpenRouter: ${raw.error.message ?? "bilinmeyen hata"}`));
    return;
  }

  // Recorded here rather than after recovery: cost and token counts describe
  // what OpenRouter actually billed, unaffected by how we interpret the text.
  record(toUsageEntry(entry.id, raw.usage, false));

  // Models that write tool calls as prose are turned back into ordinary
  // tool-calling responses here, before anything else looks at them.
  const { response: json, recovered } = recoverToolCalls(raw, request.tools);
  if (recovered > 0) {
    (options.log ?? (() => {}))(
      `${entry.id}: ${recovered} tool cagrisi duz metinden kurtarildi`,
    );
  }

  // Claude Code asked for a stream but this model is configured to skip
  // upstream streaming, so the events are produced from the finished response.
  if (request.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of synthesizeStream(json, request.model)) res.write(event);
    res.end();
    return;
  }

  sendJson(res, 200, openAIToAnthropic(json, request.model));
}

interface StreamContext {
  tools: AnthropicTool[];
  modelId: string;
  log: (message: string) => void;
  markNonStreaming: (modelId: string) => boolean;
  recordUsage: (entry: Omit<UsageRecord, "ts">) => void;
}

async function streamResponse(
  upstream: Response,
  requestedModel: string,
  res: ServerResponse,
  context: StreamContext,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const translator = new StreamTranslator(requestedModel);
  const parser = new SseDataParser();
  // OpenRouter stays silent while the model thinks; our own pings keep the
  // byte watchdog on the Claude Code side from aborting the stream.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(PING_EVENT);
  }, PING_INTERVAL_MS);

  let sawToolCall = false;
  let recovering = false;
  let text = "";

  try {
    if (!upstream.body) {
      for (const event of translator.finish()) res.write(event);
      return;
    }

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
        if (payload === "[DONE]") continue;

        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          continue;
        }

        if (chunk.error) {
          // Mid-stream failures reach Claude Code as an SSE error event.
          res.write(
            sseEvent("error", anthropicError(500, `OpenRouter: ${chunk.error.message ?? "hata"}`)),
          );
          return;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta?.tool_calls?.length) sawToolCall = true;
        if (typeof delta?.content === "string") {
          text += delta.content;
          // Once the prose turns out to be a tool call, stop relaying it and
          // hold the rest back so it can be turned into a real tool block.
          if (!recovering && context.tools.length > 0 && looksLikeTextToolCall(text)) {
            recovering = true;
          }
        }

        if (recovering && typeof delta?.content === "string") continue;
        for (const event of translator.chunk(chunk)) res.write(event);
      }
    }

    // The model wrote its tool calls as prose. Emitting them as real tool
    // blocks rescues this turn; switching the model off upstream streaming
    // lets the next one be recovered from a complete response instead.
    if (recovering && !sawToolCall) {
      const { calls } = parseTextToolCalls(text, context.tools);
      if (calls.length > 0) {
        for (const [index, call] of calls.entries()) {
          for (const event of translator.chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: `toolu_recovered_${index}_${Math.random().toString(36).slice(2, 10)}`,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.input) },
                    },
                  ],
                },
              },
            ],
          })) {
            res.write(event);
          }
        }
        for (const event of translator.chunk({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
        })) {
          res.write(event);
        }
      }

      const changed = context.markNonStreaming(context.modelId);
      context.log(
        `${context.modelId}: tool cagrisi duz metin olarak geldi, ` +
          `${calls.length} cagri kurtarildi` +
          (changed ? "; bu model icin akissiz cagriya gecildi" : ""),
      );
    }

    for (const event of translator.finish()) res.write(event);
    // Recorded on the success path only: an error or an aborted stream
    // reaches its own return/catch above and never gets here.
    context.recordUsage(toUsageEntry(context.modelId, translator.lastUsage, true));
  } catch (err) {
    if (!res.writableEnded) {
      res.write(sseEvent("error", anthropicError(500, `Akis kesildi: ${(err as Error).message}`)));
    }
  } finally {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }
}
