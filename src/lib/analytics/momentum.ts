import type { Minutes, MomentumState } from "@/lib/domain/types";

/**
 * Momentum Health — the replacement for streaks.
 *
 * Directive #4. A streak has exactly one failure mode and it is catastrophic:
 * miss one day and the counter resets to zero, which punishes illness, family
 * emergencies and rest. Momentum is a rolling ratio, so a bad day moves the
 * number rather than erasing progress, and it recovers on its own.
 *
 * Pure functions — no clock, no I/O.
 */

export interface DayRecord {
  /** Local date key, YYYY-MM-DD. */
  date: string;
  plannedMin: Minutes;
  completedMin: Minutes;
}

export interface MomentumResult {
  ratio: number;
  state: MomentumState;
  plannedMin: Minutes;
  completedMin: Minutes;
  /** Days in the window with no planned work — excluded from the ratio. */
  restDays: number;
}

/** Thresholds chosen so "steady" is a wide, comfortable band. */
const THRIVING_AT = 0.9;
const STEADY_AT = 0.6;

export function computeMomentum(
  history: DayRecord[],
  options: { windowDays?: number; previousState?: MomentumState } = {},
): MomentumResult {
  const windowDays = options.windowDays ?? 7;

  const window = [...history]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, windowDays);

  // A day with nothing planned is a rest day, not a failure. Counting it as
  // 0/0 would drag the ratio down for taking a deliberate break.
  const active = window.filter((d) => d.plannedMin > 0);
  const restDays = window.length - active.length;

  const plannedMin = active.reduce((sum, d) => sum + d.plannedMin, 0);
  const completedMin = active.reduce((sum, d) => sum + d.completedMin, 0);

  // Completing more than planned does not push the ratio above 1: over-work
  // is not health, and letting it mask a bad week would defeat the metric.
  const ratio = plannedMin === 0 ? 1 : Math.min(1, completedMin / plannedMin);

  return {
    ratio: Math.round(ratio * 1000) / 1000,
    state: classify(ratio, options.previousState),
    plannedMin,
    completedMin,
    restDays,
  };
}

function classify(ratio: number, previous?: MomentumState): MomentumState {
  if (ratio >= THRIVING_AT) return "thriving";
  if (ratio >= STEADY_AT) {
    // Climbing out of a bad patch is its own state. Jumping straight back to
    // "steady" hides the effort; "recovering" acknowledges it.
    return previous === "strained" || previous === "recovering"
      ? "recovering"
      : "steady";
  }
  return "strained";
}

export const MOMENTUM_COPY: Record<MomentumState, { label: string; detail: string }> = {
  thriving: {
    label: "Thriving",
    detail: "You're doing what you planned. Keep the plan honest and this holds.",
  },
  steady: {
    label: "Steady",
    detail: "Most of the plan is landing. This is a sustainable place to be.",
  },
  strained: {
    label: "Strained",
    detail: "The plan is asking more than the week allows. Recovery blocks added.",
  },
  recovering: {
    label: "Recovering",
    detail: "You're climbing back. The plan has been eased while you do.",
  },
};

/**
 * The Recovery Protocol.
 *
 * When momentum drops, the response is to shrink the plan — never to demand
 * more hours. Returns adjustments the solver applies on its next run.
 */
export interface RecoveryPlan {
  /** Multiplier applied to max_daily_focus_min for the next few days. */
  focusScale: number;
  /** Compress Tier 4 elastic work to free capacity. */
  compressElastic: boolean;
  /** Re-baseline estimates from observed data rather than the old guesses. */
  recalibrateEstimates: boolean;
  message: string;
}

export function recoveryPlanFor(state: MomentumState): RecoveryPlan | null {
  switch (state) {
    case "strained":
      return {
        focusScale: 0.7,
        compressElastic: true,
        recalibrateEstimates: true,
        message:
          "This week asked more than there was room for. The next few days are lighter, and estimates have been re-based on how long things actually take you.",
      };
    case "recovering":
      return {
        focusScale: 0.85,
        compressElastic: true,
        recalibrateEstimates: false,
        message: "Easing back up. Capacity is still slightly reduced while you catch up.",
      };
    default:
      return null;
  }
}

/** Contribution heatmap intensity, 0–4. */
export function heatLevel(record: DayRecord): 0 | 1 | 2 | 3 | 4 {
  if (record.completedMin === 0) return 0;
  if (record.completedMin < 30) return 1;
  if (record.completedMin < 90) return 2;
  if (record.completedMin < 180) return 3;
  return 4;
}
