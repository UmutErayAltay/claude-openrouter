import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkBudget } from "../src/budget.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import type { UsageRecord } from "../src/usageLog.js";

let dir: string;
const originalDir = process.env.CLAUDE_OPENROUTER_DIR;
const originalKey = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cor-budget-"));
  process.env.CLAUDE_OPENROUTER_DIR = dir;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalDir;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

/** Every figure the caller passes is a real epoch-ms instant, not a relative offset. */
const NOW = new Date("2026-09-26T12:00:00Z").getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function usageAt(ts: number, cost: number | null, model = "openai/gpt-5"): UsageRecord {
  return { ts, model, promptTokens: 100, completionTokens: 10, cost, stream: false };
}

function config(budget?: Config["budget"]): Config {
  return { ...DEFAULT_CONFIG, budget };
}

describe("checkBudget spend totals", () => {
  it("sums only the records that fall in the same UTC day as now", () => {
    const usage = [
      usageAt(NOW - 2 * HOUR_MS, 0.1),
      usageAt(NOW - 3 * HOUR_MS, 0.2),
      // Previous UTC day, 20 minutes back from midnight: not today, still this month.
      usageAt(new Date("2026-09-25T23:40:00Z").getTime(), 5),
    ];

    const status = checkBudget(config({ action: "warn" }), usage, NOW);

    expect(status.todayUsd).toBeCloseTo(0.3, 10);
    // Same month, so the (absent) monthly cap still sees the whole of yesterday.
    expect(status.monthUsd).toBeCloseTo(5.3, 10);
  });

  it("keeps last month out of both windows", () => {
    const usage = [usageAt(new Date("2026-08-31T23:00:00Z").getTime(), 9)];

    const status = checkBudget(config({ action: "warn", dailyUsd: 1, monthlyUsd: 1 }), usage, NOW);

    expect(status.todayUsd).toBe(0);
    expect(status.monthUsd).toBe(0);
  });

  it("reads the UTC day boundary, not the local one", () => {
    // 00:30Z on the 26th is the 26th in UTC wherever the test machine runs.
    const justAfterMidnight = new Date("2026-09-26T00:30:00Z").getTime();
    const justBefore = new Date("2026-09-25T23:30:00Z").getTime();

    const a = checkBudget(config(), [usageAt(justAfterMidnight, 1)], justAfterMidnight);
    const b = checkBudget(config(), [usageAt(justBefore, 1)], justAfterMidnight);

    expect(a.todayUsd).toBe(1);
    expect(b.todayUsd).toBe(0);
  });

  it("counts a record with a null cost as zero rather than dropping it", () => {
    const usage = [usageAt(NOW - HOUR_MS, null), usageAt(NOW - 2 * HOUR_MS, 0.5)];

    const status = checkBudget(config({ action: "warn" }), usage, NOW);

    // The null record contributes nothing; skipping it would land on the same
    // total here, so also prove it didn't blow the sum up with NaN.
    expect(status.todayUsd).toBe(0.5);
    expect(status.monthUsd).toBe(0.5);
    expect(Number.isNaN(status.todayUsd)).toBe(false);
  });

  it("reports zero spend for an empty log", () => {
    expect(checkBudget(config({ action: "warn", dailyUsd: 5 }), [], NOW)).toMatchObject({
      todayUsd: 0,
      monthUsd: 0,
    });
  });
});

describe("checkBudget limits", () => {
  it("stays ok when no cap is configured at all", () => {
    const usage = [usageAt(NOW, 1000)];

    expect(checkBudget(config(), usage, NOW)).toEqual({
      todayUsd: 1000,
      monthUsd: 1000,
      dailyUsd: undefined,
      monthlyUsd: undefined,
      level: "ok",
      exceeded: false,
    });
  });

  it("stays ok when the caps are present but unset", () => {
    expect(checkBudget(config({ action: "block" }), [usageAt(NOW, 1000)], NOW)).toMatchObject({
      level: "ok",
      exceeded: false,
    });
  });

  it("ignores a zero cap instead of blocking everything", () => {
    const status = checkBudget(
      config({ action: "block", dailyUsd: 0, monthlyUsd: 0 }),
      [usageAt(NOW, 1)],
      NOW,
    );
    expect(status.level).toBe("ok");
    expect(status.exceeded).toBe(false);
  });

  it("stays ok below 80% of a cap", () => {
    const status = checkBudget(
      config({ action: "warn", dailyUsd: 10 }),
      [usageAt(NOW, 7.99)],
      NOW,
    );
    expect(status.level).toBe("ok");
    expect(status.exceeded).toBe(false);
  });

  it("warns from 80% of the daily cap", () => {
    const status = checkBudget(config({ action: "warn", dailyUsd: 10 }), [usageAt(NOW, 8)], NOW);
    expect(status.level).toBe("warn");
    expect(status.exceeded).toBe(false);
  });

  it("warns just above the 80% threshold, before anything is actually over", () => {
    const status = checkBudget(
      config({ action: "warn", dailyUsd: 10 }),
      [usageAt(NOW, 9.5)],
      NOW,
    );
    expect(status.level).toBe("warn");
    expect(status.exceeded).toBe(false);
  });

  it("warns on the monthly cap alone", () => {
    const status = checkBudget(
      config({ action: "warn", monthlyUsd: 20 }),
      [usageAt(NOW - 2 * DAY_MS, 17)],
      NOW,
    );
    expect(status.monthUsd).toBeCloseTo(17, 10);
    expect(status.level).toBe("warn");
  });

  it("goes over and sets exceeded once a cap is reached", () => {
    const status = checkBudget(
      config({ action: "block", dailyUsd: 10 }),
      [usageAt(NOW, 10)],
      NOW,
    );
    expect(status.level).toBe("over");
    expect(status.exceeded).toBe(true);
  });

  it("goes over past the cap, not only at it", () => {
    const status = checkBudget(
      config({ action: "block", dailyUsd: 10 }),
      [usageAt(NOW, 25)],
      NOW,
    );
    expect(status.level).toBe("over");
    expect(status.exceeded).toBe(true);
  });

  it("is over on the month even when today is comfortably under its own cap", () => {
    const status = checkBudget(
      config({ action: "block", dailyUsd: 10, monthlyUsd: 100 }),
      // A day ago: a previous UTC day, but the same month.
      [usageAt(NOW - DAY_MS, 150)],
      NOW,
    );
    expect(status.todayUsd).toBe(0);
    expect(status.monthUsd).toBeCloseTo(150, 10);
    expect(status.level).toBe("over");
    expect(status.exceeded).toBe(true);
  });

  it("reports both caps back so the caller can label them", () => {
    const status = checkBudget(
      config({ action: "warn", dailyUsd: 10, monthlyUsd: 200 }),
      [],
      NOW,
    );
    expect(status.dailyUsd).toBe(10);
    expect(status.monthlyUsd).toBe(200);
  });
});
