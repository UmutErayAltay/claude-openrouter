import { beforeEach, describe, expect, it } from "vitest";
import {
  getMetricsSummary,
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
