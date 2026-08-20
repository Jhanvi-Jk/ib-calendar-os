/**
 * Countdowns to the school year's fixed landmarks.
 *
 * Every student at this level already runs this clock in their head. Making it
 * explicit costs nothing and removes a background anxiety — and it changes
 * behaviour: "41 days" reads very differently from "May".
 *
 * All arithmetic is on YYYY-MM-DD strings via UTC noon, deliberately. Counting
 * days by subtracting timestamps breaks across DST (a "day" is sometimes 23
 * hours) and anchoring at midnight makes the result sensitive to the viewer's
 * timezone. Noon UTC is far enough from either boundary that neither matters.
 *
 * Pure — no clock, no I/O. `todayKey` is supplied by the caller.
 */

export type AcademicDateKind =
  | "exam_session"
  | "mock_exams"
  | "term_start"
  | "term_end"
  | "half_term"
  | "holiday"
  | "coursework_deadline";

export interface AcademicDate {
  id: string;
  kind: AcademicDateKind;
  label: string;
  /** YYYY-MM-DD */
  startsOn: string;
  /** YYYY-MM-DD, or null for a single-day landmark. */
  endsOn: string | null;
  isPrimary: boolean;
}

export interface Countdown extends AcademicDate {
  /** Days until it starts. 0 = today. Negative once started. */
  daysUntilStart: number;
  /** Days until it ends, when it is a range. */
  daysUntilEnd: number | null;
  /** True while today falls inside [startsOn, endsOn]. */
  isActive: boolean;
  isPast: boolean;
  /** "in 41 days", "starts tomorrow", "ends Friday", "today". */
  phrase: string;
}

const MS_PER_DAY = 86_400_000;

/** YYYY-MM-DD -> epoch ms at noon UTC. Throws on malformed input. */
export function dayNumber(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Not a YYYY-MM-DD date key: ${key}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) / MS_PER_DAY;
}

export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round(dayNumber(toKey) - dayNumber(fromKey));
}

function phraseFor(days: number, noun: "starts" | "ends"): string {
  if (days === 0) return noun === "starts" ? "starts today" : "ends today";
  if (days === 1) return `${noun} tomorrow`;
  if (days === -1) return `${noun === "starts" ? "started" : "ended"} yesterday`;
  if (days < 0) return `${noun === "starts" ? "started" : "ended"} ${-days} days ago`;
  return `${noun} in ${days} days`;
}

export function toCountdown(date: AcademicDate, todayKey: string): Countdown {
  const daysUntilStart = daysBetween(todayKey, date.startsOn);
  const daysUntilEnd = date.endsOn ? daysBetween(todayKey, date.endsOn) : null;

  const isActive =
    daysUntilStart <= 0 && (daysUntilEnd === null ? daysUntilStart === 0 : daysUntilEnd >= 0);
  const isPast = daysUntilEnd === null ? daysUntilStart < 0 : daysUntilEnd < 0;

  // While something is running, the useful number is when it ENDS. Nobody
  // needs "started 3 days ago" for a half term they are currently sitting in.
  const phrase = isActive && daysUntilEnd !== null
    ? phraseFor(daysUntilEnd, "ends")
    : phraseFor(daysUntilStart, "starts");

  return { ...date, daysUntilStart, daysUntilEnd, isActive, isPast, phrase };
}

export interface CountdownBoard {
  /** The year's anchor — usually the exam session. */
  primary: Countdown | null;
  /** Upcoming and currently-running landmarks, soonest first. */
  upcoming: Countdown[];
  /** Everything already finished, most recent first. */
  past: Countdown[];
}

export function buildCountdowns(
  dates: AcademicDate[],
  todayKey: string,
  options: { upcomingLimit?: number } = {},
): CountdownBoard {
  const limit = options.upcomingLimit ?? 4;
  const all = dates.map((d) => toCountdown(d, todayKey));

  // The anchor stays pinned even once the session has begun — during exams it
  // is the single most relevant number on the screen.
  const primary = all.find((c) => c.isPrimary && !c.isPast) ?? null;

  const upcoming = all
    .filter((c) => !c.isPast && c.id !== primary?.id)
    .sort((a, b) =>
      a.daysUntilStart - b.daysUntilStart || a.label.localeCompare(b.label),
    )
    .slice(0, limit);

  const past = all
    .filter((c) => c.isPast)
    .sort((a, b) => b.daysUntilStart - a.daysUntilStart);

  return { primary, upcoming, past };
}

/**
 * Study days — not calendar days — between now and a landmark.
 *
 * The number that actually matters before an exam. "60 days" sounds like
 * plenty; "eight free Saturdays and the weekday evenings" does not, and the
 * second one is the truth. Holidays are added back because they are study
 * capacity, not lost time.
 */
export function studyDaysUntil(
  todayKey: string,
  targetKey: string,
  breaks: Array<{ startsOn: string; endsOn: string | null; kind: AcademicDateKind }>,
): { calendarDays: number; inBreak: number } {
  const calendarDays = Math.max(0, daysBetween(todayKey, targetKey));
  const from = dayNumber(todayKey);
  const to = dayNumber(targetKey);

  let inBreak = 0;
  for (const b of breaks) {
    if (b.kind !== "half_term" && b.kind !== "holiday") continue;
    const s = Math.max(from, dayNumber(b.startsOn));
    const e = Math.min(to, dayNumber(b.endsOn ?? b.startsOn));
    if (e >= s) inBreak += Math.round(e - s) + 1;
  }

  return { calendarDays, inBreak: Math.min(inBreak, calendarDays) };
}
