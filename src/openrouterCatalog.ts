import type { Config } from "./config.js";

export interface CatalogModel {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
}

interface RawCatalogModel {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
}

export async function fetchCatalog(config: Config): Promise<CatalogModel[]> {
  const response = await fetch(`${config.openrouterBaseUrl}/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model listesi alinamadi (HTTP ${response.status}).`);
  }

  const json = (await response.json()) as { data?: RawCatalogModel[] };
  return (json.data ?? [])
    .filter((model): model is RawCatalogModel & { id: string } => typeof model.id === "string")
    .map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      contextLength: model.top_provider?.context_length ?? model.context_length,
      maxCompletionTokens: model.top_provider?.max_completion_tokens,
    }));
}

export function searchCatalog(models: CatalogModel[], query: string): CatalogModel[] {
  const needle = query.toLowerCase();
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) ||
      (model.name ?? "").toLowerCase().includes(needle),
  );
}

/** First sentence only — the picker collapses a description to one line. */
export function shortDescription(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) return undefined;
  const sentence = firstLine.split(". ")[0] ?? firstLine;
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence;
}

export interface ProviderEndpoint {
  providerName: string;
  promptPrice: number;
  completionPrice: number;
  contextLength?: number;
  quantization?: string;
}

/** The providers serving one model, cheapest first. */
export async function fetchEndpoints(
  config: Config,
  modelId: string,
): Promise<ProviderEndpoint[]> {
  const response = await fetch(`${config.openrouterBaseUrl}/models/${modelId}/endpoints`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Saglayici listesi alinamadi (HTTP ${response.status}).`);
  }

  const json = (await response.json()) as {
    data?: {
      endpoints?: {
        provider_name?: string;
        context_length?: number;
        quantization?: string;
        pricing?: { prompt?: string; completion?: string };
      }[];
    };
  };

  return (json.data?.endpoints ?? [])
    .map((endpoint) => ({
      providerName: endpoint.provider_name ?? "?",
      promptPrice: Number(endpoint.pricing?.prompt ?? 0) * 1e6,
      completionPrice: Number(endpoint.pricing?.completion ?? 0) * 1e6,
      contextLength: endpoint.context_length,
      quantization: endpoint.quantization,
    }))
    .sort((a, b) => a.promptPrice - b.promptPrice);
}
