import type {
  CapacitySettings,
  DependencyEdge,
  EpochMinute,
  FixedEvent,
  SchedulableTask,
  SolverSnapshot,
  Subject,
} from "@/lib/domain/types";
import { flatEnergyCurve, seedEnergyCurve } from "@/lib/domain/energy";
import { toEpochMinute } from "@/lib/time";

/**
 * Snapshot builders for the solver tests.
 *
 * Everything is anchored to a fixed instant rather than "now" — a test that
 * reads the clock passes on Tuesday and fails on Sunday.
 */

/** Monday 2026-03-02, 00:00 UTC. */
export const MONDAY = toEpochMinute(new Date("2026-03-02T00:00:00Z"));

export const DEFAULT_SETTINGS: CapacitySettings = {
  sleepStartMin: 23 * 60,
  sleepEndMin: 7 * 60,
  sleepProtected: true,
  dayStartMin: 7 * 60 + 30,
  dayEndMin: 22 * 60 + 30,
  maxDailyFocusMin: 300,
  minBlockMin: 25,
  maxBlockMin: 120,
  contextSwitchPenaltyMin: 10,
  planningHorizonDays: 7,
};

export function subject(id: string, over: Partial<Subject> = {}): Subject {
  return {
    id,
    name: id,
    level: "HL",
    ibGroup: 4,
    gradeWeight: 1,
    colorToken: "neutral",
    ...over,
  };
}

export function task(
  id: string,
  over: Partial<SchedulableTask> = {},
): SchedulableTask {
  const estimate = over.estimateMin ?? over.remainingMin ?? 120;
  return {
    id,
    title: id,
    subjectId: null,
    assessmentId: null,
    estimateMin: estimate,
    remainingMin: over.remainingMin ?? estimate,
    deadlineAt: null,
    earliestStartAt: null,
    cognitiveLoad: 3,
    splittable: true,
    minChunkMin: 25,
    maxChunkMin: 120,
    priorityPin: 0,
    status: "todo",
    ...over,
  };
}

export function event(
  id: string,
  startsAt: EpochMinute,
  durationMin: number,
  over: Partial<FixedEvent> = {},
): FixedEvent {
  return {
    id,
    title: id,
    startsAt,
    endsAt: startsAt + durationMin,
    tier: 1,
    kind: "class",
    isLocked: false,
    subjectId: null,
    ...over,
  };
}

export function dep(
  predecessorId: string,
  successorId: string,
  over: Partial<DependencyEdge> = {},
): DependencyEdge {
  return { predecessorId, successorId, depType: "FS", lagMin: 0, ...over };
}

export function snapshot(over: Partial<SolverSnapshot> = {}): SolverSnapshot {
  return {
    userId: "user-1",
    timezone: "UTC",
    horizonStart: MONDAY,
    horizonEnd: MONDAY + 7 * 1440,
    settings: DEFAULT_SETTINGS,
    energy: flatEnergyCurve(),
    subjects: [],
    events: [],
    tasks: [],
    dependencies: [],
    lockedBlocks: [],
    seed: 0,
    ...over,
  };
}

export const larkEnergy = () => seedEnergyCurve("lark");
export const owlEnergy = () => seedEnergyCurve("owl");

/** Minutes from local midnight on `day`, for readable test assertions. */
export const at = (dayOffset: number, hour: number, minute = 0): EpochMinute =>
  MONDAY + dayOffset * 1440 + hour * 60 + minute;
