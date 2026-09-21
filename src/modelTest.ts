import type { Config, ModelEntry } from "./config.js";
import { resolveOpenRouterKey } from "./config.js";
import { anthropicToOpenAI } from "./translate/anthropicToOpenAI.js";
import { openAIToAnthropic } from "./translate/openAIToAnthropic.js";
import type { AnthropicRequest, OpenAIResponse } from "./translate/types.js";
import { toUsageEntry } from "./server/openrouterHandler.js";
import type { UsageRecord } from "./usageLog.js";

export type TestModelResult =
  | {
      ok: true;
      text: string;
      latencyMs: number;
      promptTokens: number;
      completionTokens: number;
      cost: number | null;
    }
  | { ok: false; error: string };

const TEST_REQUEST: AnthropicRequest = {
  model: "",
  max_tokens: 60,
  messages: [{ role: "user", content: "Say hello in one short sentence." }],
};

/**
 * Sends one small real request through a configured model, for the
 * dashboard's "test this model" button. This is a genuine billable call
 * (recorded through the same usage log as ordinary traffic), not a dry run —
 * the point is to confirm the model actually answers before relying on it.
 */
export async function testModel(
  config: Config,
  entry: ModelEntry,
  recordUsage: (record: Omit<UsageRecord, "ts">) => void,
): Promise<TestModelResult> {
  const apiKey = resolveOpenRouterKey(config);
  if (!apiKey) {
    return { ok: false, error: "OpenRouter anahtari yok. `cor key <anahtar>` calistir." };
  }

  const payload = anthropicToOpenAI({ ...TEST_REQUEST, model: entry.id }, entry);
  // The test always waits for a single complete answer, regardless of the
  // model's own stream setting — there is no SSE consumer here to feed.
  payload.stream = undefined;
  payload.stream_options = undefined;

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "http-referer": "https://github.com/UmutErayAltay/claude-openrouter",
        "x-title": "claude-openrouter",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { ok: false, error: `OpenRouter'a ulasilamadi: ${(err as Error).message}` };
  }
  const latencyMs = Date.now() - started;

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return { ok: false, error: `OpenRouter ${upstream.status}: ${text.slice(0, 300)}` };
  }

  const raw = (await upstream.json().catch(() => ({}))) as OpenAIResponse;
  if (raw.error) {
    return { ok: false, error: raw.error.message ?? "bilinmeyen hata" };
  }

  recordUsage(toUsageEntry(entry.id, raw.usage, false));

  const anthropic = openAIToAnthropic(raw, entry.id);
  const textBlock = anthropic.content.find(
    (block): block is { type: "text"; text: string } => block.type === "text",
  );

  return {
    ok: true,
    text: textBlock?.text ?? "",
    latencyMs,
    promptTokens: raw.usage?.prompt_tokens ?? 0,
    completionTokens: raw.usage?.completion_tokens ?? 0,
    cost: raw.usage?.cost ?? null,
  };
}
