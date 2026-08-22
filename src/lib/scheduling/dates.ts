/**
 * Calendar-date arithmetic on YYYY-MM-DD strings.
 *
 * Week boundaries, revision intervals and deadlines are calendar facts, not
 * instants. Doing them in epoch milliseconds is how you end up an hour out
 * twice a year — anchoring at noon UTC keeps every operation far from both a
 * midnight boundary and any DST transition.
 *
 * Shared by quotas and revision; both count days from a trigger date.
 */

const MS_PER_DAY = 86_400_000;

/** Days since the epoch for a YYYY-MM-DD key. Throws on malformed input. */
export function dayNumberOf(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Not a YYYY-MM-DD date key: ${key}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) / MS_PER_DAY;
}

export function keyFromDayNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDaysKey(key: string, days: number): string {
  return keyFromDayNumber(dayNumberOf(key) + days);
}

export function daysBetweenKeys(fromKey: string, toKey: string): number {
  return Math.round(dayNumberOf(toKey) - dayNumberOf(fromKey));
}

/**
 * The Monday on or before `key`.
 *
 * Quota weeks are Monday-based even though the calendar grid renders
 * Sunday-first: a student's working week runs Monday to Sunday, and putting
 * the boundary mid-weekend would split a Saturday revision session across two
 * quota periods.
 */
export function mondayOf(key: string): string {
  const n = dayNumberOf(key);
  // 1970-01-01 was a Thursday, so +3 aligns the modulo to Monday.
  const dow = (((n + 3) % 7) + 7) % 7;
  return keyFromDayNumber(n - dow);
}
