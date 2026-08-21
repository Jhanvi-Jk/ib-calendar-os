import { createClient } from "@/lib/supabase/server";
import { addLocalDays, fromEpochMinute, localDateKey, startOfLocalDay, toEpochMinute } from "@/lib/time";
import {
  getDependencies,
  getEnergyCurve,
  getEvents,
  getOpenTasks,
  getSubjects,
  getUserContext,
} from "./queries";
import type { EpochMinute, PlacedBlock, SolverSnapshot } from "@/lib/domain/types";
import { adjustEstimate, bucketKey, calibrateByBucket, type Calibration, type CompletedSample } from "@/lib/analytics/calibration";

/**
 * Assembles the frozen input to a solve.
 *
 * Everything the solver sees is read here, in one place, at one moment. The
 * engine itself never touches the database — if it did, "same input, same
 * output" would depend on query timing.
 */
export async function loadSnapshot(options?: {
  /** Overrides user_settings.planning_horizon_days. */
  horizonDays?: number;
  /** Restrict re-solving to a single local day ("Reset Day"). */
  scopeToDay?: EpochMinute;
  seed?: number;
}): Promise<SolverSnapshot | null> {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const { timezone, settings } = ctx;
  const nowMin = toEpochMinute(new Date());

  let horizonStart: EpochMinute;
  let horizonEnd: EpochMinute;

  if (options?.scopeToDay !== undefined) {
    const dayStart = startOfLocalDay(options.scopeToDay, timezone);
    // Never re-plan the past: a Reset Day at 3pm starts at 3pm, not at 00:00.
    horizonStart = Math.max(dayStart, nowMin);
    horizonEnd = addLocalDays(dayStart, 1, timezone);
  } else {
    horizonStart = nowMin;
    horizonEnd = addLocalDays(
      startOfLocalDay(nowMin, timezone),
      options?.horizonDays ?? settings.planningHorizonDays,
      timezone,
    );
  }

  const [
    subjects,
    events,
    tasks,
    dependencies,
    energy,
    lockedBlocks,
    calibration,
    writtenOffDays,
  ] = await Promise.all([
      getSubjects(),
      getEvents(
        fromEpochMinute(horizonStart).toISOString(),
        fromEpochMinute(horizonEnd).toISOString(),
      ),
      getOpenTasks(),
      getDependencies(),
      getEnergyCurve(),
      getLockedBlocks(horizonStart, horizonEnd),
      getCalibrationBuckets(),
      getWrittenOffDays(horizonStart, horizonEnd, timezone),
    ]);

  /*
   * Plan against how long work ACTUALLY takes this student, not how long they
   * hoped it would.
   *
   * estimation_calibration has been populated from every tracked timer since
   * the beginning and was never read by the scheduler, so a student who
   * reliably runs 60% over kept being handed the same impossible week.
   *
   * p80 rather than the median: planning to the middle of your own
   * distribution means missing the plan half the time by construction, which
   * is exactly the experience that makes people abandon a planner.
   *
   * Only applied once a bucket is reliable (see RELIABILITY_THRESHOLD) —
   * inflating estimates off two data points would be superstition.
   */
  const calibratedTasks = tasks.map((t) => {
    const bucket = calibration.get(bucketKey(t.subjectId, t.cognitiveLoad));
    const adjusted = adjustEstimate(t.remainingMin, bucket);
    return adjusted === t.remainingMin ? t : { ...t, remainingMin: adjusted };
  });

  return {
    userId: ctx.userId,
    timezone,
    horizonStart,
    horizonEnd,
    settings,
    energy,
    subjects,
    events,
    tasks: calibratedTasks,
    dependencies,
    lockedBlocks,
    writtenOffDays,
    seed: options?.seed ?? 0,
  };
}

/**
 * Locked blocks from the currently active run. These survive a re-solve
 * untouched — the user pinned them, so the solver treats them as walls.
 */
async function getLockedBlocks(
  fromMin: EpochMinute,
  toMin: EpochMinute,
): Promise<PlacedBlock[]> {
  const supabase = await createClient();

  const { data: run } = await supabase
    .from("schedule_runs")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  if (!run) return [];

  const { data } = await supabase
    .from("scheduled_blocks")
    .select("task_id, starts_at, ends_at, sequence_index, is_locked, energy_score")
    .eq("run_id", run.id)
    .eq("is_locked", true)
    .lt("starts_at", fromEpochMinute(toMin).toISOString())
    .gt("ends_at", fromEpochMinute(fromMin).toISOString());

  return (data ?? []).map((b) => ({
    taskId: b.task_id,
    startsAt: toEpochMinute(new Date(b.starts_at)),
    endsAt: toEpochMinute(new Date(b.ends_at)),
    sequenceIndex: b.sequence_index,
    isLocked: true,
    energyScore: Number(b.energy_score ?? 1),
  }));
}

/**
 * Observed estimate:actual ratios, bucketed by subject and cognitive load.
 *
 * Derived from finished tasks rather than the estimation_calibration table so
 * there is one derivation path and no risk of a stale cache disagreeing with
 * the raw history.
 */
async function getCalibrationBuckets(): Promise<Map<string, Calibration>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tasks")
    .select("estimate_min, actual_min, subject_id, cognitive_load")
    .eq("status", "done")
    .gt("actual_min", 0)
    .limit(500);

  const samples: CompletedSample[] = (data ?? []).map((t) => ({
    estimateMin: t.estimate_min,
    actualMin: t.actual_min,
    subjectId: t.subject_id,
    cognitiveLoad: t.cognitive_load,
  }));

  return calibrateByBucket(samples);
}

/** Local date keys the student has written off inside the horizon. */
async function getWrittenOffDays(
  fromMin: EpochMinute,
  toMin: EpochMinute,
  timezone: string,
): Promise<string[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("day_write_offs")
    .select("day")
    .gte("day", localDateKey(fromMin, timezone))
    .lte("day", localDateKey(toMin, timezone));

  // Migration 009 may not be applied — no write-offs is a valid state.
  if (error) return [];
  return (data ?? []).map((r) => r.day as string);
}
