import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMetricsSummary,
  getRecentRequests,
  recordRequest,
  recordUsageMetrics,
  renderMetrics,
  resetMetrics,
} from "../src/metrics.js";

beforeEach(() => {
  resetMetrics();
});

describe("renderMetrics", () => {
  it("emits HELP/TYPE headers and nothing else when nothing was recorded", () => {
    const text = renderMetrics();
    expect(text).toContain("# TYPE cor_requests_total counter");
    expect(text).toContain("# TYPE cor_request_duration_seconds histogram");
    expect(text).toContain("# TYPE cor_tokens_total counter");
    expect(text).toContain("# TYPE cor_cost_usd_total counter");
    expect(text).not.toContain("cor_requests_total{");
  });

  it("counts a request under its model and outcome labels", () => {
    recordRequest({ model: "openai/gpt-5", outcome: "ok", durationSeconds: 1.2 });
    recordRequest({ model: "openai/gpt-5", outcome: "ok", durationSeconds: 0.8 });
    recordRequest({ model: "openai/gpt-5", outcome: "no_key", durationSeconds: 0.01 });

    const text = renderMetrics();
    expect(text).toContain('cor_requests_total{model="openai/gpt-5",outcome="ok"} 2');
    expect(text).toContain('cor_requests_total{model="openai/gpt-5",outcome="no_key"} 1');
  });

  it("tracks every RequestOutcome value distinctly", () => {
    for (const outcome of ["ok", "upstream_error", "network_error", "no_key", "stream_error"] as const) {
      recordRequest({ model: "x", outcome, durationSeconds: 1 });
    }
    const text = renderMetrics();
    for (const outcome of ["ok", "upstream_error", "network_error", "no_key", "stream_error"]) {
      expect(text).toContain(`cor_requests_total{model="x",outcome="${outcome}"} 1`);
    }
  });

  it("produces a cumulative histogram whose buckets and +Inf/count/sum agree", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 0.05 });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 2 });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 400 });

    const text = renderMetrics();
    // 0.05s falls in every bucket; 2s falls in buckets >= 2; 400s falls in none but +Inf.
    expect(text).toContain('cor_request_duration_seconds_bucket{model="x",le="0.1"} 1');
    expect(text).toContain('cor_request_duration_seconds_bucket{model="x",le="2"} 2');
    expect(text).toContain('cor_request_duration_seconds_bucket{model="x",le="300"} 2');
    expect(text).toContain('cor_request_duration_seconds_bucket{model="x",le="+Inf"} 3');
    expect(text).toContain('cor_request_duration_seconds_count{model="x"} 3');
    expect(text).toContain(`cor_request_duration_seconds_sum{model="x"} ${0.05 + 2 + 400}`);
  });

  it("sums tokens by type and cost per model from recordUsageMetrics", () => {
    recordUsageMetrics({
      model: "openai/gpt-5",
      promptTokens: 100,
      completionTokens: 20,
      reasoningTokens: 5,
      cachedTokens: 60,
      cost: 0.01,
    });
    recordUsageMetrics({
      model: "openai/gpt-5",
      promptTokens: 50,
      completionTokens: 10,
      cost: 0.005,
    });

    const text = renderMetrics();
    expect(text).toContain('cor_tokens_total{model="openai/gpt-5",type="prompt"} 150');
    expect(text).toContain('cor_tokens_total{model="openai/gpt-5",type="completion"} 30');
    expect(text).toContain('cor_tokens_total{model="openai/gpt-5",type="reasoning"} 5');
    expect(text).toContain('cor_tokens_total{model="openai/gpt-5",type="cached"} 60');
    expect(text).toContain('cor_cost_usd_total{model="openai/gpt-5"} 0.015');
  });

  it("treats a null cost as no contribution instead of erroring", () => {
    recordUsageMetrics({ model: "x", promptTokens: 1, completionTokens: 1, cost: null });
    expect(() => renderMetrics()).not.toThrow();
    expect(renderMetrics()).not.toContain('cor_cost_usd_total{model="x"}');
  });

  it("escapes a quote or backslash in a model id label", () => {
    recordRequest({ model: 'weird"model\\id', outcome: "ok", durationSeconds: 1 });
    const text = renderMetrics();
    expect(text).toContain('model="weird\\"model\\\\id"');
  });

  it("resetMetrics clears every counter", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1 });
    recordUsageMetrics({ model: "x", promptTokens: 1, completionTokens: 1, cost: 0.1 });
    resetMetrics();

    const text = renderMetrics();
    expect(text).not.toContain("cor_requests_total{");
    expect(text).not.toContain("cor_tokens_total{");
    expect(text).not.toContain("cor_cost_usd_total{");
  });
});

