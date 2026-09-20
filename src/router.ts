import { findModel, type Config, type ModelEntry } from "./config.js";

export type Route =
  | { target: "openrouter"; entry: ModelEntry }
  | { target: "anthropic" };

/**
 * Only the models the user added explicitly go to OpenRouter. Everything else
 * — Claude ids, the built-in aliases, anything Claude Code invents for a
 * background task — is passed through to the real Anthropic API untouched, so
 * the existing login keeps working exactly as before.
 */
export function routeFor(config: Config, model: unknown): Route {
  if (typeof model === "string") {
    const entry = findModel(config, model);
    if (entry) return { target: "openrouter", entry };

    // Claude Code appends [1m] to request the 1M context window; the base id
    // is what the user configured.
    const base = model.replace(/\[1m\]$/, "");
    const baseEntry = findModel(config, base);
    if (baseEntry) return { target: "openrouter", entry: baseEntry };
  }
  return { target: "anthropic" };
}
