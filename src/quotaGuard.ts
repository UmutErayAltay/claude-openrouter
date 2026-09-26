/**
 * Tracks OpenRouter's account-wide daily quota for `:free` models, entirely
 * client-side. The proxy has no way to poll the real remaining count without
 * spending a request on it, so instead it infers exhaustion from the one
 * error OpenRouter sends when the quota is hit ("free-models-per-day") and
 * assumes it holds until the next UTC day — the same boundary OpenRouter
 * itself resets the counter on. This is best-effort: it can't know the quota
 * is fresh again mid-day if OpenRouter ever changes that, but it also can't
 * be wrong in the unsafe direction (a stale "exhausted" flag just means one
 * extra day of routing to the fallback, never a silent double-spend).
 */

let exhaustedOnDay: string | null = null;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Records that a `:free` request was just rejected for the daily quota. */
export function markFreeQuotaExhausted(now: number = Date.now()): void {
  exhaustedOnDay = utcDay(now);
}

/** True once markFreeQuotaExhausted fired today (UTC); resets itself the next day. */
export function isFreeQuotaExhausted(now: number = Date.now()): boolean {
  return exhaustedOnDay !== null && exhaustedOnDay === utcDay(now);
}

/** JSON-friendly view for the dashboard's health check. */
export function getFreeQuotaState(now: number = Date.now()): { exhausted: boolean } {
  return { exhausted: isFreeQuotaExhausted(now) };
}

/** Matches OpenRouter's own wording for the account-wide daily `:free` cap. */
export function looksLikeFreeQuotaError(message: string): boolean {
  return /free-models-per-day/i.test(message);
}

/** Test-only: clears the flag regardless of what day it was set on. */
export function resetFreeQuotaGuard(): void {
  exhaustedOnDay = null;
}
