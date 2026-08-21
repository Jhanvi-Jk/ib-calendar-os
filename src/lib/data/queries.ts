import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { toEpochMinute } from "@/lib/time";
import type {
  CapacitySettings,
  ConstraintTier,
  EnergyCurve,
  FixedEvent,
  PlacedBlock,
  SchedulableTask,
  Subject,
} from "@/lib/domain/types";
import { parseClock } from "@/lib/time";
import { expandTimetable, type TimetableEntry } from "@/lib/scheduling/timetable";

/** Server-side reads. Every one runs under RLS as the signed-in user. */

/**
 * Deduplicated per request.
 *
 * getUser() is a network round-trip to the auth server (~250ms). The layout
 * and the page both need the user, so without cache() a single navigation
 * paid for it two or three times over before any data loading began — which
 * is what made week navigation feel like the first click did nothing.
 */
export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export interface UserContext {
  userId: string;
  timezone: string;
  displayName: string | null;
  settings: CapacitySettings;
  /** Monday of a known Week A; null = single-week timetable. */
  timetableAnchorMonday: string | null;
}

export const getUserContext = cache(async (): Promise<UserContext | null> => {
  const supabase = await createClient();
  const user = await getSessionUser();
  if (!user) return null;

  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase.from("profiles").select("display_name, timezone").eq("id", user.id).single(),
    supabase.from("user_settings").select("*").eq("user_id", user.id).single(),
  ]);
  if (!settings) return null;

  return {
    userId: user.id,
    timezone: profile?.timezone ?? "UTC",
    displayName: profile?.display_name ?? null,
    timetableAnchorMonday: settings.timetable_anchor_monday ?? null,
    settings: {
      sleepStartMin: parseClock(settings.sleep_start),
      sleepEndMin: parseClock(settings.sleep_end),
      sleepProtected: settings.sleep_protected,
      dayStartMin: parseClock(settings.day_start),
      dayEndMin: parseClock(settings.day_end),
      maxDailyFocusMin: settings.max_daily_focus_min,
      minBlockMin: settings.min_block_min,
      maxBlockMin: settings.max_block_min,
      contextSwitchPenaltyMin: settings.context_switch_penalty_min,
      planningHorizonDays: settings.planning_horizon_days,
    },
  };
});

export async function getSubjects(): Promise<Subject[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("subjects")
    .select("id, name, level, ib_group, grade_weight, color_token")
    .eq("is_archived", false)
    .order("name");

  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    level: s.level,
    ibGroup: s.ib_group,
    gradeWeight: Number(s.grade_weight),
    colorToken: s.color_token,
  }));
}

/**
 * The weekly class pattern.
 *
 * Expanded on read rather than materialised into `events`: moving a period
 * then updates one row instead of a year of copies that can drift apart.
 */
export const getTimetableEntries = cache(async (): Promise<TimetableEntry[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("timetable_entries")
    .select(
      "id, subject_id, label, room, day_of_week, starts_min, ends_min, parity, active_from, active_to",
    )
    .order("day_of_week")
    .order("starts_min");

  // Migration 007 may not be applied yet. An absent table means "no
  // timetable", not a broken calendar.
  if (error) return [];

  return (data ?? []).map((t) => ({
    id: t.id,
    subjectId: t.subject_id,
    label: t.label,
    room: t.room,
    dayOfWeek: t.day_of_week,
    startsMin: t.starts_min,
    endsMin: t.ends_min,
    parity: t.parity,
    activeFrom: t.active_from,
    activeTo: t.active_to,
  }));
});

export async function getEvents(fromISO: string, toISO: string): Promise<FixedEvent[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("events")
    .select("id, title, starts_at, ends_at, tier, kind, is_locked, subject_id")
    .lt("starts_at", toISO)
    .gt("ends_at", fromISO)
    .order("starts_at");

  const stored: FixedEvent[] = (data ?? []).map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: toEpochMinute(new Date(e.starts_at)),
    endsAt: toEpochMinute(new Date(e.ends_at)),
    tier: e.tier as ConstraintTier,
    kind: e.kind,
    isLocked: e.is_locked,
    subjectId: e.subject_id,
  }));

  // Lessons join the event list here, so the calendar grid and the solver see
  // exactly the same classes — there is no second source of truth to diverge.
  const [ctx, entries] = await Promise.all([getUserContext(), getTimetableEntries()]);
  if (!ctx || entries.length === 0) return stored;

  const lessons = expandTimetable(entries, {
    from: toEpochMinute(new Date(fromISO)),
    to: toEpochMinute(new Date(toISO)),
    timezone: ctx.timezone,
    anchorMondayKey: ctx.timetableAnchorMonday,
  });

  return [...stored, ...lessons].sort((a, b) => a.startsAt - b.startsAt);
}

