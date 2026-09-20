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
   * Optional Claude model id to borrow capabilities from, written to the
   * picker row. It silences Claude Code's "not in this version's model
   * catalog" warning; the proxy strips the Anthropic-only fields it unlocks.
   */
  behavesAs?: string;
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
