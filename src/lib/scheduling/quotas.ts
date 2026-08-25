import type { Minutes } from "@/lib/domain/types";
// Shared with revision scheduling — both count days from a trigger date.
import { addDaysKey, dayNumberOf, mondayOf } from "./dates";

export { addDaysKey, mondayOf };

/**
 * Turning recurring quotas into concrete weekly work.
 *
 * A quota is a rate ("3h of SAT Maths a week"). The solver only understands
 * tasks with a duration and a deadline, so each active quota materialises one
 * task per week, due at the end of that week.
 *
 * Pure — no clock, no I/O. Dates are YYYY-MM-DD strings throughout, because
 * week boundaries are calendar facts and doing them in epoch milliseconds is
 * how you end up an hour out twice a year.
 */

export interface StudyQuota {
  id: string;
  label: string;
  subjectId: string | null;
  targetMinWeek: Minutes;
  minSessionMin: Minutes;
  maxSessionMin: Minutes;
  cognitiveLoad: 1 | 2 | 3 | 4 | 5;
  priorityPin: 0 | 1 | 2 | 3;
  isActive: boolean;
  activeFrom: string | null;
  activeTo: string | null;
}

/** A task that should exist for a given quota-week but does not yet. */
export interface QuotaTaskSpec {
  quotaId: string;
  quotaWeek: string;
  title: string;
  subjectId: string | null;
  estimateMin: Minutes;
  minChunkMin: Minutes;
  maxChunkMin: Minutes;
  cognitiveLoad: 1 | 2 | 3 | 4 | 5;
  priorityPin: 0 | 1 | 2 | 3;
  /** End of the quota week, local — the task is due by the week's close. */
  deadlineKey: string;
}



/**
 * Every quota-week the planner can actually honour inside the window.
 *
 * A week is only included if it has ALREADY STARTED or ENDS inside the window.
 * Generating a full week's target for a week the horizon merely clips produces
 * guaranteed failure: a 21-day horizon ending on the 15th would create 35
 * hours of work for the week beginning the 14th, none of which can fit in one
 * day, and every one of those tasks was then reported to the student as
 * "couldn't be scheduled". Fourteen phantom failures out of twenty-one.
 *
 * The week reappears on the next solve, once there is room for it.
 */
export function quotaWeeksBetween(fromKey: string, toKey: string): string[] {
  const weeks: string[] = [];
  const firstWeek = mondayOf(fromKey);
  let cursor = firstWeek;
  const end = dayNumberOf(toKey);
  let guard = 0;
  while (dayNumberOf(cursor) <= end && guard++ < 200) {
    const weekEnd = dayNumberOf(addDaysKey(cursor, 6));
    // The current week is always included even though it ends beyond the
    // window — it is being lived now, and its target is pro-rated below.
    if (cursor === firstWeek || weekEnd <= end) weeks.push(cursor);
    cursor = addDaysKey(cursor, 7);
  }
  return weeks;
}

/**
 * A week already half gone cannot absorb a whole week's target.
 *
 * Seven-sevenths of the hours into the four days that are left is not a
 * stretch goal, it is an impossibility the solver dutifully reports as
 * failure. Scaling by the days that remain keeps the rate honest.
 */
export function proRatedTarget(
  targetMinWeek: Minutes,
  weekMonday: string,
  todayKey: string,
): Minutes {
  const elapsed = dayNumberOf(todayKey) - dayNumberOf(weekMonday);
  if (elapsed <= 0) return targetMinWeek;
  const remaining = Math.max(0, 7 - elapsed);
  if (remaining === 0) return 0;
  return Math.round((targetMinWeek * remaining) / 7);
}

function quotaActiveInWeek(quota: StudyQuota, weekMonday: string): boolean {
  if (!quota.isActive) return false;
  const weekEnd = addDaysKey(weekMonday, 6);
  // Overlap test, not containment: a quota starting mid-week still applies to
  // that week rather than silently skipping it.
  if (quota.activeFrom && quota.activeFrom > weekEnd) return false;
  if (quota.activeTo && quota.activeTo < weekMonday) return false;
  return true;
}

/**
 * Which quota tasks are missing for the window.
 *
 * `existing` is the set of "<quotaId>:<weekMonday>" pairs already in the
 * database. Generation is diff-based so it can run on every plan without
 * creating duplicates or resetting progress on a week already under way.
 */
