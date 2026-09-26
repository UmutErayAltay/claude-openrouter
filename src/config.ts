import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
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

/** Spend caps, in dollars. `action` decides whether hitting one warns or blocks. */
export interface BudgetConfig {
  dailyUsd?: number;
  monthlyUsd?: number;
  action: "warn" | "block";
}

/** Thresholds the dashboard warns about. */
export interface AlertsConfig {
  errorRatePct?: number;
  latencyP95Seconds?: number;
  windowMinutes?: number;
  /** http(s) endpoint that receives a JSON POST when a threshold is crossed. */
  webhookUrl?: string;
}

export interface Config {
  port: number;
  openrouterApiKey?: string;
  openrouterBaseUrl: string;
  anthropicBaseUrl: string;
  models: ModelEntry[];
  budget?: BudgetConfig;
  alerts?: AlertsConfig;
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

/**
 * The API key lives here, separate from config.json, so opening the config
 * file to look at model settings never shows the key (it leaked into a
 * debug transcript this way once — see the vault's 2026-09-21 incident).
 */
export function keyPath(): string {
  return join(configDir(), "key");
}

function readKeyFile(): string | undefined {
  if (!existsSync(keyPath())) return undefined;
  const value = readFileSync(keyPath(), "utf8").trim();
  return value.length > 0 ? value : undefined;
}

/** Writes the key file atomically with 0600 permissions, same pattern as saveConfig. */
export function saveKey(key: string): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = keyPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
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

  return parseConfig(parsed);
}

/**
 * The one place a parsed JSON object becomes a Config, so a history restore is
 * validated by exactly the rules a normal load is.
 */
function parseConfig(parsed: unknown): Config {
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
    // Both are optional and absent from every config saved before this version,
    // so a malformed or missing one falls back to unset rather than throwing —
    // the file's other settings are still perfectly usable.
    budget: parseBudget(raw.budget),
    alerts: parseAlerts(raw.alerts),
  };
}

function parseBudget(value: unknown): BudgetConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const action = raw.action === "warn" || raw.action === "block" ? raw.action : "warn";
  const dailyUsd = readNonNegativeNumber(raw.dailyUsd);
  const monthlyUsd = readNonNegativeNumber(raw.monthlyUsd);
  if (dailyUsd === undefined && monthlyUsd === undefined) return undefined;
  return { dailyUsd, monthlyUsd, action };
}

function parseAlerts(value: unknown): AlertsConfig | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const errorRatePct = readNonNegativeNumber(raw.errorRatePct);
  const latencyP95Seconds = readNonNegativeNumber(raw.latencyP95Seconds);
  const windowMinutes = readNonNegativeNumber(raw.windowMinutes);
  const webhookUrl = isHttpUrl(raw.webhookUrl) ? raw.webhookUrl : undefined;
  if (
    errorRatePct === undefined &&
    latencyP95Seconds === undefined &&
    windowMinutes === undefined &&
    webhookUrl === undefined
  ) {
    return undefined;
  }
  return { errorRatePct, latencyP95Seconds, windowMinutes, webhookUrl };
}

/** Tolerates a missing or non-numeric field by leaving it unset. */
function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Strict validation for values arriving from the dashboard, where a typo
 * should be reported rather than silently dropped the way a malformed stored
 * config is. A section left out of the input stays unset.
 */
export function validateSettings(input: unknown): {
  budget?: BudgetConfig;
  alerts?: AlertsConfig;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Ayar govdesi bir JSON nesnesi olmali.");
  }
  const raw = input as Record<string, unknown>;

  const result: { budget?: BudgetConfig; alerts?: AlertsConfig } = {};
  if (raw.budget !== undefined) result.budget = validateBudget(raw.budget);
  if (raw.alerts !== undefined) result.alerts = validateAlerts(raw.alerts);
  return result;
}

function validateBudget(value: unknown): BudgetConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Budget bir JSON nesnesi olmali.");
  }
  const raw = value as Record<string, unknown>;

  const action = raw.action ?? "warn";
  if (action !== "warn" && action !== "block") {
    throw new Error(`Gecersiz budget action: ${String(action)}. warn veya block olmali.`);
  }
  return {
    dailyUsd: readStrictNumber(raw.dailyUsd, "budget.dailyUsd"),
    monthlyUsd: readStrictNumber(raw.monthlyUsd, "budget.monthlyUsd"),
    action,
  };
}

function validateAlerts(value: unknown): AlertsConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Alerts bir JSON nesnesi olmali.");
  }
  const raw = value as Record<string, unknown>;
  return {
    errorRatePct: readStrictNumber(raw.errorRatePct, "alerts.errorRatePct"),
    latencyP95Seconds: readStrictNumber(raw.latencyP95Seconds, "alerts.latencyP95Seconds"),
    windowMinutes: readStrictNumber(raw.windowMinutes, "alerts.windowMinutes"),
    webhookUrl: readWebhookUrl(raw.webhookUrl),
  };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Empty string clears the webhook; anything else must be an http(s) URL. */
function readWebhookUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isHttpUrl(value)) {
    throw new Error(`Gecersiz alerts.webhookUrl: ${String(value)}. http(s) adresi olmali.`);
  }
  return value;
}

