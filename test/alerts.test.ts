import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateAlerts, getAlertState, resetAlertState } from "../src/alerts.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import type { MetricsSummary, TimelineBucket } from "../src/metrics.js";

const NOW = new Date("2026-09-26T12:00:00Z").getTime();
const HOUR_MS = 60 * 60 * 1000;
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAlertState();
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalDir;
  void originalFetch;
});

/** One timeline bucket covering the requests that happened inside the last hour. */
function recentBucket(count: number, hourStart: number = NOW - 30 * 60 * 1000): TimelineBucket {
  return { model: "openai/gpt-5", hourStart, count, errors: count, p50Seconds: 1, p95Seconds: 1 };
}

function summaryWith(errorRate1h: number | null, count: number, bucket = recentBucket(count)): MetricsSummary {
  return {
    models: [],
    totals: { ok: 0, errors: 0, total: 0, successRate: null, errorRate1h },
    recentErrors: [],
    timeline: count > 0 ? [bucket] : [],
  };
}

function config(alerts?: Config["alerts"]): Config {
  return { ...DEFAULT_CONFIG, alerts };
}

function sentBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as { body: string }).body)));
}

describe("evaluateAlerts", () => {
  it("never calls the network when no webhook is configured", async () => {
    await evaluateAlerts(config(), summaryWith(1, 20), NOW);
    await evaluateAlerts(config({ errorRatePct: 10 }), summaryWith(1, 20), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("stays quiet while the error rate is below the threshold", async () => {
    const alerts = { webhookUrl: WEBHOOK, errorRatePct: 50 };

    await evaluateAlerts(config(alerts), summaryWith(0.49, 20), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("stays quiet when nothing was requested in the last hour", async () => {
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 0), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fire off fewer than five requests, however bad the rate", async () => {
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(1, 4), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAlertState().lastFiredAt).toBeNull();
  });

  it("ignores requests that fell out of the one-hour window", async () => {
    // Six requests an hour and a half ago, none in the window: a real old outage
    // is not an alert.
    const stale = recentBucket(6, NOW - 90 * 60 * 1000);

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(1, 6, stale), NOW);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the webhook exactly once when the threshold is crossed", async () => {
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.6, 10), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
  });

  it("puts the reason in the JSON body", async () => {
    await evaluateAlerts(
      config({ webhookUrl: WEBHOOK, errorRatePct: 25 }),
      summaryWith(0.6, 10),
      NOW,
    );

    const [body] = sentBodies();
    expect(typeof body?.reason).toBe("string");
    expect(body?.reason as string).toContain("%60.0");
    expect(body?.reason as string).toContain("%25");
    expect(body).toMatchObject({ source: "cor", window: "1h", errorRate: 0.6, at: NOW });
  });

  it("defaults the threshold to 25% when the config doesn't set one", async () => {
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.24, 10), NOW);
    expect(fetchMock).not.toHaveBeenCalled();

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.25, 10), NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts requests across every bucket that overlaps the window", async () => {
    const summary: MetricsSummary = {
      ...summaryWith(0.5, 0),
      timeline: [recentBucket(2), recentBucket(3, NOW - 50 * 60 * 1000)],
    };

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summary, NOW);

    // 2 + 3 = 5, so the minimum-sample gate is met exactly.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles to once a quarter hour", async () => {
    const alerts = { webhookUrl: WEBHOOK };

    await evaluateAlerts(config(alerts), summaryWith(0.9, 10), NOW);
    await evaluateAlerts(config(alerts), summaryWith(0.9, 10), NOW + 14 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires again once the throttle has elapsed", async () => {
    const alerts = { webhookUrl: WEBHOOK };

    await evaluateAlerts(config(alerts), summaryWith(0.9, 10), NOW);
    await evaluateAlerts(config(alerts), summaryWith(0.9, 10), NOW + 16 * 60 * 1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records the fire time and reason in the state it exposes", async () => {
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW);

    const state = getAlertState();
    expect(state.lastFiredAt).toBe(NOW);
    expect(state.lastReason).toBeTruthy();
    expect(state.lastError).toBeNull();
  });
});

describe("evaluateAlerts delivery failures", () => {
  it("swallows a network failure and records it in lastError", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW),
    ).resolves.toBeUndefined();

    const state = getAlertState();
    expect(state.lastError).toContain("ECONNREFUSED");
    // The attempt still counts, so a dead webhook can't be retried in a loop.
    expect(state.lastFiredAt).toBe(NOW);
  });

  it("treats a non-2xx response as a failed delivery", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(
      evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW),
    ).resolves.toBeUndefined();

    expect(getAlertState().lastError).toContain("500");
  });

  it("clears a previous error once a delivery succeeds", async () => {
    fetchMock.mockRejectedValue(new Error("kapali"));
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW);
    expect(getAlertState().lastError).toBeTruthy();

    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW + 20 * 60 * 1000);

    expect(getAlertState().lastError).toBeNull();
  });
});

describe("resetAlertState", () => {
  it("clears the throttle so the next call fires immediately", async () => {
    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW);
    expect(getAlertState().lastFiredAt).toBe(NOW);

    resetAlertState();
    expect(getAlertState()).toEqual({ lastFiredAt: null, lastReason: null, lastError: null });

    await evaluateAlerts(config({ webhookUrl: WEBHOOK }), summaryWith(0.9, 10), NOW + 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
