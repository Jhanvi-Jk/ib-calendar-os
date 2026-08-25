import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { addLocalDays, localDateKey, localParts, startOfLocalDay, toEpochMinute } from "@/lib/time";
import { computeMomentum, type DayRecord, type MomentumResult } from "@/lib/analytics/momentum";
import { accuracyReport, calibrate, type AccuracyReport, type CompletedSample } from "@/lib/analytics/calibration";
import { subjectBalance, type BalanceReport, type SubjectTime } from "@/lib/analytics/balance";
import { buildWeeklyReview, type WeeklyReview } from "@/lib/analytics/weekly";

/**
 * Assembles the inputs to the pure analytics functions.
 *
 * All the judgement lives in src/lib/analytics/; this module only fetches.
 */

export interface ReviewData {
  momentum: MomentumResult;
  history: DayRecord[];
  accuracy: AccuracyReport;
  calibrationRatio: number;
  /** p80 ratio actually applied to future estimates, and whether it is in force. */
  calibrationP80: number;
  calibrationIsReliable: boolean;
  trackedMinToday: number;
}

export async function getReviewData(
  timezone: string,
  days = 90,
): Promise<ReviewData> {
  const supabase = await createClient();
  const nowMin = toEpochMinute(new Date());
  const windowStart = addLocalDays(startOfLocalDay(nowMin, timezone), -days, timezone);
  const windowStartIso = new Date(windowStart * 60_000).toISOString();

  const [{ data: entries }, { data: run }, { data: completed }, { data: writeOffs }] =
    await Promise.all([
    supabase
      .from("time_entries")
      .select("started_at, duration_min")
      .gte("started_at", windowStartIso)
      .not("ended_at", "is", null),
    supabase
      .from("schedule_runs")
      .select("id")
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("tasks")
      .select("estimate_min, actual_min, subject_id, cognitive_load")
      .eq("status", "done")
      .gt("actual_min", 0),
    supabase.from("day_write_offs").select("day").gte("day", localDateKey(windowStart, timezone)),
  ]);

  // A day the student wrote off is a rest day, not a miss.
  //
  // Zeroing plannedMin is all it takes: computeMomentum already excludes days
  // with nothing planned from the ratio and counts them as rest. Illness
  // therefore stops dragging the number down without any special case in the
  // momentum logic itself.
  const writtenOff = new Set((writeOffs ?? []).map((w) => w.day as string));

  // Planned minutes come from the active run's blocks, keyed by local day.
  const plannedByDay = new Map<string, number>();
  if (run) {
    const { data: blocks } = await supabase
      .from("scheduled_blocks")
      .select("starts_at, ends_at")
      .eq("run_id", run.id)
      .gte("starts_at", windowStartIso);

    for (const block of blocks ?? []) {
      const startMin = toEpochMinute(new Date(block.starts_at));
      const endMin = toEpochMinute(new Date(block.ends_at));

      // Only work whose time has already passed counts towards momentum.
      //
      // A block planned for 21:00 is not a block you have failed to do at
      // 19:30. Counting it told a student who had just pressed "Generate
      // plan" that they were Strained at 0% of a plan that had not started
      // yet — the same fabricated-score problem `hasData` was added to fix,
      // arriving through a different door.
      if (endMin > nowMin) continue;

      const key = localDateKey(startMin, timezone);
      plannedByDay.set(key, (plannedByDay.get(key) ?? 0) + (endMin - startMin));
    }
  }

  const completedByDay = new Map<string, number>();
  for (const entry of entries ?? []) {
    const key = localDateKey(toEpochMinute(new Date(entry.started_at)), timezone);
    completedByDay.set(key, (completedByDay.get(key) ?? 0) + (entry.duration_min ?? 0));
  }

  const history: DayRecord[] = [];
  for (let i = days; i >= 0; i--) {
    const dayStart = addLocalDays(startOfLocalDay(nowMin, timezone), -i, timezone);
    const key = localDateKey(dayStart, timezone);
    history.push({
      date: key,
      plannedMin: writtenOff.has(key) ? 0 : (plannedByDay.get(key) ?? 0),
      completedMin: completedByDay.get(key) ?? 0,
    });
  }

  const samples: CompletedSample[] = (completed ?? []).map((t) => ({
    estimateMin: t.estimate_min,
    actualMin: t.actual_min,
    subjectId: t.subject_id,
    cognitiveLoad: t.cognitive_load,
  }));

  const todayKey = localDateKey(nowMin, timezone);

  return {
    momentum: computeMomentum(history),
    history,
    accuracy: accuracyReport(samples),
    calibrationRatio: calibrate(samples).ratioP50,
    calibrationP80: calibrate(samples).ratioP80,
    calibrationIsReliable: calibrate(samples).isReliable,
    trackedMinToday: completedByDay.get(todayKey) ?? 0,
  };
}

/**
 * The open timer, if one is running.
 *
 * cache()d: the app layout renders the timer bar and the Tasks/Focus pages
 * each need the same row, so without this every one of those pages paid for
 * the identical query twice.
 */
export const getRunningTimer = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("time_entries")
    .select("id, task_id, started_at, tasks(title)")
    .is("ended_at", null)
    .maybeSingle();

  if (!data) return null;
  return {
    id: data.id,
    taskId: data.task_id,
    title: data.tasks?.title ?? "Untitled",
    startedAt: data.started_at,
  };
});

/**
 * Tracked minutes per subject over the recent window.
 *
 * Subjects with zero tracked time are included deliberately — a subject that
 * never appears is exactly the one worth surfacing, and leaving it out of the
 * result would hide the finding.
 */
export const getSubjectBalance = cache(async (days = 14): Promise<BalanceReport> => {
  const supabase = await createClient();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  const [{ data: subjects }, { data: entries }] = await Promise.all([
    supabase.from("subjects").select("id, name, level").eq("is_archived", false),
    supabase
      .from("time_entries")
      .select("duration_min, tasks(subject_id)")
      .gte("started_at", sinceIso)
      .not("ended_at", "is", null),
  ]);

  const minutesBySubject = new Map<string, number>();
  for (const e of entries ?? []) {
    const sid = e.tasks?.subject_id;
    if (!sid) continue;
    minutesBySubject.set(sid, (minutesBySubject.get(sid) ?? 0) + (e.duration_min ?? 0));
  }

  const input: SubjectTime[] = (subjects ?? []).map((s) => ({
    subjectId: s.id,
    name: s.name,
    level: s.level,
    minutes: minutesBySubject.get(s.id) ?? 0,
  }));

  return subjectBalance(input);
});

/** Inputs for the weekly review prompt. */
export const getWeeklyReview = cache(async (timezone: string): Promise<WeeklyReview> => {
  const supabase = await createClient();
  const nowMin = toEpochMinute(new Date());
  const todayKey = localDateKey(nowMin, timezone);
  const { dow } = localParts(nowMin, timezone);

  const [{ history }, { data: lastRetro }, { data: tasks }] = await Promise.all([
    getReviewData(timezone, 14),
    supabase
      .from("retrospectives")
      .select("day")
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("tasks")
      .select("id, title, remaining_min, estimate_min, deadline_at")
      .in("status", ["todo", "in_progress", "blocked"]),
  ]);

  return buildWeeklyReview({
    todayKey,
    todayDow: dow,
    lastReviewKey: lastRetro?.day ?? null,
    week: history.slice(-7),
    openTasks: (tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      remainingMin: t.remaining_min,
      estimateMin: t.estimate_min,
      deadlineKey: t.deadline_at
        ? localDateKey(toEpochMinute(new Date(t.deadline_at)), timezone)
        : null,
    })),
  });
});
