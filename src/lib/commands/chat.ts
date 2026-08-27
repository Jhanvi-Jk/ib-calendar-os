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

const BLOCK_VERBS = ["block", "busy", "hold", "reserve", "booked"];

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

function resolveDay(tokens: string[], todayKey: string): string {
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
  const tokens = norm(text).split(/\s+/).filter(Boolean);

  // "7 to 9", "7-9", "7pm to 9pm", "19:00 - 21:00"
  const range =
    /(\d{1,2}(?::|\.)?\d{0,2})\s*(am|pm)?\s*(?:to|until|till|-|–|—)\s*(\d{1,2}(?::|\.)?\d{0,2})\s*(am|pm)?/.exec(
      norm(text),
    );
  if (!range) {
    return { ok: false, reason: 'Give me a time range, like "block 7 to 9 tonight for family".' };
  }

  const saysAm = /\bam\b/.test(norm(text));
  const startMin = parseClock(range[1], range[2] ?? null, !saysAm);
  let endMin = parseClock(range[3], range[4] ?? range[2] ?? null, !saysAm);
  if (startMin === null || endMin === null) {
    return { ok: false, reason: "I couldn't read those times." };
  }
  // "block 11 to 1" crosses noon; treat the end as later the same day.
  if (endMin <= startMin) endMin += 12 * 60;
  if (endMin <= startMin || endMin > 24 * 60) {
    return { ok: false, reason: "That range ends before it starts." };
  }

  const noise = new Set([
    ...BLOCK_VERBS, ...Object.keys(WEEKDAYS),
    "to", "until", "till", "for", "the", "my", "on", "at", "out", "off",
    "today", "tonight", "tomorrow", "am", "pm", "i", "have", "got", "a", "an",
  ]);
  const label =
    tokens
      .filter((t) => !noise.has(t) && !/^\d/.test(t))
      .join(" ")
      .trim() || "Blocked";

  return {
    ok: true,
    intent: {
      kind: "block_time",
      dateKey: resolveDay(tokens, todayKey),
      startMin,
      endMin,
      label: label.charAt(0).toUpperCase() + label.slice(1),
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

  if (BLOCK_VERBS.includes(first)) {
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