describe("getMetricsSummary", () => {
  it("summarizes nothing as empty totals with a null success rate, not NaN", () => {
    const summary = getMetricsSummary();

    expect(summary.models).toEqual([]);
    expect(summary.totals).toEqual({ ok: 0, errors: 0, total: 0, successRate: null, errorRate1h: null });
    expect(Number.isNaN(summary.totals.successRate)).toBe(false);
  });

  it("keys every outcome off a model, zeros included, and derives the success rate", () => {
    for (let i = 0; i < 3; i++) {
      recordRequest({ model: "openai/gpt-5", outcome: "ok", durationSeconds: 1 });
    }
    recordRequest({ model: "openai/gpt-5", outcome: "upstream_error", durationSeconds: 1 });
    recordRequest({ model: "openai/gpt-5", outcome: "no_key", durationSeconds: 1 });

    const summary = getMetricsSummary();
    expect(summary.models).toHaveLength(1);
    expect(summary.models[0]?.requests).toEqual({
      ok: 3,
      upstream_error: 1,
      network_error: 0,
      no_key: 1,
      stream_error: 0,
      budget_blocked: 0,
    });
    expect(summary.models[0]?.total).toBe(5);
    expect(summary.totals).toMatchObject({ ok: 3, errors: 2, total: 5, successRate: 0.6 });
  });

  it("sorts models alphabetically regardless of recording order", () => {
    recordRequest({ model: "b/vendor/model", outcome: "ok", durationSeconds: 1 });
    recordRequest({ model: "a/vendor/model", outcome: "ok", durationSeconds: 1 });

    expect(getMetricsSummary().models.map((entry) => entry.model)).toEqual([
      "a/vendor/model",
      "b/vendor/model",
    ]);
  });

  it("reads quantiles off the cumulative buckets and averages the raw durations", () => {
    // Buckets accumulate upward: 0.4 fills le=0.5, 0.9 fills le=1, 45 fills le=60,
    // so counts are [0,1,2,2,2,2,2,3,3,3] against a total of 3.
    // p50 targets 1.5 -> first bucket at 2 is le=1; p95 targets 2.85 -> first bucket at 3 is le=60.
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 0.4 });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 0.9 });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 45 });

    const entry = getMetricsSummary().models[0];
    expect(entry?.avgDurationSeconds).toBeCloseTo(46.3 / 3, 10);
    expect(entry?.p50Seconds).toBe(1);
    expect(entry?.p95Seconds).toBe(60);
  });

  it("collapses both quantiles to the smallest bucket when every request is fast", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 0.05 });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 0.01 });

    const entry = getMetricsSummary().models[0];
    expect(entry?.p50Seconds).toBe(0.1);
    expect(entry?.p95Seconds).toBe(0.1);
  });

  it("returns an empty summary after resetMetrics", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1 });
    recordUsageMetrics({ model: "x", promptTokens: 1, completionTokens: 1, cost: 0.1 });
    resetMetrics();

    expect(getMetricsSummary()).toEqual({
      models: [],
      totals: { ok: 0, errors: 0, total: 0, successRate: null, errorRate1h: null },
      recentErrors: [],
      timeline: [],
    });
  });
});

