import { beforeEach, describe, expect, it } from "vitest";
import { recordRequest, recordUsageMetrics, renderMetrics, resetMetrics } from "../src/metrics.js";

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
