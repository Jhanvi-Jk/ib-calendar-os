import type { EpochMinute, Minutes } from "@/lib/domain/types";

/**
 * Time helpers shared by the UI and the scheduling engine.
 *
 * The solver works in epoch minutes (UTC integers). Humans work in local wall
 * clock. Everything that crosses between the two goes through here, so the
 * timezone logic exists in exactly one place.
 *
 * Uses Intl rather than a date library so the engine keeps zero runtime
 * dependencies — Intl is deterministic given a fixed tz database.
 */

export const MIN_PER_HOUR = 60;
export const MIN_PER_DAY = 1440;

export const toEpochMinute = (d: Date): EpochMinute =>
  Math.floor(d.getTime() / 60_000);

export const fromEpochMinute = (m: EpochMinute): Date => new Date(m * 60_000);

/** "07:30" -> 450 */
export function parseClock(hhmm: string): Minutes {
  const [h, m] = hhmm.split(":").map(Number);
  return h * MIN_PER_HOUR + (m || 0);
}

/** 450 -> "07:30" */
export function formatClock(min: Minutes): string {
  const m = ((min % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday, matching energy_profile.dow. */
  dow: number;
}

export function localParts(epochMin: EpochMinute, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(fromEpochMinute(epochMin));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    dow: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** Minutes elapsed since local midnight. Handles DST correctly. */
export function minutesIntoLocalDay(epochMin: EpochMinute, timeZone: string): Minutes {
  const p = localParts(epochMin, timeZone);
  return p.hour * MIN_PER_HOUR + p.minute;
}

/**
 * UTC offset in minutes (local wall clock minus UTC) at a given instant.
 * Positive east of Greenwich.
 */
function offsetMinutes(epochMin: EpochMinute, timeZone: string): Minutes {
  const p = localParts(epochMin, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60_000;
  return asIfUtc - epochMin;
}

/**
 * Epoch minute of local midnight for the day containing `epochMin`.
 *
 * This used to be `epochMin - minutesIntoLocalDay(epochMin)`, which is wrong
 * on any day the UTC offset changes: subtracting wall-clock minutes from an
 * instant assumes the offset is constant across the interval. On a
 * clocks-back day it returned 01:00 instead of 00:00, and because
 * addLocalDays is built on it, every following day inherited the drift —
 * which pushed every timetabled lesson and every solver day-budget boundary
 * an hour out for the rest of the year.
 *
 * Instead: take the local calendar date, express that date's midnight as if
 * it were UTC, then subtract the offset that actually applies *at that
 * midnight*. The offset is re-read at the candidate instant because the
 * offset at midday and the offset at midnight can differ on a transition day.
 */
export function startOfLocalDay(epochMin: EpochMinute, timeZone: string): EpochMinute {
  const p = localParts(epochMin, timeZone);
  const midnightAsIfUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0) / 60_000;

  // First guess with the offset at the supplied instant, then correct using
  // the offset at the guess itself. Two passes settle every real-world zone.
  let candidate = midnightAsIfUtc - offsetMinutes(epochMin, timeZone);
  candidate = midnightAsIfUtc - offsetMinutes(candidate, timeZone);

  // Zones that spring forward exactly at midnight have no 00:00 on that date
  // (Chile, Cuba, Lord Howe). Walk forward to the first minute that exists.
  let guard = 0;
  while (localDateKey(candidate, timeZone) !== dateKeyFromParts(p) && guard++ < 120) {
    candidate += 1;
  }

  return candidate;
}

function dateKeyFromParts(p: LocalParts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "2026-05-04" in the given zone — the key used by daily aggregates. */
export function localDateKey(epochMin: EpochMinute, timeZone: string): string {
  const p = localParts(epochMin, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Adds whole local days. Not the same as adding 1440 minutes: across a DST
 * boundary a local day is 1380 or 1500 minutes long, and getting this wrong
 * shifts every block on the far side of the transition.
 */
/**
 * The instant at which the local wall clock reads `wallMin` on the local date
 * containing `dayStart`.
 *
 * Not `dayStart + wallMin`: that adds *real* minutes, so on a transition day
 * midnight + 540 is 08:00 or 10:00 rather than 09:00.
 */
function atLocalMinutes(
  dayStart: EpochMinute,
  wallMin: Minutes,
  timeZone: string,
): EpochMinute {
  const p = localParts(dayStart, timeZone);
  const asIfUtc =
    Date.UTC(p.year, p.month - 1, p.day, Math.floor(wallMin / 60), wallMin % 60) /
    60_000;
  let candidate = asIfUtc - offsetMinutes(dayStart, timeZone);
  candidate = asIfUtc - offsetMinutes(candidate, timeZone);
  return candidate;
}

/**
 * Adds whole local days, preserving the WALL-CLOCK time of day.
 *
 * A 09:00 lesson is at 09:00 tomorrow even if the clocks change overnight,
 * which is what a calendar means by "the next day". The previous version
 * carried the *real* elapsed minutes since local midnight instead, so a
 * clocks-back day (where 09:00 is 10 real hours after midnight) shifted every
 * following day by an hour.
 */
export function addLocalDays(
  epochMin: EpochMinute,
  days: number,
  timeZone: string,
): EpochMinute {
  const wallMin = minutesIntoLocalDay(epochMin, timeZone);
  const dayStart = startOfLocalDay(epochMin, timeZone);
  // Overshoot to midday before re-anchoring so an offset change cannot land
  // the cursor on the wrong calendar date.
  const targetDayStart = startOfLocalDay(
    dayStart + days * MIN_PER_DAY + 720,
    timeZone,
  );
  return atLocalMinutes(targetDayStart, wallMin, timeZone);
}

export function formatRange(
  startMin: EpochMinute,
  endMin: EpochMinute,
  timeZone: string,
): string {
  const a = localParts(startMin, timeZone);
  const b = localParts(endMin, timeZone);
  const clock = (p: LocalParts) =>
    `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${clock(a)}–${clock(b)}`;
}

export function formatDuration(min: Minutes): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Inclusive list of local-midnight epoch minutes spanning [from, to]. */
export function eachLocalDay(
  from: EpochMinute,
  to: EpochMinute,
  timeZone: string,
): EpochMinute[] {
  const days: EpochMinute[] = [];
  let cursor = startOfLocalDay(from, timeZone);
  let guard = 0;
  while (cursor <= to && guard++ < 400) {
    days.push(cursor);
    cursor = addLocalDays(cursor, 1, timeZone);
  }
  return days;
}