/** The recent-requests ring buffer in metrics.ts; asserted against, not duplicated. */
const RING_CAPACITY = 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("getRecentRequests", () => {
  it("returns the newest request first", () => {
    for (const model of ["ilk", "son", "ortasi"]) {
      recordRequest({ model, outcome: "ok", durationSeconds: 1 });
    }

    expect(getRecentRequests().map((request) => request.model)).toEqual(["ortasi", "son", "ilk"]);
  });

  it("takes the newest N, not the oldest N", () => {
    for (let i = 0; i < 5; i++) {
      recordRequest({ model: `istek-${i}`, outcome: "ok", durationSeconds: 1 });
    }

    expect(getRecentRequests(2).map((request) => request.model)).toEqual(["istek-4", "istek-3"]);
  });

  it("returns everything when the limit exceeds what was recorded", () => {
    recordRequest({ model: "tek", outcome: "ok", durationSeconds: 1 });

    expect(getRecentRequests(200)).toHaveLength(1);
  });

  it("returns nothing when nothing was recorded", () => {
    expect(getRecentRequests()).toEqual([]);
  });

  it("keeps the failure text and drops it on a success", () => {
    recordRequest({ model: "x", outcome: "upstream_error", durationSeconds: 1, error: "HTTP 429" });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1 });

    const recent = getRecentRequests();
    expect(recent[0]).toEqual({
      ts: expect.any(Number),
      model: "x",
      outcome: "ok",
      durationSeconds: 1,
    });
    expect(recent[1]?.error).toBe("HTTP 429");
  });

  it("drops the oldest entries once the ring buffer is full", () => {
    for (let i = 0; i < RING_CAPACITY + 5; i++) {
      recordRequest({ model: `istek-${i}`, outcome: "ok", durationSeconds: 1, ts: i });
    }

    const recent = getRecentRequests();
    expect(recent).toHaveLength(RING_CAPACITY);
    // Oldest kept is 5; everything older was shifted off the front.
    expect(recent[recent.length - 1]?.model).toBe("istek-5");
    expect(recent[0]?.model).toBe(`istek-${RING_CAPACITY + 4}`);
  });

  it("honours the limit after the buffer wrapped", () => {
    for (let i = 0; i < RING_CAPACITY + 5; i++) {
      recordRequest({ model: `istek-${i}`, outcome: "ok", durationSeconds: 1 });
    }

    expect(getRecentRequests(3).map((request) => request.model)).toEqual([
      `istek-${RING_CAPACITY + 4}`,
      `istek-${RING_CAPACITY + 3}`,
      `istek-${RING_CAPACITY + 2}`,
    ]);
  });
});

describe("recentErrors", () => {
  it("lists only the failed requests, newest first", () => {
    const base = new Date("2026-09-26T12:00:00Z").getTime();
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: base - 3 * HOUR_MS });
    recordRequest({ model: "x", outcome: "upstream_error", durationSeconds: 1, error: "birinci", ts: base - 2 * HOUR_MS });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: base - HOUR_MS });
    recordRequest({ model: "x", outcome: "network_error", durationSeconds: 1, error: "ikinci", ts: base });

    const errors = getMetricsSummary().recentErrors;
    expect(errors.map((entry) => entry.error)).toEqual(["ikinci", "birinci"]);
  });

  it("carries each failure's message", () => {
    recordRequest({
      model: "x",
      outcome: "upstream_error",
      durationSeconds: 1,
      error: "OpenRouter 500: upstream patladi",
    });

    expect(getMetricsSummary().recentErrors[0]?.error).toBe("OpenRouter 500: upstream patladi");
  });

  it("counts a budget_blocked request as a failure, message included", () => {
    recordRequest({
      model: "x",
      outcome: "budget_blocked",
      durationSeconds: 0,
      error: "cor: butce asildi",
    });

    const summary = getMetricsSummary();
    expect(summary.recentErrors).toHaveLength(1);
    expect(summary.recentErrors[0]?.outcome).toBe("budget_blocked");
    expect(summary.recentErrors[0]?.error).toBe("cor: butce asildi");
  });

  it("is empty when everything succeeded", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1 });
    expect(getMetricsSummary().recentErrors).toEqual([]);
  });

  it("keeps only the last 50 failures", () => {
    for (let i = 0; i < 60; i++) {
      recordRequest({ model: "x", outcome: "upstream_error", durationSeconds: 1, error: `hata-${i}` });
    }

    const errors = getMetricsSummary().recentErrors;
    expect(errors).toHaveLength(50);
    expect(errors[0]?.error).toBe("hata-59");
    expect(errors[errors.length - 1]?.error).toBe("hata-10");
  });
});

