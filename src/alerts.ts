import type { Config } from "./config.js";
import { getWindowedMetrics, type MetricsSummary } from "./metrics.js";

export interface AlertState {
  lastFiredAt: number | null;
  lastReason: string | null;
  lastError: string | null;
}

/** Default error-rate threshold, in percent, when the config doesn't set one. */
const DEFAULT_ERROR_RATE_PCT = 25;

/** A rate off a handful of requests is noise; wait for a real sample. */
const MIN_REQUESTS = 5;

/** The most this can fire is once a quarter hour, so a bad hour doesn't spam. */
const MIN_INTERVAL_MS = 15 * 60 * 1000;

const ALERT_TIMEOUT_MS = 10_000;

const state: AlertState = { lastFiredAt: null, lastReason: null, lastError: null };

export function getAlertState(): AlertState {
  return { ...state };
}

/**
 * Fires a webhook when the configured window's failure rate or p95 latency
 * crosses its threshold. The latency check only runs when the config sets
 * latencyP95Seconds: no threshold means no opinion about how slow is too slow.
 * Best-effort by design: a proxy request that succeeds upstream must not fail
 * because a chat webhook is unreachable, so a delivery failure is recorded and
 * swallowed.
 */
export async function evaluateAlerts(
  config: Config,
  summary: MetricsSummary,
  now: number,
): Promise<void> {
  void summary;
  const webhookUrl = config.alerts?.webhookUrl;
  if (!webhookUrl) return;

  const windowMinutes = config.alerts?.windowMinutes ?? 60;
  const { errorRate, p95Seconds, requestCount } = getWindowedMetrics(windowMinutes * 60_000, now);
  if (requestCount < MIN_REQUESTS) return;

  const thresholdPct = config.alerts?.errorRatePct ?? DEFAULT_ERROR_RATE_PCT;
  const errorRatePct = errorRate === null ? null : errorRate * 100;
  const latencyThreshold = config.alerts?.latencyP95Seconds;
  const errorRateBreached = errorRatePct !== null && errorRatePct >= thresholdPct;
  const latencyBreached = latencyThreshold !== undefined && p95Seconds !== null && p95Seconds >= latencyThreshold;
  // A bad hour that is also a slow hour reports as the error rate: it's the
  // upstream breaking, and one alert is enough to act on.
  if (!errorRateBreached && !latencyBreached) return;

  if (state.lastFiredAt !== null && now - state.lastFiredAt < MIN_INTERVAL_MS) return;

  const metric: "error_rate" | "latency_p95" = errorRateBreached ? "error_rate" : "latency_p95";
  const reason = errorRateBreached
    ? `Son ${windowMinutes} dakikada istek basarisi %${(errorRatePct as number).toFixed(1)} (esik %${thresholdPct})`
    : `Son ${windowMinutes} dakikada p95 gecikme ${(p95Seconds as number).toFixed(1)}s (esik ${latencyThreshold}s)`;
  state.lastFiredAt = now;
  state.lastReason = reason;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "cor",
        metric,
        reason,
        window: `${windowMinutes}m`,
        errorRate,
        p95Seconds,
        at: now,
      }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    state.lastError = null;
  } catch (err) {
    state.lastError = `cor: alarm webhook'i gonderilemedi: ${(err as Error).message}`;
    console.error(state.lastError);
  }
}

/** Test-only: clears the throttle so the next call can fire immediately. */
export function resetAlertState(): void {
  state.lastFiredAt = null;
  state.lastReason = null;
  state.lastError = null;
}
