import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

/** One completed OpenRouter request, recorded for the dashboard. */
export interface UsageRecord {
  ts: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  /** null when the upstream response didn't carry a cost figure. */
  cost: number | null;
  stream: boolean;
}

export interface UsageDailyBucket {
  date: string;
  cost: number;
  requests: number;
}

export interface UsageModelBucket {
  model: string;
  requests: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsageSummary {
  totals: { requests: number; cost: number; promptTokens: number; completionTokens: number };
  byModel: UsageModelBucket[];
  daily: UsageDailyBucket[];
  recent: UsageRecord[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS_AFTER_TRIM = 5000;
/** Checking file size is O(1); only pay for a full read/rewrite occasionally. */
const TRIM_CHECK_EVERY = 200;

let appendsSinceTrimCheck = 0;

export function usageLogPath(): string {
  return join(configDir(), "usage.jsonl");
}

/**
 * Appends one record. Never throws: a disk or parse failure here must not
 * break the request it's trying to record.
 */
export function recordUsage(entry: Omit<UsageRecord, "ts"> & { ts?: number }): void {
  try {
    const record: UsageRecord = { ts: entry.ts ?? Date.now(), ...entry };
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    appendFileSync(usageLogPath(), `${JSON.stringify(record)}\n`);

    appendsSinceTrimCheck += 1;
    if (appendsSinceTrimCheck >= TRIM_CHECK_EVERY) {
      appendsSinceTrimCheck = 0;
      trimIfNeeded();
    }
  } catch {
    // Usage logging is best-effort; the proxy response already went out.
  }
}

function trimIfNeeded(): void {
  const path = usageLogPath();
  if (!existsSync(path)) return;
  if (statSync(path).size <= MAX_FILE_BYTES) return;

  const records = readUsage();
  const kept = records.slice(-MAX_RECORDS_AFTER_TRIM);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, kept.map((record) => `${JSON.stringify(record)}\n`).join(""));
  renameSync(tmp, path);
}

function isUsageRecord(value: unknown): value is UsageRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UsageRecord).ts === "number" &&
    typeof (value as UsageRecord).model === "string"
  );
}

/** Skips any line that isn't valid JSON — a crash mid-write leaves one behind. */
export function readUsage(): UsageRecord[] {
  const path = usageLogPath();
  if (!existsSync(path)) return [];

  const records: UsageRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isUsageRecord(parsed)) records.push(parsed);
    } catch {
      // Corrupt trailing line from a crash mid-append; skip it.
    }
  }
  return records;
}

function dayKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface AggregateOptions {
  /** How many trailing days to zero-fill into `daily`. */
  days?: number;
  /** How many of the newest records to return in `recent`. */
  recent?: number;
  /** Injectable for tests; defaults to the real clock. */
  now?: number;
}

/** Pure aggregation — the caller supplies the records via readUsage(). */
export function aggregateUsage(
  records: UsageRecord[],
  options: AggregateOptions = {},
): UsageSummary {
  const days = options.days ?? 14;
  const recentCount = options.recent ?? 20;
  const now = options.now ?? Date.now();

  const totals = { requests: 0, cost: 0, promptTokens: 0, completionTokens: 0 };
  const byModel = new Map<string, UsageModelBucket>();
  const byDay = new Map<string, UsageDailyBucket>();

  for (const record of records) {
    totals.requests += 1;
    totals.cost += record.cost ?? 0;
    totals.promptTokens += record.promptTokens;
    totals.completionTokens += record.completionTokens;

    const modelBucket = byModel.get(record.model) ?? {
      model: record.model,
      requests: 0,
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
    modelBucket.requests += 1;
    modelBucket.cost += record.cost ?? 0;
    modelBucket.promptTokens += record.promptTokens;
    modelBucket.completionTokens += record.completionTokens;
    byModel.set(record.model, modelBucket);

    const key = dayKey(record.ts);
    const dayBucket = byDay.get(key) ?? { date: key, cost: 0, requests: 0 };
    dayBucket.cost += record.cost ?? 0;
    dayBucket.requests += 1;
    byDay.set(key, dayBucket);
  }

  const daily: UsageDailyBucket[] = [];
  const oneDayMs = 24 * 60 * 60 * 1000;
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * oneDayMs);
    daily.push(byDay.get(key) ?? { date: key, cost: 0, requests: 0 });
  }

  const sortedByModel = [...byModel.values()].sort(
    (a, b) => b.cost - a.cost || b.requests - a.requests,
  );

  const recent = [...records].sort((a, b) => b.ts - a.ts).slice(0, recentCount);

  return {
    totals: {
      requests: totals.requests,
      cost: Math.round(totals.cost * 1e6) / 1e6,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
    },
    byModel: sortedByModel.map((bucket) => ({
      ...bucket,
      cost: Math.round(bucket.cost * 1e6) / 1e6,
    })),
    daily: daily.map((bucket) => ({ ...bucket, cost: Math.round(bucket.cost * 1e6) / 1e6 })),
    recent,
  };
}
