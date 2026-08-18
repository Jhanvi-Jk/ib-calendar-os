import type { Minutes } from "@/lib/domain/types";

/**
 * Estimate calibration — turning "I thought it'd take an hour" into data.
 *
 * The loop: the AI (or the student) guesses, time_entries record what actually
 * happened, and this module converts the gap into a multiplier. After enough
 * samples the empirical p80 outranks any model's guess, because it is derived
 * from this specific student's behaviour on this specific subject.
 *
 * Pure — no clock, no I/O.
 */

export interface CompletedSample {
  estimateMin: Minutes;
  actualMin: Minutes;
  subjectId: string | null;
  cognitiveLoad: number;
}

export interface Calibration {
  ratioP50: number;
  /** The planning number: right 80% of the time rather than on average. */
  ratioP80: number;
  samples: number;
  /** False until there is enough data to outrank a model estimate. */
  isReliable: boolean;
}

/** Below this, the sample is noise and the model's guess is still better. */
export const RELIABILITY_THRESHOLD = 8;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 1;
  if (sorted.length === 1) return sorted[0];
  // Linear interpolation between the two nearest ranks.
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function calibrate(samples: CompletedSample[]): Calibration {
  const ratios = samples
    .filter((s) => s.estimateMin > 0 && s.actualMin > 0)
    .map((s) => s.actualMin / s.estimateMin)
    // A 20x ratio is a forgotten timer, not a slow student. Clamping stops one
    // bad row from permanently inflating every future estimate.
    .map((r) => Math.min(r, 5))
    .sort((a, b) => a - b);

  if (ratios.length === 0) {
    return { ratioP50: 1, ratioP80: 1, samples: 0, isReliable: false };
  }

  return {
    ratioP50: round2(percentile(ratios, 0.5)),
    ratioP80: round2(percentile(ratios, 0.8)),
    samples: ratios.length,
    isReliable: ratios.length >= RELIABILITY_THRESHOLD,
  };
}

/** Groups samples by (subject, cognitive load) — the key the solver looks up. */
export function calibrateByBucket(
  samples: CompletedSample[],
): Map<string, Calibration> {
  const buckets = new Map<string, CompletedSample[]>();
  for (const sample of samples) {
    const key = bucketKey(sample.subjectId, sample.cognitiveLoad);
    const list = buckets.get(key) ?? [];
    list.push(sample);
    buckets.set(key, list);
  }

  const out = new Map<string, Calibration>();
  for (const [key, list] of buckets) out.set(key, calibrate(list));
  return out;
}

export const bucketKey = (subjectId: string | null, cognitiveLoad: number): string =>
  `${subjectId ?? "none"}:${cognitiveLoad}`;

/**
 * Applies calibration to a raw estimate.
 *
 * Uses p80 rather than the median on purpose: planning to the average means
 * running late half the time, which is exactly the experience that makes
 * students stop trusting a planner.
 */
export function adjustEstimate(
  estimateMin: Minutes,
  calibration: Calibration | undefined,
): Minutes {
  if (!calibration || !calibration.isReliable) return estimateMin;
  return Math.max(5, Math.round(estimateMin * calibration.ratioP80));
}

export interface AccuracyReport {
  totalTasks: number;
  /** Finished within ±20% of the estimate. */
  onTarget: number;
  underestimated: number;
  overestimated: number;
  medianRatio: number;
  headline: string;
}

export function accuracyReport(samples: CompletedSample[]): AccuracyReport {
  const usable = samples.filter((s) => s.estimateMin > 0 && s.actualMin > 0);
  if (usable.length === 0) {
    return {
      totalTasks: 0,
      onTarget: 0,
      underestimated: 0,
      overestimated: 0,
      medianRatio: 1,
      headline: "Track some work to see how your estimates hold up.",
    };
  }

  let onTarget = 0;
  let under = 0;
  let over = 0;
  for (const sample of usable) {
    const ratio = sample.actualMin / sample.estimateMin;
    if (ratio > 1.2) under++;
    else if (ratio < 0.8) over++;
    else onTarget++;
  }

  const median = calibrate(usable).ratioP50;

  return {
    totalTasks: usable.length,
    onTarget,
    underestimated: under,
    overestimated: over,
    medianRatio: median,
    headline: headlineFor(median, onTarget / usable.length),
  };
}

function headlineFor(median: number, onTargetRate: number): string {
  if (onTargetRate >= 0.6) return "Your estimates are reliable.";
  if (median > 1.25) {
    return `Work takes about ${Math.round((median - 1) * 100)}% longer than you expect. Plans now account for that.`;
  }
  if (median < 0.8) {
    return "You finish faster than you expect — there's more room in your week than it feels like.";
  }
  return "Your estimates are inconsistent, but not biased in either direction.";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
