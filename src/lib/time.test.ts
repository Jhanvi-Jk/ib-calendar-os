import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  eachLocalDay,
  localDateKey,
  minutesIntoLocalDay,
  startOfLocalDay,
  toEpochMinute,
} from "./time";

/**
 * Regression guard for the DST bug that sat in startOfLocalDay from the very
 * first migration.
 *
 * It computed `epochMin - minutesIntoLocalDay(epochMin)`, which assumes the
 * UTC offset is constant between midnight and the given instant. On a
 * clocks-back day that returned 01:00 rather than 00:00, and since
 * addLocalDays and eachLocalDay are built on it, every subsequent day
 * inherited the drift — moving timetabled lessons and the solver's day-budget
 * boundaries an hour out for the remainder of the year.
 */

const at = (iso: string) => toEpochMinute(new Date(iso));
const clock = (epochMin: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochMin * 60_000));

describe("startOfLocalDay", () => {
  it("returns real local midnight on an ordinary day", () => {
    const s = startOfLocalDay(at("2026-06-15T14:00:00Z"), "Europe/London");
    expect(clock(s, "Europe/London")).toBe("00:00");
    expect(localDateKey(s, "Europe/London")).toBe("2026-06-15");
  });

  it("returns 00:00 on a clocks-BACK day, not 01:00", () => {
    // 2026-10-25, UK clocks go back at 02:00 BST.
    const s = startOfLocalDay(at("2026-10-25T12:00:00Z"), "Europe/London");
    expect(clock(s, "Europe/London")).toBe("00:00");
    expect(localDateKey(s, "Europe/London")).toBe("2026-10-25");
  });

  it("returns 00:00 on a clocks-FORWARD day", () => {
    // 2026-03-29, UK clocks go forward at 01:00 GMT.
    const s = startOfLocalDay(at("2026-03-29T12:00:00Z"), "Europe/London");
    expect(clock(s, "Europe/London")).toBe("00:00");
    expect(localDateKey(s, "Europe/London")).toBe("2026-03-29");
  });

  it("works in a southern-hemisphere zone, where the transitions invert", () => {
    const s = startOfLocalDay(at("2026-04-05T02:00:00Z"), "Australia/Sydney");
    expect(clock(s, "Australia/Sydney")).toBe("00:00");
  });

  it("works in a zone with a half-hour offset", () => {
    const s = startOfLocalDay(at("2026-06-15T14:00:00Z"), "Asia/Kolkata");
    expect(clock(s, "Asia/Kolkata")).toBe("00:00");
    expect(localDateKey(s, "Asia/Kolkata")).toBe("2026-06-15");
  });

  it("is idempotent", () => {
    const tz = "Europe/London";
    const once = startOfLocalDay(at("2026-10-25T12:00:00Z"), tz);
    expect(startOfLocalDay(once, tz)).toBe(once);
  });
});

describe("addLocalDays", () => {
  it("keeps the wall-clock time when stepping one day at a time through a DST change", () => {
    const tz = "Europe/London";
    // 09:00 on the Friday before the change.
    let cursor = startOfLocalDay(at("2026-10-23T12:00:00Z"), tz) + 9 * 60;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(clock(cursor, tz));
      cursor = addLocalDays(cursor, 1, tz);
    }
    expect(new Set(seen)).toEqual(new Set(["09:00"]));
  });

  it("lands on consecutive calendar dates across the change", () => {
    const tz = "Europe/London";
    let cursor = startOfLocalDay(at("2026-10-23T12:00:00Z"), tz);
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      keys.push(localDateKey(cursor, tz));
      cursor = addLocalDays(cursor, 1, tz);
    }
    expect(keys).toEqual([
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);
  });

  it("steps backwards correctly too", () => {
    const tz = "Europe/London";
    const start = startOfLocalDay(at("2026-10-27T12:00:00Z"), tz);
    expect(localDateKey(addLocalDays(start, -3, tz), tz)).toBe("2026-10-24");
  });
});

describe("eachLocalDay", () => {
  it("yields one entry per calendar day across a DST boundary", () => {
    const tz = "Europe/London";
    const from = startOfLocalDay(at("2026-10-23T12:00:00Z"), tz);
    const to = startOfLocalDay(at("2026-10-27T12:00:00Z"), tz);
    const days = eachLocalDay(from, to, tz);

    expect(days.map((d) => localDateKey(d, tz))).toEqual([
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
    ]);
    // No duplicates and no skipped days — the solver builds one budget per day.
    expect(new Set(days.map((d) => localDateKey(d, tz))).size).toBe(days.length);
  });
});

describe("minutesIntoLocalDay", () => {
  it("measures from true local midnight on a transition day", () => {
    const tz = "Europe/London";
    // 09:00 local on the clocks-back day is 10 real hours after local midnight,
    // because an hour is repeated — the wall clock still reads 09:00.
    const nineAm = startOfLocalDay(at("2026-10-25T12:00:00Z"), tz) + 10 * 60;
    expect(minutesIntoLocalDay(nineAm, tz)).toBe(9 * 60);
  });
});
