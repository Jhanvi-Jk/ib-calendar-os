import type { Minutes } from "@/lib/domain/types";
import { daysBetween } from "./countdown";
import type { DayRecord } from "./momentum";

/**
 * The weekly review.
 *
 * The retrospective table has existed since the start with nothing that ever
 * asks the student to fill it in. A review nobody is prompted to do is a
 * review nobody does, and reflection is the part of planning that actually
 * changes behaviour — a plan you never look back at is just a wish list.
 *
 * Pure — no clock, no I/O. `todayKey` is supplied.
 */

export interface SlippedTask {
  id: string;
  title: string;
  remainingMin: Minutes;
  /** Negative when overdue. */
  daysToDeadline: number | null;
  reason: "overdue" | "untouched" | "partial";
}

export interface WeeklyReview {
  /** Sunday or Monday, or a week since the last one — whichever comes first. */
  isDue: boolean;
  /** Days since the last saved retrospective, null if there has never been one. */
  daysSinceLast: number | null;
  plannedMin: Minutes;
  completedMin: Minutes;
  /** completedMin / plannedMin, clamped. Null when nothing was planned. */
  followThrough: number | null;
  slipped: SlippedTask[];
  /** Work already owed in the coming week. */
  nextWeekCommittedMin: Minutes;
  headline: string;
}

/** 0 = Sunday. Review lands at the week boundary, when it can still change something. */
const REVIEW_DAYS = new Set([0, 1]);

export function buildWeeklyReview(input: {
  todayKey: string;
  /** 0–6, Sunday first — supplied so this stays clock-free. */
  todayDow: number;
  lastReviewKey: string | null;
  /** Last 7 days, oldest first. */
  week: DayRecord[];
  openTasks: Array<{
    id: string;
    title: string;
    remainingMin: Minutes;
    estimateMin: Minutes;
    deadlineKey: string | null;
  }>;
}): WeeklyReview {
  const { todayKey, todayDow, lastReviewKey, week, openTasks } = input;

  const daysSinceLast = lastReviewKey ? daysBetween(lastReviewKey, todayKey) : null;
  // Never prompt twice in one day, however the other conditions land.
  const alreadyToday = daysSinceLast === 0;
  const isDue =
    !alreadyToday && (REVIEW_DAYS.has(todayDow) || daysSinceLast === null || daysSinceLast >= 7);

  const plannedMin = week.reduce((sum, d) => sum + d.plannedMin, 0);
  const completedMin = week.reduce((sum, d) => sum + d.completedMin, 0);
  const followThrough =
    plannedMin === 0 ? null : Math.round(Math.min(1, completedMin / plannedMin) * 100) / 100;

  const slipped: SlippedTask[] = openTasks
    .map((t) => {
      const daysToDeadline = t.deadlineKey ? daysBetween(todayKey, t.deadlineKey) : null;
      const touched = t.remainingMin < t.estimateMin;
      // Overdue outranks everything: it is the only category with a
      // consequence attached rather than a preference.
      const reason: SlippedTask["reason"] =
        daysToDeadline !== null && daysToDeadline < 0
          ? "overdue"
          : touched
            ? "partial"
            : "untouched";
      return { id: t.id, title: t.title, remainingMin: t.remainingMin, daysToDeadline, reason };
    })
    .filter((t) => t.reason === "overdue" || t.reason === "partial")
    .sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === "overdue" ? -1 : 1;
      return (a.daysToDeadline ?? 9999) - (b.daysToDeadline ?? 9999);
    })
    .slice(0, 6);

  const nextWeekCommittedMin = openTasks
    .filter((t) => {
      if (!t.deadlineKey) return false;
      const d = daysBetween(todayKey, t.deadlineKey);
      return d >= 0 && d <= 7;
    })
    .reduce((sum, t) => sum + t.remainingMin, 0);

  return {
    isDue,
    daysSinceLast,
    plannedMin,
    completedMin,
    followThrough,
    slipped,
    nextWeekCommittedMin,
    headline: headlineFor(followThrough, slipped, nextWeekCommittedMin),
  };
}

function headlineFor(
  followThrough: number | null,
  slipped: SlippedTask[],
  nextWeekMin: Minutes,
): string {
  const overdue = slipped.filter((s) => s.reason === "overdue").length;

  if (overdue > 0) {
    return `${overdue} ${overdue === 1 ? "thing is" : "things are"} past their deadline. Decide what happens to ${overdue === 1 ? "it" : "them"} before planning anything new.`;
  }
  if (followThrough === null) {
    return "Nothing was planned last week, so there is nothing to compare against. Worth setting a plan you can actually check yourself against.";
  }
  if (followThrough >= 0.8) {
    const hours = Math.round(nextWeekMin / 60);
    return `You did most of what you planned. About ${hours}h is already owed in the coming week — worth knowing before you agree to anything else.`;
  }
  if (followThrough >= 0.5) {
    return "Roughly half the plan landed. The usual cause is an over-full plan rather than a lack of effort — worth planning less next week and hitting it.";
  }
  return "Most of last week's plan did not happen. That is information about the plan, not about you: it was probably too big. Cut it deliberately rather than carrying it forward whole.";
}
