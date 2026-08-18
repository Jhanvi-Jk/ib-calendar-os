import { createClient } from "@/lib/supabase/server";
import { addLocalDays, localDateKey, startOfLocalDay, toEpochMinute } from "@/lib/time";
import { computeMomentum, type DayRecord, type MomentumResult } from "@/lib/analytics/momentum";
import { accuracyReport, calibrate, type AccuracyReport, type CompletedSample } from "@/lib/analytics/calibration";

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

  const [{ data: entries }, { data: run }, { data: completed }] = await Promise.all([
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
  ]);

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
      const key = localDateKey(startMin, timezone);
      const minutes = toEpochMinute(new Date(block.ends_at)) - startMin;
      plannedByDay.set(key, (plannedByDay.get(key) ?? 0) + minutes);
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
      plannedMin: plannedByDay.get(key) ?? 0,
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
    trackedMinToday: completedByDay.get(todayKey) ?? 0,
  };
}

/** The open timer, if one is running. */
export async function getRunningTimer() {
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
}
