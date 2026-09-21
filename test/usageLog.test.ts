import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateUsage, readUsage, recordUsage, usageLogPath } from "../src/usageLog.js";

let dir: string;
const originalDir = process.env.CLAUDE_OPENROUTER_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cor-usage-"));
  process.env.CLAUDE_OPENROUTER_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.CLAUDE_OPENROUTER_DIR;
  else process.env.CLAUDE_OPENROUTER_DIR = originalDir;
});

describe("recordUsage / readUsage", () => {
  it("round-trips a record", () => {
    recordUsage({
      model: "openai/gpt-5",
      promptTokens: 100,
      completionTokens: 20,
      cost: 0.01,
      stream: true,
    });

    const records = readUsage();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ model: "openai/gpt-5", cost: 0.01 });
    expect(typeof records[0]?.ts).toBe("number");
  });

  it("returns an empty array when there is no log yet", () => {
    expect(readUsage()).toEqual([]);
  });

  it("skips a corrupt trailing line from a crash mid-write", () => {
    recordUsage({ model: "a", promptTokens: 1, completionTokens: 1, cost: 0, stream: false });
    appendFileSync(usageLogPath(), '{"ts":');

    const records = readUsage();
    expect(records).toHaveLength(1);
  });

  it("never throws when the config directory can't be created", () => {
    // A plain file where a directory component is expected makes mkdirSync
    // fail with ENOTDIR on every platform.
    const blocker = join(dir, "blocker-file");
    writeFileSync(blocker, "x");
    process.env.CLAUDE_OPENROUTER_DIR = join(blocker, "subdir");

    expect(() =>
      recordUsage({ model: "a", promptTokens: 1, completionTokens: 1, cost: 0, stream: false }),
    ).not.toThrow();
  });
});

describe("aggregateUsage", () => {
  const now = new Date("2026-09-20T12:00:00Z").getTime();
  const oneDay = 24 * 60 * 60 * 1000;

  it("produces exactly `days` zero-filled entries, oldest to newest", () => {
    const summary = aggregateUsage([], { days: 14, now });
    expect(summary.daily).toHaveLength(14);
    expect(summary.daily[0]?.date).toBe("2026-09-07");
    expect(summary.daily[13]?.date).toBe("2026-09-20");
    expect(summary.daily.every((bucket) => bucket.cost === 0 && bucket.requests === 0)).toBe(true);
  });

  it("buckets records into the right day and sums cost/requests", () => {
    const records = [
      { ts: now, model: "a", promptTokens: 10, completionTokens: 5, cost: 0.02, stream: true },
      { ts: now, model: "a", promptTokens: 10, completionTokens: 5, cost: 0.03, stream: true },
      {
        ts: now - oneDay,
        model: "b",
        promptTokens: 100,
        completionTokens: 50,
        cost: 0.5,
        stream: false,
      },
    ];

    const summary = aggregateUsage(records, { days: 3, now });

    expect(summary.totals).toEqual({
      requests: 3,
      cost: 0.55,
      promptTokens: 120,
      completionTokens: 60,
    });
    const today = summary.daily.find((bucket) => bucket.date === "2026-09-20");
    const yesterday = summary.daily.find((bucket) => bucket.date === "2026-09-19");
    expect(today).toEqual({ date: "2026-09-20", cost: 0.05, requests: 2 });
    expect(yesterday).toEqual({ date: "2026-09-19", cost: 0.5, requests: 1 });
  });

  it("sorts byModel by cost descending, then by requests", () => {
    const records = [
      { ts: now, model: "cheap", promptTokens: 1, completionTokens: 1, cost: 0.01, stream: true },
      {
        ts: now,
        model: "expensive",
        promptTokens: 1,
        completionTokens: 1,
        cost: 0.5,
        stream: true,
      },
    ];

    const summary = aggregateUsage(records, { now });
    expect(summary.byModel.map((bucket) => bucket.model)).toEqual(["expensive", "cheap"]);
  });

  it("treats a null cost as zero in totals but keeps it in recent records", () => {
    const records = [
      { ts: now, model: "a", promptTokens: 1, completionTokens: 1, cost: null, stream: true },
    ];

    const summary = aggregateUsage(records, { now });
    expect(summary.totals.cost).toBe(0);
    expect(summary.recent[0]?.cost).toBeNull();
  });

  it("returns the newest records first, capped at `recent`", () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      ts: now + i,
      model: "a",
      promptTokens: 1,
      completionTokens: 1,
      cost: 0,
      stream: true,
    }));

    const summary = aggregateUsage(records, { recent: 2, now });
    expect(summary.recent.map((record) => record.ts)).toEqual([now + 4, now + 3]);
  });

  it("restricts every figure to one model when `model` is given", () => {
    const records = [
      { ts: now, model: "a", promptTokens: 10, completionTokens: 5, cost: 0.1, stream: true },
      { ts: now, model: "b", promptTokens: 20, completionTokens: 10, cost: 0.5, stream: true },
    ];

    const summary = aggregateUsage(records, { now, model: "a" });
    expect(summary.totals).toEqual({ requests: 1, cost: 0.1, promptTokens: 10, completionTokens: 5 });
    expect(summary.byModel.map((bucket) => bucket.model)).toEqual(["a"]);
    expect(summary.recent).toHaveLength(1);
  });
});
