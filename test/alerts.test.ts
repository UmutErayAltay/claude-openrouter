import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateAlerts, getAlertState, resetAlertState } from "../src/alerts.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { getMetricsSummary, recordRequest, resetMetrics, type MetricsSummary, type RequestOutcome } from "../src/metrics.js";

const NOW = new Date("2026-09-26T12:00:00Z").getTime();
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEBHOOK = "https://hooks.example.test/cor";

let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
const originalDir = process.env.CLAUDE_OPENROUTER_DIR;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cor-alerts-"));
  process.env.CLAUDE_OPENROUTER_DIR = dir;
  delete process.env.OPENROUTER_API_KEY;

  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  // The delivery failure path logs on purpose; keep the suite output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetAlertState();
  resetMetrics();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAlertState();
  resetMetrics();
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalDir;
  void originalFetch;
});

/**
 * evaluateAlerts reads its own window off the recorded requests; the summary it
 * is handed is what the server passes in, not the source of the numbers.
 */
function summary(): MetricsSummary {
  return getMetricsSummary();
}

function record(outcome: RequestOutcome, ts: number, durationSeconds = 1): void {
  recordRequest({ model: "openai/gpt-5", outcome, durationSeconds, ts });
}

/** Ten requests `count - failures` of them fine, so a specific error rate lands. */
function window(failures: number, count = 10, at = NOW - 30 * MINUTE_MS): void {
  for (let i = 0; i < count; i++) {
    record(i < failures ? "upstream_error" : "ok", at);
  }
}

function config(alerts?: Config["alerts"]): Config {
  return { ...DEFAULT_CONFIG, alerts };
}

function sentBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as { body: string }).body)));
}

describe("evaluateAlerts", () => {
  it("never calls the network when no webhook is configured", async () => {
    window(6);
    await evaluateAlerts(config(), summary(), NOW);
    await evaluateAlerts(config({ errorRatePct: 10 }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("stays quiet while the error rate is below the threshold", async () => {
    window(4, 10);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, errorRatePct: 50 }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("stays quiet when nothing was requested in the window", async () => {
    window(9, 10, NOW - 2 * HOUR_MS);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire off fewer than five requests, however bad the rate", async () => {
    window(4, 4);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("ignores requests that fell out of the one-hour window", async () => {
    // Six requests an hour and a half ago, none in the window: a real old outage
    // is not an alert.
    window(6, 6, NOW - 90 * MINUTE_MS);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the webhook exactly once when the threshold is crossed", async () => {
    window(6);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
  });

  it("puts the reason in the JSON body", async () => {
    window(4, 10);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, errorRatePct: 25 }), summary(), NOW);

    const [body] = sentBodies();
    expect(typeof body?.reason).toBe("string");
    expect(body?.reason as string).toContain("%40.0");
    expect(body?.reason as string).toContain("%25");
    expect(body?.reason as string).toContain("Son 60 dakikada");
    expect(body).toMatchObject({
      source: "cor",
      metric: "error_rate",
      window: "60m",
      errorRate: 0.4,
      at: NOW,
    });
  });

  it("defaults the threshold to 25% when the config doesn't set one", async () => {
    window(2, 10);
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);
    expect(fetchMock).not.toHaveBeenCalled();

    resetAlertState();
    window(8, 10);
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts every request in the window, not just the current hour bucket", async () => {
    // 3 failures 50 minutes ago and 2 more 90 minutes ago: five is exactly the
    // minimum sample, and the 90-minute-old ones only count in a 2h window.
    window(3, 3, NOW - 50 * MINUTE_MS);
    window(2, 2, NOW - 90 * MINUTE_MS);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, windowMinutes: 120 }), summary(), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles to once a quarter hour", async () => {
    const alerts = { webhookUrl: WEBHOOK };
    window(9);

    await evaluateAlerts(config(alerts), summary(), NOW);
    await evaluateAlerts(config(alerts), summary(), NOW + 14 * MINUTE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires again once the throttle has elapsed", async () => {
    const alerts = { webhookUrl: WEBHOOK };
    window(9);

    await evaluateAlerts(config(alerts), summary(), NOW);
    await evaluateAlerts(config(alerts), summary(), NOW + 16 * MINUTE_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records the fire time and reason in the state it exposes", async () => {
    window(9);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);

    const state = getAlertState();
    expect(state.lastFiredAt).toBe(NOW);
    expect(state.lastReason).toBeTruthy();
    expect(state.lastError).toBeNull();
  });
});

describe("evaluateAlerts latency threshold", () => {
  it("fires on a slow p95 and says so", async () => {
    // All ten succeeded, just far too slowly: nothing for the error rate to
    // complain about.
    for (let i = 0; i < 10; i++) {
      record("ok", NOW - 10 * MINUTE_MS, 30);
    }

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, latencyP95Seconds: 5 }), summary(), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [body] = sentBodies();
    expect(body?.metric).toBe("latency_p95");
    expect(body?.window).toBe("60m");
    expect(body?.errorRate).toBe(0);
    expect(body?.p95Seconds).toBe(30);
    const reason = body?.reason as string;
    expect(reason).toContain("p95 gecikme 30.0s");
    expect(reason).toContain("(esik 5s)");
    expect(reason).toContain("Son 60 dakikada");
    expect(getAlertState().lastReason).toBe(reason);
  });

  it("stays quiet under the latency threshold", async () => {
    for (let i = 0; i < 10; i++) {
      record("ok", NOW - 10 * MINUTE_MS, 1);
    }

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, latencyP95Seconds: 5 }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never fires on latency when the config doesn't set a threshold", async () => {
    // Ninety-second responses, all successful, and no latencyP95Seconds: an
    // unset threshold is no opinion, not a zero-second one.
    for (let i = 0; i < 10; i++) {
      record("ok", NOW - 10 * MINUTE_MS, 90);
    }

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);
    await evaluateAlerts(config({ webhookUrl: WEBHOOK, windowMinutes: 120 }), summary(), NOW);
    await evaluateAlerts(config({ webhookUrl: WEBHOOK, errorRatePct: 90 }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("still runs the error-rate path when no latency threshold is set", async () => {
    window(8);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);

    const [body] = sentBodies();
    expect(body?.metric).toBe("error_rate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("has no p95 to judge when nothing in the window succeeded", async () => {
    window(10, 10, NOW - 10 * MINUTE_MS);

    await evaluateAlerts(
      config({ webhookUrl: WEBHOOK, latencyP95Seconds: 0, errorRatePct: 100 }),
      summary(),
      NOW,
    );

    // The error rate is the one that can fire here: there is no successful
    // request to take a latency from.
    const [body] = sentBodies();
    expect(body?.metric).toBe("error_rate");
    expect(body?.p95Seconds).toBeNull();
  });

  it("reports only the error rate when both thresholds are crossed", async () => {
    for (let i = 0; i < 4; i++) {
      record("ok", NOW - 10 * MINUTE_MS, 30);
    }
    for (let i = 0; i < 6; i++) {
      record("upstream_error", NOW - 10 * MINUTE_MS, 30);
    }

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, latencyP95Seconds: 5 }), summary(), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [body] = sentBodies();
    expect(body?.metric).toBe("error_rate");
    expect(body?.reason as string).toContain("istek basarisi %60.0");
    expect(body?.reason as string).not.toContain("p95 gecikme");
  });

  it("counts blocked zero-duration requests as failures without inventing a latency", async () => {
    record("ok", NOW - 10 * MINUTE_MS, 2);
    record("budget_blocked", NOW - 10 * MINUTE_MS, 0);
    record("quota_exhausted", NOW - 10 * MINUTE_MS, 0);
    record("price_drift_blocked", NOW - 10 * MINUTE_MS, 0);
    record("upstream_error", NOW - 10 * MINUTE_MS, 1);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, latencyP95Seconds: 1 }), summary(), NOW);

    // Four of five failed; p95 is the lone 2s success, which clears 1s, so the
    // error rate is what fires and it reports the real p95 alongside.
    const [body] = sentBodies();
    expect(body?.metric).toBe("error_rate");
    expect(body?.errorRate).toBe(0.8);
    expect(body?.p95Seconds).toBe(2);
  });
});

