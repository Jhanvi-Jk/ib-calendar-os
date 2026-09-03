import { addDaysKey, dayNumberOf } from "@/lib/scheduling/dates";
import {
  parseTimetableCommand,
  type CommandEntry,
  type TimetableCommand,
} from "./timetable-commands";

/**
 * The chat box grammar.
 *
 * Deliberately a parser, not a language model. Everything here is a closed
 * form — a verb, a time, a day, a name — and a parser you can unit-test is
 * cheaper, needs no API key, cannot invent a date, and keeps "the model never
 * writes to the database" trivially true because there is no model.
 *
 * Every intent is described back to the student in words before anything is
 * written, so a misreading is caught before it moves their evening rather
 * than after.
 *
 * Pure: the reference date is injected, never read from the clock.
 */

export interface BlockTimeIntent {
  kind: "block_time";
  dateKey: string;
  startMin: number;
  endMin: number;
  label: string;
}

export interface SimpleIntent {
  kind: "finished_early" | "replan" | "write_off_today";
}

export interface LessonIntent {
  kind: "lesson";
  command: TimetableCommand;
}

export type ChatIntent = BlockTimeIntent | SimpleIntent | LessonIntent;

export type ChatResult =
  | { ok: true; intent: ChatIntent; summary: string }
  | { ok: false; reason: string };

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** Always a block. Without a time range these ask for one. */
const BLOCK_VERBS = ["block", "busy", "hold", "reserve", "booked", "away"];

/**
 * Ambiguous: a time range makes them a block, no range makes them a lesson.
 * "cancel 4th September 5am to 10pm for MUN" is a day being taken away from
 * you; "cancel Thursday teaching" is a lesson being called off.
 */
const AMBIGUOUS_VERBS = ["cancel", "skip", "off", "out"];

const ALL_BLOCK_VERBS = [
  ...BLOCK_VERBS, ...AMBIGUOUS_VERBS,
];

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

/** The time range, matched once so its digits cannot be mistaken for a date. */
const RANGE_RE =
  /(\d{1,2}(?::|\.)?\d{0,2})\s*(am|pm)?\s*(?:to|until|till|-|–|—)\s*(\d{1,2}(?::|\.)?\d{0,2})\s*(am|pm)?/;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9:.\s-]/g, " ");

