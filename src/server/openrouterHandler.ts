import type { ServerResponse } from "node:http";
import type { Config, ModelEntry } from "../config.js";
import { resolveOpenRouterKey } from "../config.js";
import { anthropicToOpenAI } from "../translate/anthropicToOpenAI.js";
import { anthropicError, openRouterErrorToAnthropic } from "../translate/errors.js";
import { openAIToAnthropic } from "../translate/openAIToAnthropic.js";
import { PING_EVENT, SseDataParser, sseEvent } from "../translate/sse.js";
import { StreamTranslator } from "../translate/stream.js";
import type { AnthropicRequest, OpenAIResponse, OpenAIStreamChunk } from "../translate/types.js";
import { sendJson } from "./http.js";

/** Claude Code aborts a stream that sends no bytes for 300s; stay well under. */
const PING_INTERVAL_MS = 15_000;

export async function handleOpenRouter(
  config: Config,
  entry: ModelEntry,
  request: AnthropicRequest,
  res: ServerResponse,
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

  if (payload.stream) {
    await streamResponse(upstream, request.model, res);
    return;
  }

  const json = (await upstream.json().catch(() => ({}))) as OpenAIResponse;
  if (json.error) {
    sendJson(res, 502, anthropicError(502, `OpenRouter: ${json.error.message ?? "bilinmeyen hata"}`));
    return;
  }
  sendJson(res, 200, openAIToAnthropic(json, request.model));
}

async function streamResponse(
  upstream: Response,
  requestedModel: string,
  res: ServerResponse,
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

        for (const event of translator.chunk(chunk)) res.write(event);
      }
    }

    for (const event of translator.finish()) res.write(event);
  } catch (err) {
    if (!res.writableEnded) {
      res.write(sseEvent("error", anthropicError(500, `Akis kesildi: ${(err as Error).message}`)));
    }
  } finally {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }
}
