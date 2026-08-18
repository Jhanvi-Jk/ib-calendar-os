import type {
  EpochMinute,
  Minutes,
  SchedulableTask,
  Subject,
} from "@/lib/domain/types";
import { MIN_PER_DAY } from "@/lib/time";

/**
 * Priority weighting.
 *
 * Everything is scaled to integers before comparison. Two tasks whose weights
 * differ by 1e-15 would otherwise sort differently on different machines, and
 * the whole determinism guarantee would quietly be a lie.
 */

const SCALE = 1000;

export const WEIGHTS = {
  urgency: 100,
  slackPressure: 80,
  criticalPath: 60,
  gradeWeight: 40,
  userPin: 120,
  churn: 30,
} as const;

export interface WeightInputs {
  task: SchedulableTask;
  effectiveDeadline: EpochMinute | null;
  criticalPathMin: Minutes;
  maxCriticalPathMin: Minutes;
  /** Free minutes between now and this task's effective deadline. */
  capacityBeforeDeadline: Minutes;
  /** Total remaining work on this task's dependency chain. */
  chainRemainingMin: Minutes;
  subject: Subject | undefined;
  horizonStart: EpochMinute;
  horizonEnd: EpochMinute;
  /** Where this task sat in the previous run, if it did. */
  previousStart: EpochMinute | null;
}

export interface WeightResult {
  weight: number;
  urgency: number;
  slackPressure: number;
  /** True when the chain cannot fit before the deadline no matter the order. */
  atRisk: boolean;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function computeWeight(input: WeightInputs): WeightResult {
  const {
    task,
    effectiveDeadline,
    criticalPathMin,
    maxCriticalPathMin,
    capacityBeforeDeadline,
    chainRemainingMin,
    subject,
    horizonStart,
    horizonEnd,
  } = input;

  const horizonMin = Math.max(1, horizonEnd - horizonStart);

  // --- urgency: how close the deadline is, relative to the horizon ---------
  // Undated work gets a small non-zero urgency so it is not starved forever
  // by a permanent stream of dated work.
  const urgency =
    effectiveDeadline === null
      ? 0.15
      : clamp01(1 - (effectiveDeadline - horizonStart) / horizonMin);

  // --- slack pressure: is there room to breathe before the deadline? -------
  // slack < 0 means the chain provably cannot fit; pressure saturates at 1 and
  // the task is flagged at-risk rather than allowed to crowd out everything.
  const slack = capacityBeforeDeadline - chainRemainingMin;
  const slackPressure =
    chainRemainingMin <= 0 ? 0 : clamp01(1 - slack / chainRemainingMin);
  const atRisk = effectiveDeadline !== null && slack < 0;

  // --- critical path: long chains must start early -------------------------
  const criticalPath =
    maxCriticalPathMin <= 0 ? 0 : clamp01(criticalPathMin / maxCriticalPathMin);

  // --- grade weight: an IA worth 20% outranks a homework sheet -------------
  const gradeWeight = clamp01((subject?.gradeWeight ?? 1) / 2);

  // --- user pin: an explicit override should dominate the computed terms ---
  const userPin = task.priorityPin / 3;

  // --- churn: prefer leaving work where the user already saw it ------------
  // Only meaningful for tasks that were previously placed; a new task has
  // nothing to churn away from.
  const churn = input.previousStart === null ? 0 : 1;

  const weight =
    WEIGHTS.urgency * urgency +
    WEIGHTS.slackPressure * slackPressure +
    WEIGHTS.criticalPath * criticalPath +
    WEIGHTS.gradeWeight * gradeWeight +
    WEIGHTS.userPin * userPin -
    WEIGHTS.churn * churn;

  return {
    weight: Math.round(weight * SCALE),
    urgency,
    slackPressure,
    atRisk,
  };
}

/**
 * Total ordering over ready tasks. Every tie-break is deterministic, ending
 * at task id so the comparator is a strict total order.
 */
export function compareByPriority(
  a: { weight: number; task: SchedulableTask; effectiveDeadline: EpochMinute | null },
  b: { weight: number; task: SchedulableTask; effectiveDeadline: EpochMinute | null },
): number {
  if (a.weight !== b.weight) return b.weight - a.weight;

  const ad = a.effectiveDeadline ?? Number.MAX_SAFE_INTEGER;
  const bd = b.effectiveDeadline ?? Number.MAX_SAFE_INTEGER;
  if (ad !== bd) return ad - bd;

  if (a.task.remainingMin !== b.task.remainingMin) {
    return b.task.remainingMin - a.task.remainingMin;
  }
  return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
}

/** Days between two instants, for human-readable explanations. */
export const daysBetween = (a: EpochMinute, b: EpochMinute): number =>
  Math.round((b - a) / MIN_PER_DAY);
