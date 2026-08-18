import { createClient } from "@/lib/supabase/server";
import {
  addLocalDays,
  fromEpochMinute,
  startOfLocalDay,
  toEpochMinute,
} from "@/lib/time";
import {
  getDependencies,
  getEnergyCurve,
  getEvents,
  getOpenTasks,
  getSubjects,
  getUserContext,
} from "./queries";
import type { EpochMinute, PlacedBlock, SolverSnapshot } from "@/lib/domain/types";

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

  const [subjects, events, tasks, dependencies, energy, lockedBlocks] =
    await Promise.all([
      getSubjects(),
      getEvents(
        fromEpochMinute(horizonStart).toISOString(),
        fromEpochMinute(horizonEnd).toISOString(),
      ),
      getOpenTasks(),
      getDependencies(),
      getEnergyCurve(),
      getLockedBlocks(horizonStart, horizonEnd),
    ]);

  return {
    userId: ctx.userId,
    timezone,
    horizonStart,
    horizonEnd,
    settings,
    energy,
    subjects,
    events,
    tasks,
    dependencies,
    lockedBlocks,
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