/** undefined means "leave unset"; anything else must be a finite, non-negative number. */
function readStrictNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Gecersiz ${label}: ${String(value)}. Sonlu ve sifirdan buyuk bir sayi olmali.`);
  }
  return value;
}

function isModelEntry(value: unknown): value is ModelEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ModelEntry).id === "string" &&
    (value as ModelEntry).id.length > 0
  );
}

export function historyDir(): string {
  return join(configDir(), "history");
}

/** How many past versions are kept. Enough to undo a run of dashboard edits. */
const HISTORY_LIMIT = 20;

function historyFileName(now: number): string {
  // ':' is illegal in a filename on Windows; ISO also sorts lexicographically.
  return `${new Date(now).toISOString().replace(/:/g, "-")}.json`;
}

function historyFiles(): string[] {
  const dir = historyDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse();
}

/**
 * Copies the config that is about to be overwritten into history/, so a bad
 * dashboard edit is recoverable. Never throws: losing the backup must not stop
 * the write it was meant to protect.
 */
function snapshotConfig(): void {
  const path = configPath();
  if (!existsSync(path)) return;
  try {
    mkdirSync(historyDir(), { recursive: true, mode: 0o700 });
    const target = join(historyDir(), historyFileName(Date.now()));
    writeFileSync(target, readFileSync(path, "utf8"), { mode: 0o600 });
    chmodSync(target, 0o600);

    for (const stale of historyFiles().slice(HISTORY_LIMIT)) {
      unlinkSync(join(historyDir(), stale));
    }
  } catch {
    // A history failure is not worth losing the config write over.
  }
}

export interface ConfigHistoryEntry {
  file: string;
  savedAt: string;
  models: number;
  size: number;
}

/** Past configs, newest first. */
export function listConfigHistory(): ConfigHistoryEntry[] {
  return historyFiles().flatMap((file) => {
    const path = join(historyDir(), file);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const models =
        typeof raw === "object" && raw !== null && Array.isArray((raw as Config).models)
          ? (raw as Config).models.length
          : 0;
      return [
        {
          file,
          // The filename is the timestamp; show it as a plain ISO instant.
          savedAt: file.replace(/\.json$/, "").replace("T", " "),
          models,
          size: statSync(path).size,
        },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * Restores a history entry as the live config. `file` is a bare filename from
 * the dashboard, so it's rejected unless it is exactly one: without that, a
 * crafted value could read (or via the save, clobber) any file on disk.
 */
export function restoreConfig(file: string): Config {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("Eski config dosya adi zorunlu.");
  }
  if (
    file !== basename(file) ||
    file.includes("/") ||
    file.includes("\\") ||
    !file.endsWith(".json")
  ) {
    throw new Error(`Gecersiz config dosya adi: ${file}`);
  }

  const path = join(historyDir(), file);
  if (!existsSync(path)) {
    throw new Error(`Config gecmisi bulunamadi: ${file}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${file} okunamadi (gecerli JSON degil): ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file} bir JSON nesnesi olmali.`);
  }

  const config = parseConfig(parsed);
  // Goes through the normal write, so the config being replaced is itself
  // snapshotted: an undo is undoable, not a one-way trip.
  saveConfig(config);
  return config;
}

/**
 * Writes the config atomically with 0600 permissions. Never writes a key
 * into config.json: if the in-memory object still carries a legacy
 * `openrouterApiKey` (loaded from an older config.json) and no key file
 * exists yet, it's moved to the key file first — written then read back to
 * confirm — before the keyless config is written, so a failed migration
 * never loses the only copy of the key.
 */
export function saveConfig(config: Config): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (config.openrouterApiKey && !existsSync(keyPath())) {
    saveKey(config.openrouterApiKey);
    if (readKeyFile() !== config.openrouterApiKey) {
      throw new Error("Anahtar key dosyasina yazilamadi; config.json degistirilmedi.");
    }
  }

  snapshotConfig();

  const { openrouterApiKey: _legacyKey, ...withoutKey } = config;
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(withoutKey, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * If config.json still carries a legacy key, moves it into the key file
 * and rewrites config.json without it. Idempotent: a config already free of
 * the legacy field is a no-op. Returns whether a migration happened.
 */
export function migrateLegacyKey(): boolean {
  const config = loadConfig();
  if (!config.openrouterApiKey) return false;
  saveConfig(config);
  return true;
}

export type KeySource = "env" | "file" | "config" | "none";

/** Which source `resolveOpenRouterKey` will read from, for status/health UIs. */
export function keySource(config: Config): KeySource {
  if (process.env.OPENROUTER_API_KEY) return "env";
  if (readKeyFile() !== undefined) return "file";
  if (config.openrouterApiKey) return "config";
  return "none";
}

/**
 * Resolution order: env var, then the key file, then the legacy
 * config.json field (read-only, for backward compatibility with a config
 * saved before this version existed — `saveConfig` migrates it out).
 */
export function resolveOpenRouterKey(config: Config): string | undefined {
  return process.env.OPENROUTER_API_KEY ?? readKeyFile() ?? config.openrouterApiKey;
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