export function quotaTasksNeeded(
  quotas: StudyQuota[],
  options: { fromKey: string; toKey: string; existing: Set<string> },
): QuotaTaskSpec[] {
  const { fromKey, toKey, existing } = options;
  const todayKey = fromKey;
  const weeks = quotaWeeksBetween(fromKey, toKey);
  const specs: QuotaTaskSpec[] = [];

  for (const quota of quotas) {
    for (const week of weeks) {
      if (!quotaActiveInWeek(quota, week)) continue;
      if (existing.has(`${quota.id}:${week}`)) continue;
      // A week with a day left does not need a token five-minute task.
      if (proRatedTarget(quota.targetMinWeek, week, todayKey) < quota.minSessionMin) continue;

      specs.push({
        quotaId: quota.id,
        quotaWeek: week,
        // Week-stamped so the task list stays legible when several weeks of
        // quota work are open at once.
        title: `${quota.label} · w/c ${week}`,
        subjectId: quota.subjectId,
        estimateMin: proRatedTarget(quota.targetMinWeek, week, todayKey),
        minChunkMin: quota.minSessionMin,
        maxChunkMin: quota.maxSessionMin,
        cognitiveLoad: quota.cognitiveLoad,
        priorityPin: quota.priorityPin,
        deadlineKey: addDaysKey(week, 6),
      });
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Attainment
// ---------------------------------------------------------------------------

export interface QuotaWeekResult {
  quotaId: string;
  label: string;
  weekMonday: string;
  targetMin: Minutes;
  doneMin: Minutes;
  /** done / target, capped at 1. */
  attainment: number;
  status: "hit" | "close" | "missed" | "in_progress";
}

export interface QuotaReport {
  weeks: QuotaWeekResult[];
  hasData: boolean;
  headline: string;
}

/** Within this of target counts as hitting it — quotas are a rate, not an exam. */
const HIT_AT = 0.9;
const CLOSE_AT = 0.6;

/**
 * A week still being lived cannot have been missed.
 *
 * Judging the current week against a full week's target means Monday morning
 * always reads as failure. Callers pass the current week so it is reported as
 * under way instead — a target can still be *hit* early, it just cannot be
 * declared lost while there are days left to do it in.
 */
function statusFor(attainment: number, isCurrent: boolean): QuotaWeekResult["status"] {
  if (attainment >= HIT_AT) return "hit";
  if (isCurrent) return "in_progress";
  return attainment >= CLOSE_AT ? "close" : "missed";
}

export function quotaAttainment(
  rows: Array<{
    quotaId: string;
    label: string;
    weekMonday: string;
    targetMin: Minutes;
    doneMin: Minutes;
  }>,
  options: { currentWeekMonday?: string } = {},
): QuotaReport {
  const weeks: QuotaWeekResult[] = rows.map((r) => {
    const attainment = r.targetMin === 0 ? 0 : Math.min(1, r.doneMin / r.targetMin);
    return {
      ...r,
      attainment: Math.round(attainment * 100) / 100,
      status: statusFor(attainment, r.weekMonday === options.currentWeekMonday),
    };
  });

  const hasData = weeks.length > 0;
  return { weeks, hasData, headline: headlineFor(weeks, hasData) };
}

function headlineFor(weeks: QuotaWeekResult[], hasData: boolean): string {
  if (!hasData) {
    return "Set a weekly target for the things that never finish — SAT, TOPIK, language drilling.";
  }

  const missed = weeks.filter((w) => w.status === "missed");
  if (missed.length === 0) {
    return "You are holding your weekly targets.";
  }

  // Name the one that is slipping most often rather than listing everything —
  // a quota missed once is noise, missed repeatedly is a target set wrong.
  const byQuota = new Map<string, { label: string; misses: number }>();
  for (const m of missed) {
    const cur = byQuota.get(m.quotaId) ?? { label: m.label, misses: 0 };
    cur.misses += 1;
    byQuota.set(m.quotaId, cur);
  }
  const worst = [...byQuota.values()].sort((a, b) => b.misses - a.misses)[0];

  return worst.misses > 1
    ? `${worst.label} has missed its target ${worst.misses} weeks running. Either the number is too high or it needs protecting earlier in the week.`
    : `${worst.label} came up short this week.`;
}
