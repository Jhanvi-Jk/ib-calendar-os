import type { Minutes } from "@/lib/domain/types";
import { daysBetween } from "./countdown";

/**
 * Deadline runway — is there actually room for what has been promised?
 *
 * The solver reports infeasibility per task, but only once a plan is
 * generated, and only for the task it failed to place. That is the wrong
 * moment and the wrong granularity: by the time a student runs Re-plan and
 * sees "3h short", the decision that caused it was made two weeks earlier.
 *
 * This answers the aggregate question instead — "you owe 40h before the 25th
 * and have 25h of free time" — which is the one a planner asks first.
 *
 * Cumulative by design: work due on the 10th also eats the capacity that
 * exists before the 25th, so each deadline is measured against everything
 * owed up to and including it. Treating deadlines independently makes every
 * one look survivable while the set is impossible.
 *
 * Pure — no clock, no I/O.
 */

export interface RunwayTask {
  id: string;
  title: string;
  remainingMin: Minutes;
  /** YYYY-MM-DD, or null for undated work (excluded — it has no deadline to miss). */
  deadlineKey: string | null;
}

/** Free minutes per local day, from the solver's capacity model. */
export interface DayCapacity {
  dateKey: string;
  capacityMin: Minutes;
}

export interface DeadlineLoad {
  deadlineKey: string;
  daysAway: number;
  taskCount: number;
  /** Everything owed on or before this date. */
  committedMin: Minutes;
  /** Everything free on or before this date. */
  capacityMin: Minutes;
  shortfallMin: Minutes;
  /** committed / capacity. Above 1 is impossible, not merely busy. */
  utilisation: number;
  status: "comfortable" | "tight" | "over";
}

export interface RunwayReport {
  loads: DeadlineLoad[];
  /** The first deadline that cannot be met, or the tightest if all fit. */
  worst: DeadlineLoad | null;
  hasData: boolean;
  headline: string;
}

/** Above this, a week has no slack left for illness or a bad day. */
const TIGHT_AT = 0.8;

export function computeRunway(
  tasks: RunwayTask[],
  capacity: DayCapacity[],
  todayKey: string,
): RunwayReport {
  const dated = tasks.filter(
    (t) => t.deadlineKey !== null && t.remainingMin > 0,
  ) as Array<RunwayTask & { deadlineKey: string }>;

  if (dated.length === 0 || capacity.length === 0) {
    return {
      loads: [],
      worst: null,
      hasData: false,
      headline:
        "Give your tasks deadlines and this will tell you whether the week actually holds them.",
    };
  }

  // Work owed per deadline date.
  const owedByDate = new Map<string, { min: Minutes; count: number }>();
  for (const t of dated) {
    const cur = owedByDate.get(t.deadlineKey) ?? { min: 0, count: 0 };
    cur.min += t.remainingMin;
    cur.count += 1;
    owedByDate.set(t.deadlineKey, cur);
  }

  const capacityByDate = new Map(capacity.map((d) => [d.dateKey, d.capacityMin]));
  const sortedCapacityKeys = [...capacityByDate.keys()].sort();

  const loads: DeadlineLoad[] = [];
  let committed = 0;
  let capacityCursor = 0;
  let keyIndex = 0;

  for (const deadlineKey of [...owedByDate.keys()].sort()) {
    const owed = owedByDate.get(deadlineKey)!;
    committed += owed.min;

    // Accumulate every capacity day up to and including the deadline. Days
    // already past contribute nothing — capacity is not bankable.
    while (
      keyIndex < sortedCapacityKeys.length &&
      sortedCapacityKeys[keyIndex] <= deadlineKey
    ) {
      const key = sortedCapacityKeys[keyIndex];
      if (key >= todayKey) capacityCursor += capacityByDate.get(key) ?? 0;
      keyIndex++;
    }

    const shortfallMin = Math.max(0, committed - capacityCursor);
    const utilisation = capacityCursor === 0 ? (committed > 0 ? Infinity : 0) : committed / capacityCursor;

    loads.push({
      deadlineKey,
      daysAway: daysBetween(todayKey, deadlineKey),
      taskCount: owed.count,
      committedMin: committed,
      capacityMin: capacityCursor,
      shortfallMin,
      utilisation: Number.isFinite(utilisation) ? Math.round(utilisation * 100) / 100 : 999,
      status: shortfallMin > 0 ? "over" : utilisation >= TIGHT_AT ? "tight" : "comfortable",
    });
  }

  const over = loads.filter((l) => l.status === "over");
  const worst =
    over.length > 0
      ? over[0] // the FIRST impossible deadline — the one to act on
      : loads.reduce<DeadlineLoad | null>(
          (a, b) => (a === null || b.utilisation > a.utilisation ? b : a),
          null,
        );

  return { loads, worst, hasData: true, headline: headlineFor(loads, worst) };
}

function headlineFor(loads: DeadlineLoad[], worst: DeadlineLoad | null): string {
  if (!worst) return "Nothing is due yet.";

  if (worst.status === "over") {
    const hours = Math.round((worst.shortfallMin / 60) * 10) / 10;
    const when =
      worst.daysAway < 0
        ? "already overdue"
        : worst.daysAway === 0
          ? "due today"
          : `due in ${worst.daysAway} days`;
    // Names the gap in hours and points at the earliest break, because that is
    // the decision — not "work harder".
    return `You are about ${hours}h short for what is ${when}. Something has to move, shrink, or be dropped — better to choose now than at 1am.`;
  }

  if (worst.status === "tight") {
    return `Everything fits, but only just — you are using about ${Math.round(worst.utilisation * 100)}% of your free time before ${worst.deadlineKey}. One bad day and it slips.`;
  }

  const total = loads.at(-1);
  return total
    ? `Comfortable. About ${Math.round(total.utilisation * 100)}% of your free time is spoken for.`
    : "Comfortable.";
}
