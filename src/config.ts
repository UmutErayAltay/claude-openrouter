import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

export const PROVIDER_SORTS = ["price", "throughput", "latency"] as const;

export type ProviderSort = (typeof PROVIDER_SORTS)[number];

export function isProviderSort(value: string): value is ProviderSort {
  return (PROVIDER_SORTS as readonly string[]).includes(value);
}

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** OpenRouter's provider-routing quantization filter values. */
export const QUANTIZATIONS = [
  "int4",
  "int8",
  "fp4",
  "mxfp4",
  "nvfp4",
  "fp6",
  "fp8",
  "mxfp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
] as const;

export type Quantization = (typeof QUANTIZATIONS)[number];

export function isQuantization(value: string): value is Quantization {
  return (QUANTIZATIONS as readonly string[]).includes(value);
}

/** A model served through OpenRouter that the user added to the picker. */
export interface ModelEntry {
  /** OpenRouter model id, e.g. "openai/gpt-5". Sent verbatim to OpenRouter. */
  id: string;
  /** Label shown in the /model picker. */
  label?: string;
  /** Second line in the /model picker. */
  description?: string;
  /** Real context window, used for CLAUDE_CODE_MAX_CONTEXT_TOKENS. */
  contextTokens?: number;
  /** Cap for max_tokens, in case Claude Code asks for more than the model allows. */
  maxOutputTokens?: number;
  /**
   * How OpenRouter picks among the providers serving this model. "price"
   * takes the cheapest first. The spread is large: DeepSeek V4 Flash is
   * served by 27 providers between $0.040 and $0.440 per million input
   * tokens. Fallbacks stay on, so a cheap provider being down costs nothing.
   */
  providerSort?: ProviderSort;
  /** Hard ceiling in dollars per million tokens; pricier providers are skipped. */
  maxPrice?: { prompt?: number; completion?: number };
  /**
   * Quantization levels to accept. The cheapest providers sometimes serve
   * heavily quantized weights, which costs code quality.
   */
  quantizations?: string[];
  /**
   * OpenRouter reasoning effort. It is worth a lot: DeepSeek reports V4-Flash
   * at 55.2 on LiveCodeBench with thinking off and 91.6 at max effort. Without
   * it the provider's default decides, so it is set explicitly per model.
   */
  reasoning?: ReasoningEffort;
  /**
   * false makes the proxy call OpenRouter without streaming and produce the
   * Anthropic event stream itself. Some providers emit tool calls as plain
   * text when asked to stream, which breaks every tool in Claude Code.
   */
  stream?: boolean;
  /**
   * Optional Claude model id to borrow capabilities from, written to the
   * picker row. It silences Claude Code's "not in this version's model
   * catalog" warning; the proxy strips the Anthropic-only fields it unlocks.
   */
  behavesAs?: string;
  /**
   * True when `stream: false` was set automatically by markModelNonStreaming,
   * not chosen by the user. Lets the dashboard show *why* a model is
   * non-streaming instead of it looking identical to a manual `--no-stream`.
   */
  autoRecovered?: boolean;
}

export interface Config {
  port: number;
  openrouterApiKey?: string;
  openrouterBaseUrl: string;
  anthropicBaseUrl: string;
  models: ModelEntry[];
}

export const DEFAULT_CONFIG: Config = {
  port: 8787,
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
  anthropicBaseUrl: "https://api.anthropic.com",
  models: [],
};

export function configDir(): string {
  return process.env.CLAUDE_OPENROUTER_DIR ?? join(homedir(), ".claude-openrouter");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function pidPath(): string {
  return join(configDir(), "proxy.pid");
}

export function logPath(): string {
  return join(configDir(), "proxy.log");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, models: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} okunamadi (gecerli JSON degil): ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${path} bir JSON nesnesi olmali.`);
  }

  const raw = parsed as Record<string, unknown>;
  return {
    port: typeof raw.port === "number" ? raw.port : DEFAULT_CONFIG.port,
    openrouterApiKey:
      typeof raw.openrouterApiKey === "string" ? raw.openrouterApiKey : undefined,
    openrouterBaseUrl:
      typeof raw.openrouterBaseUrl === "string"
        ? raw.openrouterBaseUrl.replace(/\/+$/, "")
        : DEFAULT_CONFIG.openrouterBaseUrl,
    anthropicBaseUrl:
      typeof raw.anthropicBaseUrl === "string"
        ? raw.anthropicBaseUrl.replace(/\/+$/, "")
        : DEFAULT_CONFIG.anthropicBaseUrl,
    models: Array.isArray(raw.models) ? raw.models.filter(isModelEntry) : [],
  };
}

function isModelEntry(value: unknown): value is ModelEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ModelEntry).id === "string" &&
    (value as ModelEntry).id.length > 0
  );
}

/** Writes the config atomically with 0600 permissions — it holds an API key. */
export function saveConfig(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** The env var wins over the stored key, so a key never has to touch disk. */
export function resolveOpenRouterKey(config: Config): string | undefined {
  return process.env.OPENROUTER_API_KEY ?? config.openrouterApiKey;
}

export function findModel(config: Config, modelId: string): ModelEntry | undefined {
  return config.models.find((m) => m.id === modelId);
}

/**
 * Records that a model can't produce native tool calls while streaming, so
 * later requests go out without upstream streaming. Returns false when the
 * model is already marked or isn't configured.
 */
export function markModelNonStreaming(modelId: string): boolean {
  const config = loadConfig();
  const entry = findModel(config, modelId);
  if (!entry || entry.stream === false) return false;
  entry.stream = false;
  entry.autoRecovered = true;
  saveConfig(config);
  return true;
}
