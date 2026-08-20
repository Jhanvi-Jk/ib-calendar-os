import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { loadSnapshot } from "@/lib/data/snapshot";
import { getActiveRun, getUserContext } from "@/lib/data/queries";
import { getRunningTimer } from "@/lib/data/analytics";
import { hashSnapshot } from "@/lib/scheduling/hash";
import { buildDayBudgets, buildFreeIntervals, effectiveDailyCapacity } from "@/lib/scheduling/capacity";
import { buildCountdowns, type AcademicDate, type CountdownBoard } from "@/lib/analytics/countdown";
import { computeRunway, type DayCapacity, type RunwayReport, type RunwayTask } from "@/lib/analytics/runway";
import { localDateKey, toEpochMinute } from "@/lib/time";

/**
 * Orientation data: where the year is, and whether the work fits in it.
 *
 * Both of these are read-only views over things the app already stores. The
 * judgement lives in src/lib/analytics/; this module only fetches and adapts.
 */

export const getAcademicDates = cache(async (): Promise<CountdownBoard> => {
  const supabase = await createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from("academic_dates")
    .select("id, kind, label, starts_on, ends_on, is_primary")
    .order("starts_on");

  // PGRST205 = the table is not in PostgREST's schema cache, i.e. migration
  // 006 has not been applied to this project yet. Deploys and migrations do
  // not land at the same instant, and a missing table must degrade to "no
  // dates" rather than taking the whole calendar page down with a 500.
  if (error && error.code === "PGRST205") {
    return { primary: null, upcoming: [], past: [] };
  }

  const dates: AcademicDate[] = (data ?? []).map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    startsOn: d.starts_on,
    endsOn: d.ends_on,
    isPrimary: d.is_primary,
  }));

  // "Today" in the STUDENT's timezone, not the server's. A student in Seoul
  // at 08:00 must not be told a deadline is a day further away because the
  // server is still on yesterday's date in UTC.
  const todayKey = localDateKey(toEpochMinute(new Date()), ctx?.timezone ?? "UTC");
  return buildCountdowns(dates, todayKey);
});

/**
 * Deadline pressure, measured against the solver's own capacity model.
 *
 * Reuses buildFreeIntervals/buildDayBudgets rather than re-deriving free time,
 * so the runway warning and the scheduler can never disagree about how many
 * hours exist — which would be worse than showing nothing.
 */
export const getRunway = cache(async (): Promise<RunwayReport> => {
  const ctx = await getUserContext();
  const snapshot = await loadSnapshot();

  if (!ctx || !snapshot) {
    return computeRunway([], [], "1970-01-01");
  }

  const free = buildFreeIntervals(snapshot);
  const budgets = buildDayBudgets(snapshot, free);

  const capacity: DayCapacity[] = [...budgets.values()].map((b) => ({
    dateKey: b.dateKey,
    capacityMin: effectiveDailyCapacity(b),
  }));

  const tasks: RunwayTask[] = snapshot.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    remainingMin: t.remainingMin,
    deadlineKey: t.deadlineAt === null ? null : localDateKey(t.deadlineAt, ctx.timezone),
  }));

  const todayKey = localDateKey(toEpochMinute(new Date()), ctx.timezone);
  return computeRunway(tasks, capacity, todayKey);
});

/**
 * Is the active plan still built from the current facts?
 *
 * schedule_runs.input_hash already records exactly what the solver saw. Re-
 * hashing the current snapshot and comparing is therefore a precise staleness
 * test rather than a guess based on updated_at timestamps.
 */
export const getPlanFreshness = cache(async (): Promise<{
  hasPlan: boolean;
  isStale: boolean;
}> => {
  const supabase = await createClient();
  const { data: run } = await supabase
    .from("schedule_runs")
    .select("input_hash")
    .eq("is_active", true)
    .maybeSingle();

  if (!run) return { hasPlan: false, isStale: false };

  const snapshot = await loadSnapshot();
  if (!snapshot) return { hasPlan: true, isStale: false };

  return { hasPlan: true, isStale: hashSnapshot(snapshot) !== run.input_hash };
});

/**
 * Whether the plan can be rebuilt without yanking the rug.
 *
 * Re-solving moves Tier 3 blocks. Doing that while the student is mid-session
 * — timer running, or inside a block right now — takes the thing they are
 * currently doing and slides it somewhere else. That is the one moment a
 * planner must not act on its own, so auto re-plan waits.
 */
export async function isSafeToAutoReplan(): Promise<boolean> {
  const [timer, run] = await Promise.all([getRunningTimer(), getActiveRun()]);
  if (timer) return false;

  const nowMin = toEpochMinute(new Date());
  const midBlock = (run?.blocks ?? []).some(
    (b) => b.startsAt <= nowMin && b.endsAt > nowMin,
  );
  return !midBlock;
}
