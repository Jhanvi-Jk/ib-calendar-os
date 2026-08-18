import type { EpochMinute, Minutes } from "@/lib/domain/types";

/**
 * Half-open interval arithmetic, [start, end).
 *
 * Half-open matters: a block ending at 10:00 and one starting at 10:00 do not
 * overlap. With closed intervals every back-to-back pair would register as a
 * conflict and the solver would refuse to fill a day.
 */
export interface Interval {
  start: EpochMinute;
  end: EpochMinute;
}

export const length = (i: Interval): Minutes => Math.max(0, i.end - i.start);

export const overlaps = (a: Interval, b: Interval): boolean =>
  a.start < b.end && b.start < a.end;

/** Sorts, then coalesces touching or overlapping intervals. */
export function normalize(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Interval[] = [];
  for (const current of sorted) {
    const last = out[out.length - 1];
    if (last && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      out.push({ ...current });
    }
  }
  return out;
}

/** `base` minus every interval in `cuts`. Both may be unsorted. */
export function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  const blocked = normalize(cuts);
  const out: Interval[] = [];

  for (const region of normalize(base)) {
    let cursor = region.start;
    for (const cut of blocked) {
      if (cut.end <= cursor) continue;
      if (cut.start >= region.end) break;
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start, region.end) });
      cursor = Math.max(cursor, cut.end);
      if (cursor >= region.end) break;
    }
    if (cursor < region.end) out.push({ start: cursor, end: region.end });
  }

  return out.filter((i) => i.end > i.start);
}

export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

export const totalMinutes = (intervals: Interval[]): Minutes =>
  intervals.reduce((sum, i) => sum + length(i), 0);