describe("evaluateAlerts window", () => {
  it("counts a request just outside the default hour once the window is widened", async () => {
    // Six failures 90 minutes ago: an alert under a 2h window, silence under
    // the default 60.
    window(6, 6, NOW - 90 * MINUTE_MS);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);
    expect(fetchMock).not.toHaveBeenCalled();

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, windowMinutes: 120 }), summary(), NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [body] = sentBodies();
    expect(body?.window).toBe("120m");
    expect(body?.errorRate).toBe(1);
    expect(body?.reason as string).toContain("Son 120 dakikada");
  });

  it("narrows the window when a shorter one is configured", async () => {
    window(6, 6, NOW - 40 * MINUTE_MS);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, windowMinutes: 15 }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies the window to the minimum-sample gate too", async () => {
    // Four requests, the gate is five, so a narrow window that keeps all four
    // is silent even though every one of them failed.
    window(4, 4, NOW - 5 * MINUTE_MS);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK, windowMinutes: 10 }), summary(), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("evaluateAlerts delivery failures", () => {
  it("swallows a network failure and records it in lastError", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    window(9);

    await expect(evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW)).resolves.toBeUndefined();

    const state = getAlertState();
    expect(state.lastError).toContain("ECONNREFUSED");
    // The attempt still counts, so a dead webhook can't be retried in a loop.
    expect(state.lastFiredAt).toBe(NOW);
  });

  it("treats a non-2xx response as a failed delivery", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    window(9);

    await expect(evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW)).resolves.toBeUndefined();

    expect(getAlertState().lastError).toContain("500");
  });

  it("clears a previous error once a delivery succeeds", async () => {
    window(9);
    fetchMock.mockRejectedValue(new Error("kapali"));
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);
    expect(getAlertState().lastError).toBeTruthy();

    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW + 20 * MINUTE_MS);

    expect(getAlertState().lastError).toBeNull();
  });
});

describe("resetAlertState", () => {
  it("clears the throttle so the next call fires immediately", async () => {
    window(9);
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW);
    expect(getAlertState().lastFiredAt).toBe(NOW);

    resetAlertState();
    expect(getAlertState()).toEqual({ lastFiredAt: null, lastReason: null, lastError: null });

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary(), NOW + MINUTE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
