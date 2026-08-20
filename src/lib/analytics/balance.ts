import type { IbLevel, Minutes } from "@/lib/domain/types";

/**
 * Subject balance — where the hours actually went.
 *
 * Momentum answers "did you do what you planned". This answers the question a
 * coach asks first: "what did you neglect?" Students reliably over-invest in
 * subjects they enjoy or already lead in, and the shortfall in an HL subject
 * is invisible until a mock exam makes it expensive.
 *
 * HL subjects carry more of the diploma than SL, so equal time is not balance.
 * Expected share is weighted; the report compares observed against expected
 * rather than against a flat average.
 *
 * Pure — no clock, no I/O.
 */

export interface SubjectTime {
  subjectId: string;
  name: string;
  level: IbLevel;
  minutes: Minutes;
}

export interface SubjectShare extends SubjectTime {
  /** Fraction of all tracked time, 0–1. */
  share: number;
  /** Fraction this subject would get if time followed subject weight. */
  expectedShare: number;
  /** observed / expected. 1.0 is on balance; < 1 is under-served. */
  ratio: number;
  status: "neglected" | "light" | "balanced" | "heavy";
}

export interface BalanceReport {
  subjects: SubjectShare[];
  totalMin: Minutes;
  /** Enough tracked time to say anything at all. */
  hasEnoughData: boolean;
  /** Worst under-served subject, when one clearly stands out. */
  headline: string;
}

/**
 * Relative weight per level. HL is roughly 240 teaching hours against SL's 150,
 * and carries correspondingly more assessment — so it should absorb more study
 * time before the split counts as balanced. CORE (EE/TOK/CAS) is real work but
 * a smaller share of the diploma.
 */
const LEVEL_WEIGHT: Record<IbLevel, number> = { HL: 1.6, SL: 1, CORE: 0.7 };

/** Below this there is not enough tracked time for the split to mean anything. */
export const MIN_MINUTES_FOR_BALANCE = 120;

function classify(ratio: number): SubjectShare["status"] {
  if (ratio < 0.4) return "neglected";
  if (ratio < 0.75) return "light";
  if (ratio > 1.5) return "heavy";
  return "balanced";
}

export function subjectBalance(input: SubjectTime[]): BalanceReport {
  const totalMin = input.reduce((sum, s) => sum + s.minutes, 0);
  const totalWeight = input.reduce((sum, s) => sum + LEVEL_WEIGHT[s.level], 0);

  /*
   * When most subjects have no tracked time, "heavy" is a misleading label.
   * Three subjects sharing all the hours look like over-investment against a
   * per-subject target, but the real finding is that six subjects were never
   * opened. Calling the worked subjects "Heavy" reads as a reprimand for the
   * only work the student actually did.
   *
   * So the excess label is only used once most subjects are represented; below
   * that the report stays focused on the gaps.
   */
  const withTime = input.filter((s) => s.minutes > 0).length;
  const coverage = input.length === 0 ? 0 : withTime / input.length;
  const excessIsMeaningful = coverage >= 0.5;

  const subjects: SubjectShare[] = input
    .map((s) => {
      const share = totalMin === 0 ? 0 : s.minutes / totalMin;
      const expectedShare = totalWeight === 0 ? 0 : LEVEL_WEIGHT[s.level] / totalWeight;
      // A subject with no expected share cannot be under-served; treat as balanced.
      const ratio = expectedShare === 0 ? 1 : share / expectedShare;
      let status = classify(ratio);
      if (status === "heavy" && !excessIsMeaningful) status = "balanced";
      return {
        ...s,
        share,
        expectedShare,
        ratio: Math.round(ratio * 100) / 100,
        status,
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  const hasEnoughData = totalMin >= MIN_MINUTES_FOR_BALANCE && input.length > 1;

  return { subjects, totalMin, hasEnoughData, headline: headlineFor(subjects, hasEnoughData) };
}

function headlineFor(subjects: SubjectShare[], hasEnoughData: boolean): string {
  if (!hasEnoughData) {
    return "Track a couple of hours across subjects and this will show where your time is really going.";
  }

  const starved = subjects
    .filter((s) => s.status === "neglected" || s.status === "light")
    .sort((a, b) => a.ratio - b.ratio);

  if (starved.length === 0) {
    return "Your time is spread sensibly across your subjects.";
  }

  const worst = starved[0];
  const untouched = worst.minutes === 0;
  // Name the subject rather than scolding. The point is to make the gap
  // visible, not to make the student feel behind.
  if (untouched) {
    return `${worst.name} has had no tracked time at all. If that is deliberate, fine — if not, it is the cheapest thing to fix this week.`;
  }
  if (starved.length === 1) {
    return `${worst.name} is getting about ${Math.round(worst.ratio * 100)}% of the time its weight suggests.`;
  }
  return `${worst.name} and ${starved.length - 1} other ${
    starved.length === 2 ? "subject are" : "subjects are"
  } under-served relative to their weight.`;
}