// Kept on one line deliberately: supabase-js infers row types from the select
// string, and a concatenated one degrades to `string`, losing all inference.
const TASK_COLUMNS =
  "id, title, subject_id, assessment_id, estimate_min, remaining_min, deadline_at, earliest_start_at, cognitive_load, splittable, min_chunk_min, max_chunk_min, priority_pin, status";

export async function getOpenTasks(): Promise<SchedulableTask[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .in("status", ["todo", "in_progress", "blocked"])
    .order("deadline_at", { nullsFirst: false });

  return (data ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    subjectId: t.subject_id,
    assessmentId: t.assessment_id,
    estimateMin: t.estimate_min,
    remainingMin: t.remaining_min,
    deadlineAt: t.deadline_at ? toEpochMinute(new Date(t.deadline_at)) : null,
    earliestStartAt: t.earliest_start_at
      ? toEpochMinute(new Date(t.earliest_start_at))
      : null,
    cognitiveLoad: t.cognitive_load as SchedulableTask["cognitiveLoad"],
    splittable: t.splittable,
    minChunkMin: t.min_chunk_min,
    maxChunkMin: t.max_chunk_min,
    priorityPin: t.priority_pin as SchedulableTask["priorityPin"],
    status: t.status,
  }));
}

export async function getDependencies() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("task_dependencies")
    .select("predecessor_id, successor_id, dep_type, lag_min");

  return (data ?? []).map((d) => ({
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    depType: d.dep_type as "FS" | "SS" | "FF",
    lagMin: d.lag_min,
  }));
}

export async function getEnergyCurve(): Promise<EnergyCurve> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("energy_profile")
    .select("dow, hour, multiplier");

  const curve: EnergyCurve = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 1),
  );
  for (const row of data ?? []) {
    curve[row.dow][row.hour] = Number(row.multiplier);
  }
  return curve;
}

export interface ActiveRun {
  id: string;
  createdAt: string;
  infeasibility: unknown[];
  stats: Record<string, unknown>;
  blocks: (PlacedBlock & { id: string; taskTitle: string; subjectId: string | null })[];
}

/**
 * The active schedule and its blocks in ONE round-trip.
 *
 * This used to be two sequential queries — fetch the run, then fetch its
 * blocks — which serialised two ~150ms trips to Supabase on every calendar
 * render. PostgREST can embed the child rows via the run_id foreign key, so
 * the whole thing is one request. cache() also stops the layout and the page
 * from each paying for it separately.
 */
export const getActiveRun = cache(async (): Promise<ActiveRun | null> => {
  const supabase = await createClient();
  const { data: run } = await supabase
    .from("schedule_runs")
    .select(
      "id, created_at, infeasibility, stats, scheduled_blocks(id, task_id, starts_at, ends_at, sequence_index, is_locked, energy_score, tasks(title, subject_id))",
    )
    .eq("is_active", true)
    .order("starts_at", { referencedTable: "scheduled_blocks" })
    .maybeSingle();
  if (!run) return null;

  return {
    id: run.id,
    createdAt: run.created_at,
    infeasibility: (run.infeasibility as unknown[]) ?? [],
    stats: (run.stats as Record<string, unknown>) ?? {},
    blocks: (run.scheduled_blocks ?? []).map((b) => {
      const task = b.tasks;
      return {
        id: b.id,
        taskId: b.task_id,
        taskTitle: task?.title ?? "Untitled",
        subjectId: task?.subject_id ?? null,
        startsAt: toEpochMinute(new Date(b.starts_at)),
        endsAt: toEpochMinute(new Date(b.ends_at)),
        sequenceIndex: b.sequence_index,
        isLocked: b.is_locked,
        energyScore: Number(b.energy_score ?? 1),
      };
    }),
  };
});
