import type { EpochMinute, FixedEvent, Minutes } from "@/lib/domain/types";
import { addLocalDays, localDateKey, localParts, startOfLocalDay } from "@/lib/time";

/**
 * Expands a weekly timetable pattern into concrete lessons.
 *
 * Called on read rather than materialised into `events`, so the pattern stays
 * the single source of truth. Moving a period updates one row, not a year of
 * copies that can silently drift apart.
 *
 * Lessons come out as Tier 1 events, which the solver treats as immutable —
 * the whole point being that revision never lands on top of a lesson.
 *
 * Pure — no clock, no I/O. The window is supplied by the caller.
 */

export type WeekParity = "every" | "A" | "B";

export interface TimetableEntry {
  id: string;
  subjectId: string | null;
  label: string;
  room: string | null;
  /** 0 = Sunday, matching energy_profile.dow. */
  dayOfWeek: number;
  startsMin: Minutes;
  endsMin: Minutes;
  parity: WeekParity;
  /** YYYY-MM-DD, inclusive. Null = unbounded. */
  activeFrom: string | null;
  activeTo: string | null;
}

/**
 * Which side of a two-week cycle a given day falls on.
 *
 * Counts whole local days from the anchor and halves it, rather than dividing
 * timestamps: across a DST boundary a "week" is not 7 x 24h, and using
 * milliseconds flips the parity of every week after the clock change.
 */
export function parityForDay(
  dayStart: EpochMinute,
  anchorMondayKey: string | null,
  timezone: string,
): WeekParity | null {
  if (!anchorMondayKey) return null;

  const dayKey = localDateKey(dayStart, timezone);
  const days = daysBetweenKeys(anchorMondayKey, dayKey);
  // Monday-anchored: shift so the week containing the anchor is week 0 even
  // for days before it, then take the parity of the week index.
  const weekIndex = Math.floor(days / 7);
  const normalised = ((weekIndex % 2) + 2) % 2;
  return normalised === 0 ? "A" : "B";
}

function daysBetweenKeys(fromKey: string, toKey: string): number {
  const parse = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12) / 86_400_000;
  };
  return Math.round(parse(toKey) - parse(fromKey));
}

function withinActiveRange(entry: TimetableEntry, dayKey: string): boolean {
  if (entry.activeFrom && dayKey < entry.activeFrom) return false;
  if (entry.activeTo && dayKey > entry.activeTo) return false;
  return true;
}

export function expandTimetable(
  entries: TimetableEntry[],
  options: {
    from: EpochMinute;
    to: EpochMinute;
    timezone: string;
    anchorMondayKey: string | null;
    /**
     * Occurrences the student has cancelled, keyed `entryId:YYYY-MM-DD`.
     *
     * Subtractive, so the weekly pattern stays the single source of truth: a
     * teaching session that is off on the 27th is one skipped date, not an
     * edit to the entry and not a deletion that would take every future week
     * with it. Removing the exception restores the lesson exactly.
     */
    cancelled?: ReadonlySet<string>;
  },
): FixedEvent[] {
  const { from, to, timezone, anchorMondayKey, cancelled } = options;
  if (entries.length === 0) return [];

  const out: FixedEvent[] = [];
  let dayStart = startOfLocalDay(from, timezone);
  let guard = 0;

  while (dayStart < to && guard++ < 400) {
    const parts = localParts(dayStart, timezone);
    const dayKey = localDateKey(dayStart, timezone);
    const parity = parityForDay(dayStart, anchorMondayKey, timezone);

    for (const entry of entries) {
      if (entry.dayOfWeek !== parts.dow) continue;
      if (!withinActiveRange(entry, dayKey)) continue;
      // With no anchor the student is on a single-week timetable, so a parity
      // label on an entry is treated as "every" rather than silently hiding it.
      if (parity !== null && entry.parity !== "every" && entry.parity !== parity) continue;
      if (cancelled?.has(`${entry.id}:${dayKey}`)) continue;

      const startsAt = dayStart + entry.startsMin;
      const endsAt = dayStart + entry.endsMin;
      if (endsAt <= from || startsAt >= to) continue;

      out.push({
        // Deterministic and unique per occurrence: the same entry on two dates
        // must not collide as a React key or in a diff.
        id: `tt:${entry.id}:${dayKey}`,
        title: entry.room ? `${entry.label} · ${entry.room}` : entry.label,
        startsAt,
        endsAt,
        tier: 1,
        kind: "class",
        isLocked: true,
        subjectId: entry.subjectId,
      });
    }

    dayStart = addLocalDays(dayStart, 1, timezone);
  }

  return out.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
}

/** Total timetabled minutes in a week — used to sanity-check a new timetable. */
export function weeklyContactMinutes(entries: TimetableEntry[]): Minutes {
  return entries.reduce(
    (sum, e) => sum + (e.endsMin - e.startsMin) * (e.parity === "every" ? 1 : 0.5),
    0,
  );
}
