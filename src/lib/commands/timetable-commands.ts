import { addDaysKey, dayNumberOf } from "@/lib/scheduling/dates";

/**
 * Turning "Cancel Thursday 27th teaching session" into a database write.
 *
 * Deliberately NOT a language model. A cancellation is a closed grammar — a
 * verb, a date and the name of something already in the timetable — and a
 * parser you can unit-test is both cheaper and safer than a model that might
 * hallucinate a date. It also needs no API key, and it keeps the rule that the
 * model never writes to the database trivially true, because there is no model.
 *
 * Pure: the reference date is injected, never read from the clock, so the same
 * sentence always resolves to the same day in a test.
 */

export interface CommandEntry {
  id: string;
  label: string;
  /** 0 = Sunday. */
  dayOfWeek: number;
}

export interface TimetableCommand {
  kind: "cancel" | "restore";
  entryId: string;
  /** The matched entry's label, echoed so the UI can confirm what it understood. */
  label: string;
  /** YYYY-MM-DD. */
  dateKey: string;
}

export type ParseResult =
  | { ok: true; command: TimetableCommand }
  | { ok: false; reason: string };

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const CANCEL_VERBS = ["cancel", "skip", "drop", "remove"];
const RESTORE_VERBS = ["restore", "uncancel", "reinstate", "unskip", "put back"];

/** Words that carry no meaning here and must not be matched against a label. */
const NOISE = new Set([
  ...CANCEL_VERBS, ...RESTORE_VERBS, ...Object.keys(WEEKDAYS),
  "session", "sessions", "class", "classes", "lesson", "lessons",
  "the", "my", "on", "at", "for", "this", "next", "of", "back", "and", "a",
]);

/**
 * 0 = Sunday. 1970-01-01 was a Thursday, so +4 aligns the modulo.
 *
 * `dayNumberOf` anchors at noon UTC to stay clear of DST, which means it
 * returns a half-integer (20692.5, not 20692). Flooring first is what makes
 * this an integer weekday — without it every comparison silently fails
 * against 4.5 and no command ever matches.
 */
function dowOf(dateKey: string): number {
  return (((Math.floor(dayNumberOf(dateKey)) + 4) % 7) + 7) % 7;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** "27th" / "3rd" / "27" -> 27. Rejects anything outside a month. */
function dayOfMonthFrom(tokens: string[]): number | null {
  for (const t of tokens) {
    const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(t);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= 31) return n;
  }
  return null;
}

function weekdayFrom(tokens: string[]): number | null {
  for (const t of tokens) {
    if (t in WEEKDAYS) return WEEKDAYS[t];
  }
  return null;
}

/**
 * Which concrete date the student meant.
 *
 * Searches a window around today and prefers the soonest date that has not
 * passed — "Thursday 27th" almost always means the one coming up, but allowing
 * a little of the past means you can still cancel yesterday's session to keep
 * the record honest.
 */
function resolveDate(
  todayKey: string,
  weekday: number | null,
  dayOfMonth: number | null,
): string | null {
  if (weekday === null && dayOfMonth === null) return null;

  const matches = (key: string) =>
    (weekday === null || dowOf(key) === weekday) &&
    (dayOfMonth === null || Number(key.slice(8, 10)) === dayOfMonth);

  for (let i = 0; i <= 180; i++) {
    const key = addDaysKey(todayKey, i);
    if (matches(key)) return key;
  }
  for (let i = 1; i <= 7; i++) {
    const key = addDaysKey(todayKey, -i);
    if (matches(key)) return key;
  }
  return null;
}

/**
 * Pick the timetable entry the words refer to.
 *
 * Scored by how many of the entry's own label words appear, so "teaching"
 * matches "Teaching" without also matching "C3 Maths AA". Ties are refused
 * rather than guessed: silently cancelling the wrong lesson is far worse than
 * asking again.
 */
function matchEntry(
  tokens: string[],
  entries: CommandEntry[],
): { entry: CommandEntry } | { error: string } {
  const words = new Set(tokens.filter((t) => !NOISE.has(t) && !/^\d/.test(t)));
  if (words.size === 0) return { error: "Name the thing to cancel, e.g. \"cancel Thursday 27th teaching\"." };

  const scored = entries
    .map((entry) => {
      const labelWords = tokenize(entry.label).filter((w) => !NOISE.has(w));
      const hits = labelWords.filter((w) => words.has(w)).length;
      return { entry, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) return { error: "Nothing in your timetable matches that name." };
  if (scored.length > 1 && scored[0].hits === scored[1].hits) {
    return {
      error: `That could be ${scored[0].entry.label} or ${scored[1].entry.label} — be more specific.`,
    };
  }
  return { entry: scored[0].entry };
}

/**
 * Whether this text is even trying to be a cancellation.
 *
 * The palette uses it to decide when to show a parse error. Without it, every
 * ordinary search ("plan", "tasks") would be met with "Start with cancel or
 * restore", which is noise rather than help.
 */
export function looksLikeTimetableCommand(text: string): boolean {
  const first = tokenize(text)[0];
  if (!first) return false;
  return CANCEL_VERBS.includes(first) || RESTORE_VERBS.some((v) => v.split(" ")[0] === first);
}

export function parseTimetableCommand(
  text: string,
  context: { entries: CommandEntry[]; todayKey: string },
): ParseResult {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { ok: false, reason: "Nothing to do." };

  const isRestore = RESTORE_VERBS.some((v) => tokens.includes(v.split(" ")[0]));
  const isCancel = CANCEL_VERBS.some((v) => tokens.includes(v));
  if (!isCancel && !isRestore) return { ok: false, reason: "Start with \"cancel\" or \"restore\"." };

  const matched = matchEntry(tokens, context.entries);
  if ("error" in matched) return { ok: false, reason: matched.error };

  const weekday = weekdayFrom(tokens);
  const dayOfMonth = dayOfMonthFrom(tokens);
  const dateKey = resolveDate(context.todayKey, weekday, dayOfMonth);
  if (!dateKey) {
    return {
      ok: false,
      reason: weekday === null && dayOfMonth === null
        ? "Say which day, e.g. \"cancel Thursday 27th teaching\"."
        : "No date in the next six months matches that.",
    };
  }

  // A date that is not the day this thing happens is almost always a typo, and
  // acting on it would create an exception that never fires.
  if (dowOf(dateKey) !== matched.entry.dayOfWeek) {
    return {
      ok: false,
      reason: `${matched.entry.label} does not run on ${dateKey}.`,
    };
  }

  return {
    ok: true,
    command: {
      kind: isRestore ? "restore" : "cancel",
      entryId: matched.entry.id,
      label: matched.entry.label,
      dateKey,
    },
  };
}