describe("timeline", () => {
  const HOUR_START = Math.floor(new Date("2026-09-26T12:00:00Z").getTime() / HOUR_MS) * HOUR_MS;

  it("buckets by model and hour, counting requests and failures", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: HOUR_START + 10_000 });
    recordRequest({ model: "x", outcome: "upstream_error", durationSeconds: 1, ts: HOUR_START + 20_000 });
    recordRequest({ model: "y", outcome: "ok", durationSeconds: 1, ts: HOUR_START + 30_000 });

    const timeline = getMetricsSummary().timeline;
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ model: "x", hourStart: HOUR_START, count: 2, errors: 1 });
    expect(timeline[1]).toMatchObject({ model: "y", hourStart: HOUR_START, count: 1, errors: 0 });
  });

  it("splits the same model across two hours", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: HOUR_START });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: HOUR_START - HOUR_MS });

    const timeline = getMetricsSummary().timeline;
    expect(timeline.map((bucket) => bucket.hourStart)).toEqual([HOUR_START - HOUR_MS, HOUR_START]);
  });

  it("orders buckets oldest first, then by model", () => {
    recordRequest({ model: "b", outcome: "ok", durationSeconds: 1, ts: HOUR_START });
    recordRequest({ model: "a", outcome: "ok", durationSeconds: 1, ts: HOUR_START });
    recordRequest({ model: "c", outcome: "ok", durationSeconds: 1, ts: HOUR_START - HOUR_MS });

    expect(getMetricsSummary().timeline.map((bucket) => [bucket.hourStart, bucket.model])).toEqual([
      [HOUR_START - HOUR_MS, "c"],
      [HOUR_START, "a"],
      [HOUR_START, "b"],
    ]);
  });

  it("reports exact percentiles off the durations, not the bucket estimate", () => {
    // Median of [1, 2, 3, 4] is 2; p95 is the last value, 4.
    for (const durationSeconds of [1, 2, 3, 4]) {
      recordRequest({ model: "x", outcome: "ok", durationSeconds, ts: HOUR_START });
    }

    const bucket = getMetricsSummary().timeline[0];
    expect(bucket?.p50Seconds).toBe(2);
    expect(bucket?.p95Seconds).toBe(4);
  });

  it("reports a zero-second request as a real duration, not a missing one", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 0, ts: HOUR_START });

    const bucket = getMetricsSummary().timeline[0];
    expect(bucket?.count).toBe(1);
    expect(bucket?.p50Seconds).toBe(0);
    expect(bucket?.p95Seconds).toBe(0);
  });

  it("ignores requests older than the 24-hour window", () => {
    const base = new Date("2026-09-26T12:00:00Z").getTime();
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: base });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: base - 25 * HOUR_MS });

    const timeline = getMetricsSummary().timeline;
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.count).toBe(1);
  });
});

describe("errorRate1h", () => {
  // errorRateOverLastHour() reads Date.now() with no way to inject it, so the
  // clock is pinned here: a hardcoded instant would drift out of the window on
  // a machine whose wall clock is hours away from it.
  const NOW = new Date("2026-09-26T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the failed share of the last hour only", () => {
    // 2h ago: well outside the window, and every one of them failed.
    for (let i = 0; i < 8; i++) {
      recordRequest({ model: "x", outcome: "upstream_error", durationSeconds: 1, ts: NOW - 2 * HOUR_MS });
    }
    for (let i = 0; i < 3; i++) {
      recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: NOW - 10 * 60_000 });
    }

    expect(getMetricsSummary().totals.errorRate1h).toBe(0);
  });

  it("includes a request just inside the window", () => {
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: NOW - (HOUR_MS - 60_000) });
    recordRequest({ model: "x", outcome: "ok", durationSeconds: 1, ts: NOW });

    expect(getMetricsSummary().totals.errorRate1h).toBe(0);
  });

  it("is the failed share of the in-window requests", () => {
    for (const outcome of ["ok", "ok", "upstream_error", "no_key"] as const) {
      recordRequest({ model: "x", outcome, durationSeconds: 1, ts: NOW });
    }

    expect(getMetricsSummary().totals.errorRate1h).toBe(0.5);
  });

  it("is null when every request is older than the window", () => {
    recordRequest({
      model: "x",
      outcome: "upstream_error",
      durationSeconds: 1,
      ts: NOW - 2 * HOUR_MS,
    });

    expect(getMetricsSummary().totals.errorRate1h).toBeNull();
  });

  it("stops counting once the clock moves past the request", () => {
    recordRequest({ model: "x", outcome: "upstream_error", durationSeconds: 1, ts: NOW });
    expect(getMetricsSummary().totals.errorRate1h).toBe(1);

    vi.setSystemTime(NOW + HOUR_MS + 1000);

    expect(getMetricsSummary().totals.errorRate1h).toBeNull();
  });
});
