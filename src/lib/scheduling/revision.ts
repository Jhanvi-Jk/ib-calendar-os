import type { Minutes } from "@/lib/domain/types";
import { addDaysKey, dayNumberOf } from "./dates";

/**
 * Spaced revision passes.
 *
 * Intervals are the student's own: a first pass 1-3 days after the trigger,
 * then day 7, then day 13, then a final pass immediately before the exams.
 * The expanding gap is the point — each successful recall at a longer delay
 * buys a longer one after it.
 *
 * Passes are emitted as WINDOWS, not fixed dates. "Revise this on day 7" is a
 * worse instruction than "revise this between day 5 and day 8", because the
 * solver knows where the free time actually is and a fixed date that lands on
 * a written-off day or a triple-lesson Wednesday just gets missed.
 *
 * Pure — no clock, no I/O.
 */

export interface RevisionIntervals {
  /** Each pass: how soon it may happen, and by when it must. Days from trigger. */
  windows: Array<{ earliest: number; due: number }>;
  /** Days before the exam session starts for the final pass. */
  preExamEarliest: number;
  preExamDue: number;
}

/**
 * The default cycle: 1-3 days, ~7 days, ~13 days, then pre-exam.
 *
 * The later windows widen because precision stops mattering as the gap grows —
 * a day-13 pass on day 15 is fine, a day-1 pass on day 3 is not.
 */
export const DEFAULT_INTERVALS: RevisionIntervals = {
  windows: [
    { earliest: 1, due: 3 },
    { earliest: 6, due: 8 },
    { earliest: 11, due: 15 },
  ],
  preExamEarliest: 21,
  preExamDue: 7,
};

export interface RevisionTopic {
  id: string;
  label: string;
  subjectId: string | null;
  /** 1 = no idea .. 5 = solid. */
  confidence: number;
  /** YYYY-MM-DD the cycle was triggered. */
  triggeredOn: string;
}

export interface RevisionPassSpec {
  topicId: string;
  passIndex: number;
  isPreExam: boolean;
  earliestOn: string;
  dueOn: string;
  estimateMin: Minutes;
}

/**
 * Minutes for a pass.
 *
 * The first pass is the longest — that is where the relearning happens. Later
 * passes are retrieval practice and should be short, or they stop being
 * spaced repetition and turn into re-reading, which does very little.
 *
 * Shaky topics get more time, but the shape stays the same.
 */
export function passMinutes(confidence: number, passIndex: number, isPreExam: boolean): Minutes {
  const base = confidence <= 2 ? 45 : confidence === 3 ? 35 : 25;
  if (isPreExam) return Math.round(base * 0.8);
  const decay = [1, 0.7, 0.6][passIndex] ?? 0.6;
  return Math.max(15, Math.round((base * decay) / 5) * 5);
}

export function planRevisionPasses(
  topic: RevisionTopic,
  options: {
    /** First day of the exam session, YYYY-MM-DD. Null = no pre-exam pass yet. */
    examStartsOn: string | null;
    intervals?: RevisionIntervals;
    /** Pass indices already scheduled, so generation is idempotent. */
    existingPassIndices?: Set<number>;
  },
): RevisionPassSpec[] {
  const intervals = options.intervals ?? DEFAULT_INTERVALS;
  const existing = options.existingPassIndices ?? new Set<number>();
  const specs: RevisionPassSpec[] = [];

  intervals.windows.forEach((w, i) => {
    if (existing.has(i)) return;
    specs.push({
      topicId: topic.id,
      passIndex: i,
      isPreExam: false,
      earliestOn: addDaysKey(topic.triggeredOn, w.earliest),
      dueOn: addDaysKey(topic.triggeredOn, w.due),
      estimateMin: passMinutes(topic.confidence, i, false),
    });
  });

  // The pre-exam pass is anchored to the exam, not the trigger, and is only
  // worth scheduling once it lands after the spaced passes — otherwise a topic
  // flagged three weeks before exams would get two passes on the same day.
  const preExamIndex = intervals.windows.length;
  if (options.examStartsOn && !existing.has(preExamIndex)) {
    const earliestOn = addDaysKey(options.examStartsOn, -intervals.preExamEarliest);
    const dueOn = addDaysKey(options.examStartsOn, -intervals.preExamDue);
    const lastSpaced = addDaysKey(
      topic.triggeredOn,
      intervals.windows.at(-1)?.due ?? 0,
    );
    if (dayNumberOf(earliestOn) > dayNumberOf(lastSpaced)) {
      specs.push({
        topicId: topic.id,
        passIndex: preExamIndex,
        isPreExam: true,
        earliestOn,
        dueOn,
        estimateMin: passMinutes(topic.confidence, preExamIndex, true),
      });
    }
  }

  return specs;
}

/**
 * A pass that was missed is not simply late — the spacing it was buying is
 * gone. Restarting the cycle from today is more honest than pretending a
 * day-7 pass done on day 30 did its job.
 */
export function shouldRestartCycle(
  missedDueOn: string,
  todayKey: string,
  graceDays = 7,
): boolean {
  return dayNumberOf(todayKey) - dayNumberOf(missedDueOn) > graceDays;
}
