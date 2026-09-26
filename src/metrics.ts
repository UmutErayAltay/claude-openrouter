/**
 * In-memory Prometheus exposition for the proxy — no dependency, matching
 * the project's zero-runtime-dependency policy. State resets on restart;
 * that's fine for a scrape target, not meant to be a durable log (usage.jsonl
 * already is).
 */

export type RequestOutcome = "ok" | "upstream_error" | "network_error" | "no_key" | "stream_error";

/** Keyed by outcome so adding one to RequestOutcome without listing it here is a type error. */
const OUTCOMES: Record<RequestOutcome, true> = {
  ok: true,
  upstream_error: true,
  network_error: true,
  no_key: true,
  stream_error: true,
};
const OUTCOME_LIST = Object.keys(OUTCOMES) as RequestOutcome[];

interface TokenTotals {
  prompt: number;
  completion: number;
  reasoning: number;
  cached: number;
}

/** Seconds; covers a fast tool-call round trip up through a long reasoning turn. */
const DURATION_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

const KEY_SEP = "\u0000";

const requestsTotal = new Map<string, number>();
const durationSum = new Map<string, number>();
const durationCount = new Map<string, number>();
/** Cumulative counts per bucket, Prometheus-style: bucket[i] counts every observation <= its boundary. */
const durationBuckets = new Map<string, number[]>();
const tokensByModel = new Map<string, TokenTotals>();
const costByModel = new Map<string, number>();

export function recordRequest(params: {
  model: string;
  outcome: RequestOutcome;
  durationSeconds: number;
}): void {
  const { model, outcome, durationSeconds } = params;

  const reqKey = model + KEY_SEP + outcome;
  requestsTotal.set(reqKey, (requestsTotal.get(reqKey) ?? 0) + 1);

  durationSum.set(model, (durationSum.get(model) ?? 0) + durationSeconds);
  durationCount.set(model, (durationCount.get(model) ?? 0) + 1);

  let buckets = durationBuckets.get(model);
  if (!buckets) {
    buckets = new Array(DURATION_BUCKETS.length).fill(0) as number[];
    durationBuckets.set(model, buckets);
  }
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (durationSeconds <= (DURATION_BUCKETS[i] as number)) {
      buckets[i] = (buckets[i] ?? 0) + 1;
    }
  }
}

