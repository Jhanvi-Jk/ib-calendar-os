/**
 * The contract between the database and the scheduling engine.
 *
 * Two rules hold everywhere below, and the determinism of the solver depends
 * on both:
 *
 *   1. Durations are INTEGER MINUTES. Never floats, never milliseconds.
 *   2. Instants crossing the solver boundary are epoch minutes (UTC), not
 *      Date objects. Dates carry a mutable timezone context and compare by
 *      identity in ways that make "same input, same output" untestable.
 */

/** Whole minutes. */
export type Minutes = number;

/** Whole minutes since the Unix epoch, UTC. */
export type EpochMinute = number;

/** 1 = immutable … 5 = recovery. Lower binds harder. */
export type ConstraintTier = 1 | 2 | 3 | 4 | 5;

export type IbLevel = "HL" | "SL" | "CORE";
export type DependencyType = "FS" | "SS" | "FF";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "dropped";

export interface Subject {
  id: string;
  name: string;
  level: IbLevel;
  ibGroup: number | null;
  gradeWeight: number;
  colorToken: string;
}

/** Fixed in time. The solver reads these and schedules around them. */
export interface FixedEvent {
  id: string;
  title: string;
  startsAt: EpochMinute;
  endsAt: EpochMinute;
  tier: ConstraintTier;
  kind: "class" | "exam" | "appointment" | "sleep" | "commitment" | "travel" | "general";
  isLocked: boolean;
  subjectId: string | null;
}

/** Duration and deadline, but no position. The solver assigns position. */
export interface SchedulableTask {
  id: string;
  title: string;
  subjectId: string | null;
  assessmentId: string | null;

  remainingMin: Minutes;
  estimateMin: Minutes;

  /** The user-facing due date. May be null for undated work. */
  deadlineAt: EpochMinute | null;
  earliestStartAt: EpochMinute | null;

  /** 1 = admin busywork … 5 = deep analytical work. Matched against the energy curve. */
  cognitiveLoad: 1 | 2 | 3 | 4 | 5;

  splittable: boolean;
  minChunkMin: Minutes;
  maxChunkMin: Minutes;

  /** User override, 0–3. Dominates the computed weight when set. */
  priorityPin: 0 | 1 | 2 | 3;
  status: TaskStatus;
}

export interface DependencyEdge {
  predecessorId: string;
  successorId: string;
  depType: DependencyType;
  lagMin: Minutes;
}

export interface CapacitySettings {
  /** Wall-clock minutes from local midnight. */
  sleepStartMin: Minutes;
  sleepEndMin: Minutes;
  sleepProtected: boolean;
  dayStartMin: Minutes;
  dayEndMin: Minutes;

  maxDailyFocusMin: Minutes;
  /**
   * Per-weekday override, keyed 0-6 with 0 = Sunday. A missing day falls back
   * to maxDailyFocusMin. One flat number models a week nobody has: a
   * self-study day and a day with seven hours of lessons are not the same
   * size.
   */
  maxDailyFocusByDow?: Partial<Record<number, Minutes>>;
  minBlockMin: Minutes;
  maxBlockMin: Minutes;
  contextSwitchPenaltyMin: Minutes;
  planningHorizonDays: number;
}

/** 168 multipliers, indexed [dayOfWeek 0–6][hour 0–23]. */
export type EnergyCurve = number[][];

/**
 * The frozen input to a solve. Hashing this produces schedule_runs.input_hash;
 * an identical hash with an identical seed MUST yield identical output.
 */
export interface SolverSnapshot {
  userId: string;
  timezone: string;
  horizonStart: EpochMinute;
  horizonEnd: EpochMinute;

  settings: CapacitySettings;
  energy: EnergyCurve;

  subjects: Subject[];
  events: FixedEvent[];
  tasks: SchedulableTask[];
  dependencies: DependencyEdge[];

  /** Blocks the user pinned. Carried into the new run untouched. */
  lockedBlocks: PlacedBlock[];

  /**
   * Local date keys the student has written off — illness, family, burnout.
   * These days have zero capacity: the solver moves the work rather than
   * leaving it to become an overdue pile.
   */
  writtenOffDays: string[];

  seed: number;
}

export interface PlacedBlock {
  taskId: string;
  startsAt: EpochMinute;
  endsAt: EpochMinute;
  sequenceIndex: number;
  isLocked: boolean;
  energyScore: number;
}

/**
 * Work that could not be placed. Never silently dropped and never allowed to
 * overflow protected time — surfaced as a decision for the user instead.
 */
export interface Infeasibility {
  taskId: string;
  shortfallMin: Minutes;
  reason:
    | "insufficient_capacity"
    | "deadline_passed"
    | "blocked_by_dependency"
    | "window_too_narrow";
  /** Ranked, actionable. The UI renders these as buttons, not prose. */
  remedies: Array<{
    kind: "extend_horizon" | "reduce_scope" | "demote_elastic" | "move_deadline" | "split_task";
    detail: string;
    recoveredMin: Minutes;
  }>;
}

export interface SolveResult {
  blocks: PlacedBlock[];
  infeasibility: Infeasibility[];
  stats: {
    tasksPlaced: number;
    tasksPartial: number;
    totalScheduledMin: Minutes;
    capacityUtilisation: number;
    /** Blocks whose position changed vs the previous run. Lower is better. */
    churnedBlocks: number;
  };
}

/** Rolling 7-day health. Deliberately not a streak. */
export type MomentumState = "thriving" | "steady" | "strained" | "recovering";
