import type { Config } from "./config.js";
import type { MetricsSummary } from "./metrics.js";

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
 * Fires a webhook when the last hour's failure rate is bad enough to be worth
 * waking someone for. Best-effort by design: a proxy request that succeeds
 * upstream must not fail because a chat webhook is unreachable, so a delivery
 * failure is recorded and swallowed.
 */
export async function evaluateAlerts(
  config: Config,
  summary: MetricsSummary,
  now: number,
): Promise<void> {
  const webhookUrl = config.alerts?.webhookUrl;
  if (!webhookUrl) return;

  const errorRate1h = summary.totals.errorRate1h;
  if (errorRate1h === null) return;

  const thresholdPct = config.alerts?.errorRatePct ?? DEFAULT_ERROR_RATE_PCT;
  const errorRatePct = errorRate1h * 100;
  if (errorRatePct < thresholdPct) return;

  const hourAgo = now - 60 * 60 * 1000;
  const requestsInWindow = summary.timeline
    .filter((bucket) => bucket.hourStart >= hourAgo)
    .reduce((sum, bucket) => sum + bucket.count, 0);
  if (requestsInWindow < MIN_REQUESTS) return;

  if (state.lastFiredAt !== null && now - state.lastFiredAt < MIN_INTERVAL_MS) return;

  const reason = `Son 1 saatte istek basarisi %${errorRatePct.toFixed(1)} (esik %${thresholdPct})`;
  state.lastFiredAt = now;
  state.lastReason = reason;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "cor",
        reason,
        errorRate: errorRate1h,
        window: "1h",
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
