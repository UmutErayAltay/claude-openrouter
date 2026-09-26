import { beforeEach, describe, expect, it } from "vitest";
import {
  getFreeQuotaState,
  isFreeQuotaExhausted,
  looksLikeFreeQuotaError,
  markFreeQuotaExhausted,
  resetFreeQuotaGuard,
} from "../src/quotaGuard.js";

describe("quotaGuard", () => {
  beforeEach(() => {
    resetFreeQuotaGuard();
  });

  it("starts clear", () => {
    expect(isFreeQuotaExhausted()).toBe(false);
    expect(getFreeQuotaState()).toEqual({ exhausted: false });
  });

  it("marks exhausted for the rest of the same UTC day", () => {
    const noon = Date.parse("2026-09-26T12:00:00Z");
    markFreeQuotaExhausted(noon);

    expect(isFreeQuotaExhausted(noon)).toBe(true);
    expect(isFreeQuotaExhausted(Date.parse("2026-09-26T23:59:59Z"))).toBe(true);
    expect(getFreeQuotaState(noon)).toEqual({ exhausted: true });
  });

  it("clears itself once UTC rolls over to the next day", () => {
    markFreeQuotaExhausted(Date.parse("2026-09-26T23:59:59Z"));
    expect(isFreeQuotaExhausted(Date.parse("2026-09-27T00:00:01Z"))).toBe(false);
  });

  it("resetFreeQuotaGuard clears regardless of day", () => {
    markFreeQuotaExhausted();
    resetFreeQuotaGuard();
    expect(isFreeQuotaExhausted()).toBe(false);
  });

  it("recognizes OpenRouter's own wording for the daily free-model cap", () => {
    expect(
      looksLikeFreeQuotaError(
        "Rate limit exceeded: free-models-per-day. Add 5 credits to unlock 1000 free model requests per day",
      ),
    ).toBe(true);
    expect(looksLikeFreeQuotaError("Rate limit exceeded: requests-per-minute")).toBe(false);
    expect(looksLikeFreeQuotaError("some other upstream error")).toBe(false);
  });
});
