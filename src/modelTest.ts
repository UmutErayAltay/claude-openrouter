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

const DEFAULT_TEST_PROMPT = "Say hello in one short sentence.";

// Modeller kıyaslama tablosunda uzun cevap üretince hem token israfı oluyor
// hem de farklı modellerin "ne kadar uzun cevap verdiği" karşılaştırılan
// şeyin kendisi oluyor. Talimatı kullanıcının prompt'unun sonuna ekliyoruz
// ki hem Test et hem Karşılaştır aynı davranışı göstersin.
const CONCISE_SUFFIX = "\n\n(Kısa cevap ver, en fazla 2-3 cümle.)";

// Kıyaslama testinin sorduğu şey "hangi model verilen soruya daha iyi/ucuz
// cevap veriyor". Düşünmeye ayrılan token'lar buna hizmet etmiyor, sadece
// bütçeyi yiyip cevabı kesiyor: 60'ta reasoning modelleri (deepseek high,
// nemotron max) tamamını düşünmeye harcar ve BOS metin döner; 1024'te ise
// "Merhaba" gibi basit bir soruya kocaman bir cevap üretip bütçeyi doldurur.
// 400 ikisinin de arasında: düşünmeye yer var, ama verilen prompt ne kadar
// uzunsa cevap o kadar uzun — kıyaslama tablosu uzun metni özetler.
const TEST_MAX_TOKENS = 400;

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
  prompt?: string,
): Promise<TestModelResult> {
  // Varsayılan parametre yalnizca `undefined` icin gecerli; dashboard bos
  // metni acikca gonderiyor ve OpenRouter "Input must have at least 1 token"
  // ile 400 donuyordu. Bosluk kirpilip bos kaliyorsa varsayilana dusulur.
  const question = (prompt?.trim() ? prompt : DEFAULT_TEST_PROMPT) + CONCISE_SUFFIX;
  const apiKey = resolveOpenRouterKey(config);
  if (!apiKey) {
    return { ok: false, error: "OpenRouter anahtari yok. `cor key <anahtar>` calistir." };
  }

  const request: AnthropicRequest = {
    model: entry.id,
    max_tokens: TEST_MAX_TOKENS,
    messages: [{ role: "user", content: question }],
  };
  const payload = anthropicToOpenAI(request, entry);
  // Kıyaslama yapılandırılmış reasoning ayarını (`high`/`max`) geçici olarak
  // kapatır: bu ayarlar günlük kullanım için doğru, ama kıyaslama tablosu
  // bütçeyi tamamen düşünmeye harcadığı için ya boş metin dönüyor ya da
  // cevap bütçeyi doldurup kıyaslanacak şeyi gizliyordu. Gerçek ayar
  // config'de duruyor, sadece bu test isteğinde eziliyor.
  delete payload.reasoning;
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
  const text = textBlock?.text ?? "";

  // HTTP 200 olmus olabilir ama cevap bos olabilir (model hic sey yazmadan
  // durmus olabilir). Bunu "calisiyor" diye gostermek dashboard'da yesil ama
  // bos bir satir olurdu; gercek bir basarisizlik daha dogru.
  if (text.trim() === "") {
    const spent = raw.usage?.completion_tokens ?? 0;
    return {
      ok: false,
      error:
        `Model yanit dondurmedi (${spent} cikti tokeni, bos metin). ` +
        "Baska bir soru dene veya modelin sunucusuna bak.",
    };
  }

  return {
    ok: true,
    text,
    latencyMs,
    promptTokens: raw.usage?.prompt_tokens ?? 0,
    completionTokens: raw.usage?.completion_tokens ?? 0,
    cost: raw.usage?.cost ?? null,
  };
}

/**
 * Asks several models the same question at once, for the dashboard's
 * side-by-side compare. Parallel because they are independent billable calls:
 * serializing them would make a four-model comparison take the sum of the
 * slowest latencies instead of the slowest one.
 */
export async function compareModels(
  config: Config,
  entries: ModelEntry[],
  prompt: string,
  recordUsage: (record: Omit<UsageRecord, "ts">) => void,
): Promise<Array<{ model: string; result: TestModelResult }>> {
  return Promise.all(
    entries.map(async (entry) => ({
      model: entry.id,
      result: await testModel(config, entry, recordUsage, prompt),
    })),
  );
}
