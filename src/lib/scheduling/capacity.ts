import {
  MIN_PER_DAY,
  addLocalDays,
  eachLocalDay,
  localDateKey,
  localParts,
  minutesIntoLocalDay,
  startOfLocalDay,
} from "@/lib/time";
import type {
  CapacitySettings,
  EnergyCurve,
  EpochMinute,
  FixedEvent,
  Minutes,
  PlacedBlock,
  SolverSnapshot,
} from "@/lib/domain/types";
import { type Interval, normalize, subtract } from "./intervals";

/**
 * Turns the horizon into the set of minutes the solver is actually allowed to
 * fill, then scores those minutes by expected cognitive throughput.
 */

/**
 * Events at these tiers consume real time and the solver plans around them.
 * Tier 4 (elastic) and 5 (recovery) deliberately do NOT block: they are the
 * slack the recovery protocol reclaims when a student falls behind.
 */
const BLOCKING_TIERS = new Set([1, 2, 3]);

/** Sleep windows as absolute intervals across the horizon. */
export function sleepIntervals(
  horizon: Interval,
  settings: CapacitySettings,
  timezone: string,
): Interval[] {
  if (!settings.sleepProtected) return [];

  const out: Interval[] = [];
  // Start a day early: the sleep window that began last night still covers
  // the first hours of the horizon.
  const first = addLocalDays(startOfLocalDay(horizon.start, timezone), -1, timezone);

  for (const dayStart of eachLocalDay(first, horizon.end, timezone)) {
    const start = dayStart + settings.sleepStartMin;
    // A window whose end is numerically before its start crosses midnight.
    const end =
      settings.sleepEndMin > settings.sleepStartMin
        ? dayStart + settings.sleepEndMin
        : addLocalDays(dayStart, 1, timezone) + settings.sleepEndMin;
    out.push({ start, end });
  }
  return normalize(out);
}

/** The inverse of the working window: everything outside day_start..day_end. */
export function outsideDayWindow(
  horizon: Interval,
  settings: CapacitySettings,
  timezone: string,
): Interval[] {
  const out: Interval[] = [];
  const first = addLocalDays(startOfLocalDay(horizon.start, timezone), -1, timezone);

  for (const dayStart of eachLocalDay(first, horizon.end, timezone)) {
    const nextDay = addLocalDays(dayStart, 1, timezone);
    out.push({ start: dayStart, end: dayStart + settings.dayStartMin });
    out.push({ start: dayStart + settings.dayEndMin, end: nextDay });
  }
  return normalize(out);
}

export function eventIntervals(events: FixedEvent[]): Interval[] {
  return events
    .filter((e) => BLOCKING_TIERS.has(e.tier) || e.isLocked)
    .map((e) => ({ start: e.startsAt, end: e.endsAt }));
}

export function lockedBlockIntervals(blocks: PlacedBlock[]): Interval[] {
  return blocks.filter((b) => b.isLocked).map((b) => ({ start: b.startsAt, end: b.endsAt }));
}

/** Minutes in the horizon available for scheduled work. */
export function buildFreeIntervals(snapshot: SolverSnapshot): Interval[] {
  const horizon: Interval = { start: snapshot.horizonStart, end: snapshot.horizonEnd };

  const blocked = [
    ...sleepIntervals(horizon, snapshot.settings, snapshot.timezone),
    ...outsideDayWindow(horizon, snapshot.settings, snapshot.timezone),
    ...eventIntervals(snapshot.events),
    ...lockedBlockIntervals(snapshot.lockedBlocks),
  ];

  return subtract([horizon], blocked);
}

/**
 * Expected throughput multiplier for the hour containing `at`.
 * A 60-minute block at 0.4 buys roughly 24 minutes of real work.
 */
export function energyAt(
  at: EpochMinute,
  curve: EnergyCurve,
  timezone: string,
): number {
  const p = localParts(at, timezone);
  return curve[p.dow]?.[p.hour] ?? 1;
}

/**
 * Average energy across an interval, weighted by how long it spends in each
 * hour. Scoring a two-hour block by its first hour alone would rank a block
 * straddling the post-lunch trough as though it were all peak time.
 */
export function averageEnergy(
  interval: Interval,
  curve: EnergyCurve,
  timezone: string,
): number {
  let weighted = 0;
  let total = 0;
  let cursor = interval.start;

  while (cursor < interval.end) {
    const minuteOfDay = minutesIntoLocalDay(cursor, timezone);
    const minutesLeftInHour = 60 - (minuteOfDay % 60);
    const chunk = Math.min(minutesLeftInHour, interval.end - cursor);
    weighted += energyAt(cursor, curve, timezone) * chunk;
    total += chunk;
    cursor += chunk;
  }

  return total === 0 ? 0 : weighted / total;
}

export interface DayBudget {
  dateKey: string;
  dayStart: EpochMinute;
  availableMin: Minutes;
  /** Hard ceiling from user_settings.max_daily_focus_min. */
  capMin: Minutes;
  usedMin: Minutes;
}

/** Per-local-day budgets, so max_daily_focus_min can be enforced. */
export function buildDayBudgets(
  snapshot: SolverSnapshot,
  free: Interval[],
): Map<string, DayBudget> {
  const budgets = new Map<string, DayBudget>();
  const { timezone, settings } = snapshot;

  // A written-off day is capped at zero rather than removed from the map, so
  // it still appears in reports as a day that existed and was deliberately
  // given up — not as a gap in the record.
  const writtenOff = new Set(snapshot.writtenOffDays ?? []);

  for (const dayStart of eachLocalDay(
    snapshot.horizonStart,
    snapshot.horizonEnd,
    timezone,
  )) {
    const dateKey = localDateKey(dayStart, timezone);
    budgets.set(dateKey, {
      dateKey,
      dayStart,
      availableMin: 0,
      capMin: writtenOff.has(dateKey)
        ? 0
        : (settings.maxDailyFocusByDow?.[localParts(dayStart, timezone).dow] ??
           settings.maxDailyFocusMin),
      usedMin: 0,
    });
  }

  for (const interval of free) {
    let cursor = interval.start;
    while (cursor < interval.end) {
      const dayStart = startOfLocalDay(cursor, timezone);
      const nextDay = addLocalDays(dayStart, 1, timezone);
      const sliceEnd = Math.min(interval.end, nextDay);
      const key = localDateKey(cursor, timezone);
      const budget = budgets.get(key);
      if (budget) budget.availableMin += sliceEnd - cursor;
      cursor = sliceEnd;
    }
  }

  return budgets;
}

/** Effective capacity of a day: free minutes, capped, energy-discounted. */
export function effectiveDailyCapacity(budget: DayBudget): Minutes {
  return Math.max(0, Math.min(budget.availableMin, budget.capMin) - budget.usedMin);
}

export { MIN_PER_DAY };