/** 0 = Sunday. dayNumberOf is noon-anchored, so floor before the modulo. */
function dowOf(dateKey: string): number {
  return (((Math.floor(dayNumberOf(dateKey)) + 4) % 7) + 7) % 7;
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * "7", "7pm", "19:00", "7.30" -> minutes from midnight.
 *
 * A bare hour is resolved against the other end of the range and the fact that
 * nobody blocks out 7am-9am for family dinner: bare 1-9 is read as afternoon
 * unless the sentence says am.
 */
function parseClock(raw: string, meridiem: string | null, preferPm: boolean): number | null {
  const m = /^(\d{1,2})(?::|\.)?(\d{2})?$/.exec(raw);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;

  if (meridiem === "pm" && h < 12) h += 12;
  else if (meridiem === "am" && h === 12) h = 0;
  else if (!meridiem && preferPm && h >= 1 && h <= 9) h += 12;

  return h * 60 + min;
}

/**
 * "4th September", "4 Sept", "September 4" -> a date key.
 *
 * Resolved forwards: a month already past means next year, so booking the 4th
 * of September in December does not silently land nine months ago.
 */
function explicitDate(tokens: string[], todayKey: string): string | null {
  let day: number | null = null;
  let month: number | null = null;
  for (const t of tokens) {
    const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 31 && day === null) day = n;
    }
    if (t in MONTHS && month === null) month = MONTHS[t];
  }
  if (day === null || month === null) return null;
  // Captured so the null-narrowing survives into the loop closure below.
  const dd = day;
  const mm = month;

  const year = Number(todayKey.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, "0");
  for (const y of [year, year + 1]) {
    const key = `${y}-${pad(mm)}-${pad(dd)}`;
    // Reject 31 February rather than letting Date roll it into March.
    const d = new Date(`${key}T12:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.getUTCDate() !== dd) return null;
    if (key >= todayKey) return key;
  }
  return null;
}

function resolveDay(tokens: string[], todayKey: string): string {
  const explicit = explicitDate(tokens, todayKey);
  if (explicit) return explicit;
  if (tokens.includes("tomorrow")) return addDaysKey(todayKey, 1);
  if (tokens.some((t) => t === "today" || t === "tonight")) return todayKey;

  for (const t of tokens) {
    if (t in WEEKDAYS) {
      const want = WEEKDAYS[t];
      for (let i = 0; i <= 7; i++) {
        const key = addDaysKey(todayKey, i);
        if (dowOf(key) === want) return key;
      }
    }
  }
  // No day named: the thing you are blocking is almost always today.
  return todayKey;
}

function parseBlock(text: string, todayKey: string): ChatResult {
  const lowered = norm(text);
  const range = RANGE_RE.exec(lowered);
  if (!range) {
    return { ok: false, reason: 'Give me a time range, like "block 7 to 9 tonight for family".' };
  }

  /*
   * Bare hours are genuinely ambiguous: "7 to 9" is the evening, "9 to 5" is
   * the working day. Rather than one heuristic that has to be wrong half the
   * time, try the readings in order of likelihood and take the first that
   * produces a sane span.
   */
  const readings: Array<[boolean, boolean]> = [
    [true, true],   // both afternoon — "7 to 9"
    [false, true],  // morning to afternoon — "9 to 5"
    [false, false], // both morning — "6 to 8"
  ];
  let startMin: number | null = null;
  let endMin: number | null = null;
  for (const [pmStart, pmEnd] of readings) {
    const a = parseClock(range[1], range[2] ?? null, pmStart);
    let b = parseClock(range[3], range[4] ?? range[2] ?? null, pmEnd);
    if (a === null || b === null) continue;
    // "11 to 1" crosses noon.
    if (b <= a && !range[4] && !range[2]) b += 12 * 60;
    // Nobody blocks out more than fourteen hours by accident.
    if (b > a && b <= 24 * 60 && b - a <= 18 * 60) {
      startMin = a;
      endMin = b;
      break;
    }
  }
  if (startMin === null || endMin === null) {
    return { ok: false, reason: "I couldn't make sense of those times." };
  }

  // Strip the range before looking for a date, or "5 to 10" donates a 5 and a
  // 10 to the day-of-month parser and the block lands in the wrong week.
  const withoutRange = lowered.replace(range[0], " ");
  const dateTokens = withoutRange.split(/\s+/).filter(Boolean);

  const noise = new Set([
    ...ALL_BLOCK_VERBS, ...Object.keys(WEEKDAYS), ...Object.keys(MONTHS),
    "to", "until", "till", "for", "the", "my", "on", "at", "out", "off",
    "today", "tonight", "tomorrow", "am", "pm", "i", "have", "got", "a", "an",
    "all", "day", "whole",
  ]);

  // The label keeps the student's own capitalisation — "MUN" is an acronym and
  // rendering it "Mun" makes it look like a typo of someone's name.
  const rawLabel =
    text
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z0-9&'-]/g, ""))
      .filter((w) => w && !noise.has(w.toLowerCase()) && !/\d/.test(w))
      .join(" ")
      .trim() || "Blocked";
  // Capitalise a plain lowercase word ("family" -> "Family") but leave anything
  // the student capitalised themselves alone, so MUN stays MUN.
  const label = rawLabel === rawLabel.toLowerCase()
    ? rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1)
    : rawLabel;

  // A month that was named but could not be resolved is a typo, not a licence
  // to fall back to today. Silently blocking out the wrong day is worse than
  // saying no.
  if (dateTokens.some((t) => t in MONTHS) && explicitDate(dateTokens, todayKey) === null) {
    return { ok: false, reason: "That date doesn't exist — check the day and month." };
  }

  return {
    ok: true,
    intent: {
      kind: "block_time",
      dateKey: resolveDay(dateTokens, todayKey),
      startMin,
      endMin,
      label,
    },
    summary: "",
  };
}

export function describeIntent(intent: ChatIntent): string {
  switch (intent.kind) {
    case "block_time":
      return `Hold ${formatMinutes(intent.startMin)}–${formatMinutes(intent.endMin)} on ${intent.dateKey} for "${intent.label}", then re-plan around it.`;
    case "lesson":
      return intent.command.kind === "cancel"
        ? `Cancel ${intent.command.label} on ${intent.command.dateKey}.`
        : `Restore ${intent.command.label} on ${intent.command.dateKey}.`;
    case "finished_early":
      return "Mark what you are working on as done and pull the next thing forward.";
    case "write_off_today":
      return "Write today off. Nothing counts against you, and the plan reflows.";
    case "replan":
      return "Rebuild the schedule from your current tasks and commitments.";
  }
}

export function parseChatCommand(
  text: string,
  context: { entries: CommandEntry[]; todayKey: string },
): ChatResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "Say what you need." };
  const tokens = norm(trimmed).split(/\s+/).filter(Boolean);
  const first = tokens[0];

  // A block verb with a TIME RANGE means "I am unavailable then". The same
  // verb without one — "cancel Thursday teaching" — is a lesson, and falls
  // through to that grammar below.
  const hasRange = RANGE_RE.test(norm(trimmed));
  if (BLOCK_VERBS.includes(first) || (AMBIGUOUS_VERBS.includes(first) && hasRange)) {
    const r = parseBlock(trimmed, context.todayKey);
    return r.ok ? { ...r, summary: describeIntent(r.intent) } : r;
  }

  if (/\b(finished|done|completed)\b/.test(norm(trimmed)) && /\b(early|already)\b/.test(norm(trimmed))) {
    const intent: SimpleIntent = { kind: "finished_early" };
    return { ok: true, intent, summary: describeIntent(intent) };
  }

  if (/\b(write off|writeoff|sick|ill|scrap today)\b/.test(norm(trimmed))) {
    const intent: SimpleIntent = { kind: "write_off_today" };
    return { ok: true, intent, summary: describeIntent(intent) };
  }

  if (/^(re-?plan|replan|reschedule|redo the plan)/.test(norm(trimmed))) {
    const intent: SimpleIntent = { kind: "replan" };
    return { ok: true, intent, summary: describeIntent(intent) };
  }

  // Falls through to the lesson cancel/restore grammar.
  const lesson = parseTimetableCommand(trimmed, context);
  if (lesson.ok) {
    const intent: LessonIntent = { kind: "lesson", command: lesson.command };
    return { ok: true, intent, summary: describeIntent(intent) };
  }
  return { ok: false, reason: lesson.reason };
}
