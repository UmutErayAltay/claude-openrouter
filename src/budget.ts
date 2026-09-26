import type { Config } from "./config.js";
import type { UsageRecord } from "./usageLog.js";

export interface BudgetStatus {
  todayUsd: number;
  monthUsd: number;
  dailyUsd?: number;
  monthlyUsd?: number;
  level: "ok" | "warn" | "over";
  exceeded: boolean;
}

/** A limit this close is worth a warning; below it nothing is said. */
const WARN_RATIO = 0.8;

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** UTC day/month, matching how OpenRouter reports and bills a day's spend. */
function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/**
 * Spend against the configured caps, summed from the same usage.jsonl records
 * the dashboard shows. Records with no cost figure count as zero rather than
 * being dropped: OpenRouter doesn't always report one, and skipping them would
 * understate the total.
 */
export function checkBudget(config: Config, usage: UsageRecord[], now: number): BudgetStatus {
  const today = dayKey(now);
  const month = monthKey(now);

  let todayUsd = 0;
  let monthUsd = 0;
  for (const record of usage) {
    const cost = record.cost ?? 0;
    if (dayKey(record.ts) === today) todayUsd += cost;
    if (monthKey(record.ts) === month) monthUsd += cost;
  }

  const dailyUsd = config.budget?.dailyUsd;
  const monthlyUsd = config.budget?.monthlyUsd;

  let level: BudgetStatus["level"] = "ok";
  const seen: BudgetStatus["level"][] = [];
  const check = (spent: number, limit: number | undefined): void => {
    if (limit === undefined || limit <= 0) return;
    seen.push(spent >= limit ? "over" : spent >= limit * WARN_RATIO ? "warn" : "ok");
  };
  check(todayUsd, dailyUsd);
  check(monthUsd, monthlyUsd);
  // The worst of the two windows decides: being fine today says nothing about
  // a month that is already over its cap.
  if (seen.includes("over")) level = "over";
  else if (seen.includes("warn")) level = "warn";

  return {
    todayUsd: round(todayUsd),
    monthUsd: round(monthUsd),
    dailyUsd,
    monthlyUsd,
    level,
    exceeded: level === "over",
  };
}
