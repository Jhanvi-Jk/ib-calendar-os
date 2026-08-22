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



/** Every quota-week Monday touching the window, inclusive. */
export function quotaWeeksBetween(fromKey: string, toKey: string): string[] {
  const weeks: string[] = [];
  let cursor = mondayOf(fromKey);
  const end = dayNumberOf(toKey);
  let guard = 0;
  while (dayNumberOf(cursor) <= end && guard++ < 200) {
    weeks.push(cursor);
    cursor = addDaysKey(cursor, 7);
  }
  return weeks;
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
  const weeks = quotaWeeksBetween(fromKey, toKey);
  const specs: QuotaTaskSpec[] = [];

  for (const quota of quotas) {
    for (const week of weeks) {
      if (!quotaActiveInWeek(quota, week)) continue;
      if (existing.has(`${quota.id}:${week}`)) continue;

      specs.push({
        quotaId: quota.id,
        quotaWeek: week,
        // Week-stamped so the task list stays legible when several weeks of
        // quota work are open at once.
        title: `${quota.label} · w/c ${week}`,
        subjectId: quota.subjectId,
        estimateMin: quota.targetMinWeek,
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
  status: "hit" | "close" | "missed";
}

export interface QuotaReport {
  weeks: QuotaWeekResult[];
  hasData: boolean;
  headline: string;
}

/** Within this of target counts as hitting it — quotas are a rate, not an exam. */
const HIT_AT = 0.9;
const CLOSE_AT = 0.6;

export function quotaAttainment(
  rows: Array<{
    quotaId: string;
    label: string;
    weekMonday: string;
    targetMin: Minutes;
    doneMin: Minutes;
  }>,
): QuotaReport {
  const weeks: QuotaWeekResult[] = rows.map((r) => {
    const attainment = r.targetMin === 0 ? 0 : Math.min(1, r.doneMin / r.targetMin);
    return {
      ...r,
      attainment: Math.round(attainment * 100) / 100,
      status: attainment >= HIT_AT ? "hit" : attainment >= CLOSE_AT ? "close" : "missed",
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
