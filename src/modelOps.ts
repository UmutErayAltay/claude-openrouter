import {
  findModel,
  isProviderSort,
  isReasoningEffort,
  type Config,
  type ModelEntry,
  type ProviderSort,
  type ReasoningEffort,
} from "./config.js";
import { fetchCatalog, shortDescription } from "./openrouterCatalog.js";

export class ModelOpError extends Error {}

/**
 * Shared shape for both `cor add`/`cor update` (CLI flags, already converted
 * to real types) and the dashboard's JSON API. `undefined` means "leave this
 * field alone" on an update; `null` means "clear it".
 */
export interface ModelInput {
  label?: string | null;
  description?: string | null;
  contextTokens?: number | null;
  maxOutputTokens?: number | null;
  behavesAs?: string | null;
  stream?: boolean | null;
  reasoning?: string | null;
  providerSort?: string | null;
  maxPrice?: { prompt?: number; completion?: number } | null;
  quantizations?: string[] | null;
}

function validateReasoning(value: string | null | undefined): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isReasoningEffort(value)) {
    throw new ModelOpError(
      `Gecersiz reasoning degeri: ${value}. none, low, medium, high veya max.`,
    );
  }
  return value;
}

function validateSort(value: string | null | undefined): ProviderSort | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isProviderSort(value)) {
    throw new ModelOpError(`Gecersiz sort degeri: ${value}. price, throughput veya latency.`);
  }
  return value;
}

/** Builds a brand new entry from an input — used by `add`, before autofill. */
export function buildModelEntry(id: string, input: ModelInput = {}): ModelEntry {
  const entry: ModelEntry = { id };
  if (input.label) entry.label = input.label;
  if (input.description) entry.description = input.description;
  if (typeof input.contextTokens === "number") entry.contextTokens = input.contextTokens;
  if (typeof input.maxOutputTokens === "number") entry.maxOutputTokens = input.maxOutputTokens;
  if (input.behavesAs) entry.behavesAs = input.behavesAs;
  if (typeof input.stream === "boolean") entry.stream = input.stream;

  const reasoning = validateReasoning(input.reasoning);
  if (reasoning) entry.reasoning = reasoning;

  const providerSort = validateSort(input.providerSort);
  if (providerSort) entry.providerSort = providerSort;

  if (input.maxPrice) entry.maxPrice = input.maxPrice;
  if (input.quantizations?.length) entry.quantizations = input.quantizations;

  return entry;
}

/**
 * Applies a partial edit to an existing entry. Returns a new object — the
 * caller is responsible for putting it back into `config.models` (Object.assign
 * can't remove a key a `null` patch cleared, so this always builds fresh).
 */
export function mergeModelEntry(existing: ModelEntry, patch: ModelInput): ModelEntry {
  const merged: ModelEntry = { ...existing };

  const apply = <K extends keyof ModelEntry>(key: K, value: ModelEntry[K] | null | undefined) => {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  };

  apply("label", patch.label ?? undefined);
  apply("description", patch.description ?? undefined);
  apply("contextTokens", patch.contextTokens ?? undefined);
  apply("maxOutputTokens", patch.maxOutputTokens ?? undefined);
  apply("behavesAs", patch.behavesAs ?? undefined);
  apply("stream", patch.stream ?? undefined);
  apply("maxPrice", patch.maxPrice ?? undefined);
  apply("quantizations", patch.quantizations);

  if (patch.reasoning === null) delete merged.reasoning;
  else {
    const reasoning = validateReasoning(patch.reasoning);
    if (reasoning) merged.reasoning = reasoning;
  }

  if (patch.providerSort === null) delete merged.providerSort;
  else {
    const providerSort = validateSort(patch.providerSort);
    if (providerSort) merged.providerSort = providerSort;
  }

  return merged;
}

export type CatalogAutofillStatus = "filled" | "not_found" | "catalog_error";

export interface AutofillResult {
  entry: ModelEntry;
  status: CatalogAutofillStatus;
  errorMessage?: string;
}

/**
 * Fills label/description/contextTokens/maxOutputTokens from the OpenRouter
 * catalog, but only where the entry doesn't already have a value. Best-effort:
 * a network failure is reported in the result, never thrown.
 */
export async function autofillFromCatalog(config: Config, entry: ModelEntry): Promise<AutofillResult> {
  try {
    const catalog = await fetchCatalog(config);
    const match = catalog.find((model) => model.id === entry.id);
    if (!match) return { entry, status: "not_found" };

    const filled: ModelEntry = { ...entry };
    filled.label ??= match.name ?? entry.id;
    filled.description ??= shortDescription(match.description);
    filled.contextTokens ??= match.contextLength;
    filled.maxOutputTokens ??= match.maxCompletionTokens;
    return { entry: filled, status: "filled" };
  } catch (err) {
    return { entry, status: "catalog_error", errorMessage: (err as Error).message };
  }
}

/**
 * Adds a new model to `config.models` (mutated in place; the caller saves).
 * Throws ModelOpError if the id is already configured.
 */
export async function addModel(
  config: Config,
  id: string,
  input: ModelInput = {},
): Promise<AutofillResult> {
  if (findModel(config, id)) {
    throw new ModelOpError(`${id} zaten ekli.`);
  }

  const built = buildModelEntry(id, input);
  const result = await autofillFromCatalog(config, built);
  config.models.push(result.entry);
  return result;
}

/** Replaces the entry for `id`. Throws ModelOpError if it isn't configured. */
export function updateModel(config: Config, id: string, patch: ModelInput): ModelEntry {
  const index = config.models.findIndex((model) => model.id === id);
  if (index === -1) throw new ModelOpError(`${id} ekli degil.`);

  const merged = mergeModelEntry(config.models[index] as ModelEntry, patch);
  config.models[index] = merged;
  return merged;
}

/** Removes the entry for `id`. Returns whether anything was removed. */
export function removeModel(config: Config, id: string): boolean {
  const before = config.models.length;
  config.models = config.models.filter((model) => model.id !== id);
  return config.models.length !== before;
}