/** Fed by the same recordUsage entry that goes to usage.jsonl. */
export function recordUsageMetrics(entry: {
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cost: number | null;
}): void {
  const totals = tokensByModel.get(entry.model) ?? {
    prompt: 0,
    completion: 0,
    reasoning: 0,
    cached: 0,
  };
  totals.prompt += entry.promptTokens;
  totals.completion += entry.completionTokens;
  totals.reasoning += entry.reasoningTokens ?? 0;
  totals.cached += entry.cachedTokens ?? 0;
  tokensByModel.set(entry.model, totals);

  if (entry.cost) {
    costByModel.set(entry.model, (costByModel.get(entry.model) ?? 0) + entry.cost);
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderMetrics(): string {
  const lines: string[] = [];

  lines.push("# HELP cor_requests_total Total OpenRouter requests handled by the proxy.");
  lines.push("# TYPE cor_requests_total counter");
  for (const [k, count] of requestsTotal) {
    const [model, outcome] = k.split(KEY_SEP);
    lines.push(
      `cor_requests_total{model="${escapeLabel(model as string)}",outcome="${escapeLabel(outcome as string)}"} ${count}`,
    );
  }

  lines.push("# HELP cor_request_duration_seconds Duration of OpenRouter requests, in seconds.");
  lines.push("# TYPE cor_request_duration_seconds histogram");
  for (const [model, buckets] of durationBuckets) {
    const escaped = escapeLabel(model);
    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      lines.push(
        `cor_request_duration_seconds_bucket{model="${escaped}",le="${DURATION_BUCKETS[i]}"} ${buckets[i]}`,
      );
    }
    const total = durationCount.get(model) ?? 0;
    lines.push(`cor_request_duration_seconds_bucket{model="${escaped}",le="+Inf"} ${total}`);
    lines.push(`cor_request_duration_seconds_sum{model="${escaped}"} ${durationSum.get(model) ?? 0}`);
    lines.push(`cor_request_duration_seconds_count{model="${escaped}"} ${total}`);
  }

  lines.push("# HELP cor_tokens_total Tokens counted per model and type.");
  lines.push("# TYPE cor_tokens_total counter");
  for (const [model, totals] of tokensByModel) {
    const escaped = escapeLabel(model);
    lines.push(`cor_tokens_total{model="${escaped}",type="prompt"} ${totals.prompt}`);
    lines.push(`cor_tokens_total{model="${escaped}",type="completion"} ${totals.completion}`);
    lines.push(`cor_tokens_total{model="${escaped}",type="reasoning"} ${totals.reasoning}`);
    lines.push(`cor_tokens_total{model="${escaped}",type="cached"} ${totals.cached}`);
  }

  lines.push("# HELP cor_cost_usd_total Dollar cost billed by OpenRouter, per model.");
  lines.push("# TYPE cor_cost_usd_total counter");
  for (const [model, cost] of costByModel) {
    lines.push(`cor_cost_usd_total{model="${escapeLabel(model)}"} ${cost}`);
  }

  return lines.join("\n") + "\n";
}

export interface ModelMetricsSummary {
  model: string;
  requests: Record<RequestOutcome, number>;
  total: number;
  avgDurationSeconds: number | null;
  p50Seconds: number | null;
  p95Seconds: number | null;
}

export interface MetricsSummary {
  models: ModelMetricsSummary[];
  totals: { ok: number; errors: number; total: number; successRate: number | null };
}

/**
 * Quantile off the cumulative histogram: the boundary of the first bucket whose
 * count reaches target, falling back to the widest bucket when even that
 * doesn't add up (shouldn't happen, but a null-free number beats a wrong one).
 */
function quantileFromBuckets(buckets: number[], total: number, quantile: number): number | null {
  if (total <= 0) return null;
  const target = total * quantile;
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if ((buckets[i] ?? 0) >= target) return DURATION_BUCKETS[i] as number;
  }
  return DURATION_BUCKETS[DURATION_BUCKETS.length - 1] as number;
}

/** JSON view of the same counters renderMetrics exposes, for the dashboard. */
export function getMetricsSummary(): MetricsSummary {
  const models = new Set<string>();
  for (const key of requestsTotal.keys()) {
    models.add(key.slice(0, key.indexOf(KEY_SEP)));
  }
  for (const model of durationBuckets.keys()) {
    models.add(model);
  }

  const summaries: ModelMetricsSummary[] = [...models].sort().map((model) => {
    const requests = Object.fromEntries(
      OUTCOME_LIST.map((outcome) => [outcome, requestsTotal.get(model + KEY_SEP + outcome) ?? 0]),
    ) as Record<RequestOutcome, number>;
    const total = OUTCOME_LIST.reduce((sum, outcome) => sum + (requests[outcome] ?? 0), 0);
    const count = durationCount.get(model) ?? 0;

    return {
      model,
      requests,
      total,
      avgDurationSeconds: count > 0 ? (durationSum.get(model) ?? 0) / count : null,
      p50Seconds: quantileFromBuckets(durationBuckets.get(model) ?? [], count, 0.5),
      p95Seconds: quantileFromBuckets(durationBuckets.get(model) ?? [], count, 0.95),
    };
  });

  const ok = summaries.reduce((sum, entry) => sum + (entry.requests.ok ?? 0), 0);
  const total = summaries.reduce((sum, entry) => sum + entry.total, 0);

  return {
    models: summaries,
    totals: { ok, errors: total - ok, total, successRate: total > 0 ? ok / total : null },
  };
}

/** Test-only: clears every counter so one test's numbers don't bleed into the next. */
export function resetMetrics(): void {
  requestsTotal.clear();
  durationSum.clear();
  durationCount.clear();
  durationBuckets.clear();
  tokensByModel.clear();
  costByModel.clear();
}
