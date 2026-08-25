import { describe, expect, it } from "vitest";
import { expandTimetable, parityForDay, weeklyContactMinutes, type TimetableEntry } from "./timetable";
import { localDateKey, startOfLocalDay, toEpochMinute } from "@/lib/time";

const TZ = "Europe/London";

const entry = (over: Partial<TimetableEntry> = {}): TimetableEntry => ({
  id: "e1",
  subjectId: null,
  label: "Physics HL",
  room: null,
  dayOfWeek: 1, // Monday
  startsMin: 9 * 60,
  endsMin: 10 * 60,
  parity: "every",
  activeFrom: null,
  activeTo: null,
  ...over,
} as TimetableEntry);

/** Epoch minute of local midnight on a given YYYY-MM-DD in TZ. */
const dayStart = (key: string) =>
  startOfLocalDay(toEpochMinute(new Date(`${key}T12:00:00Z`)), TZ);

describe("week parity", () => {
  const anchor = "2026-09-07"; // a Monday, Week A

  it("calls the anchor week A and the next week B", () => {
    expect(parityForDay(dayStart("2026-09-07"), anchor, TZ)).toBe("A");
    expect(parityForDay(dayStart("2026-09-11"), anchor, TZ)).toBe("A");
    expect(parityForDay(dayStart("2026-09-14"), anchor, TZ)).toBe("B");
    expect(parityForDay(dayStart("2026-09-21"), anchor, TZ)).toBe("A");
  });

  it("keeps alternating across a DST change", () => {
    // The UK clocks go back on 2026-10-25. Dividing timestamps by 7*24h would
    // drift by an hour here and eventually flip every subsequent week.
    expect(parityForDay(dayStart("2026-10-19"), anchor, TZ)).toBe("A");
    expect(parityForDay(dayStart("2026-10-26"), anchor, TZ)).toBe("B");
    expect(parityForDay(dayStart("2026-11-02"), anchor, TZ)).toBe("A");
  });

  it("handles weeks before the anchor without going wrong", () => {
    expect(parityForDay(dayStart("2026-08-31"), anchor, TZ)).toBe("B");
    expect(parityForDay(dayStart("2026-08-24"), anchor, TZ)).toBe("A");
  });

  it("returns null when there is no anchor", () => {
    expect(parityForDay(dayStart("2026-09-07"), null, TZ)).toBeNull();
  });
});

describe("expanding the timetable", () => {
  const window = (fromKey: string, days: number) => ({
    from: dayStart(fromKey),
    to: dayStart(fromKey) + days * 1440,
    timezone: TZ,
    anchorMondayKey: "2026-09-07" as string | null,
  });

  it("produces one lesson per matching weekday", () => {
    const out = expandTimetable([entry()], window("2026-09-07", 14));
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.tier === 1 && e.kind === "class")).toBe(true);
  });

  it("marks lessons immutable so revision cannot land on them", () => {
    const [lesson] = expandTimetable([entry()], window("2026-09-07", 7));
    expect(lesson.tier).toBe(1);
    expect(lesson.isLocked).toBe(true);
  });

  it("places the lesson at the right local time", () => {
    const [lesson] = expandTimetable([entry()], window("2026-09-07", 1));
    expect(lesson.startsAt).toBe(dayStart("2026-09-07") + 540);
    expect(lesson.endsAt).toBe(dayStart("2026-09-07") + 600);
  });

  it("only emits Week A entries in Week A", () => {
    const out = expandTimetable([entry({ parity: "A" })], window("2026-09-07", 14));
    expect(out).toHaveLength(1);
    expect(localDateKey(out[0].startsAt, TZ)).toBe("2026-09-07");
  });

  it("emits parity entries every week when there is no anchor", () => {
    // A student on a single-week timetable should never lose lessons just
    // because an entry carries a stale parity label.
    const out = expandTimetable(
      [entry({ parity: "B" })],
      { ...window("2026-09-07", 14), anchorMondayKey: null },
    );
    expect(out).toHaveLength(2);
  });

  it("respects the active date range", () => {
    const out = expandTimetable(
      [entry({ activeFrom: "2026-09-14" })],
      window("2026-09-07", 21),
    );
    expect(out.map((e) => localDateKey(e.startsAt, TZ))).toEqual([
      "2026-09-14",
      "2026-09-21",
    ]);
  });

  it("keeps a 09:00 lesson at 09:00 after the clocks change", () => {
    // Adding 7*1440 minutes repeatedly would slide the lesson to 08:00 for
    // the rest of the year once the UK leaves BST.
    const out = expandTimetable([entry()], window("2026-10-19", 21));
    const times = out.map((e) => {
      const d = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(e.startsAt * 60_000));
      return d;
    });
    expect(new Set(times)).toEqual(new Set(["09:00"]));
  });

  it("gives each occurrence a distinct id", () => {
    const out = expandTimetable([entry()], window("2026-09-07", 21));
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
  });

  it("clips lessons outside the requested window", () => {
    const out = expandTimetable([entry()], window("2026-09-08", 5));
    expect(out).toHaveLength(0);
  });

  it("returns nothing for an empty timetable", () => {
    expect(expandTimetable([], window("2026-09-07", 14))).toEqual([]);
  });

  it("sorts chronologically", () => {
    const out = expandTimetable(
      [entry({ id: "late", startsMin: 14 * 60, endsMin: 15 * 60 }), entry({ id: "early" })],
      window("2026-09-07", 7),
    );
    expect(out.map((e) => e.id.split(":")[1])).toEqual(["early", "late"]);
  });
});

describe("weekly contact time", () => {
  it("counts fortnightly lessons as half", () => {
    const mins = weeklyContactMinutes([
      entry({ id: "a", parity: "every" }), // 60
      entry({ id: "b", parity: "A" }), // 30
    ]);
    expect(mins).toBe(90);
  });
});

describe("cancelled occurrences", () => {
  const teaching: TimetableEntry = {
    id: "teach",
    subjectId: null,
    label: "Teaching",
    room: null,
    dayOfWeek: 4,
    startsMin: 600,
    endsMin: 780,
    parity: "every",
    activeFrom: null,
    activeTo: null,
  };

  const expand = (cancelled?: Set<string>) =>
    expandTimetable([teaching], {
      from: toEpochMinute(new Date("2026-08-24T00:00:00Z")),
      to: toEpochMinute(new Date("2026-09-14T00:00:00Z")),
      timezone: "UTC",
      anchorMondayKey: null,
      cancelled,
    });

  it("drops only the cancelled date", () => {
    const before = expand();
    const after = expand(new Set(["teach:2026-08-27"]));
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(2);
    expect(after.some((e) => e.id.endsWith("2026-08-27"))).toBe(false);
  });

  it("leaves every other week standing", () => {
    // The failure mode this replaces was deleting the entry to skip one week,
    // which silently removed the rest of the term.
    const after = expand(new Set(["teach:2026-08-27"]));
    expect(after.map((e) => e.id)).toEqual([
      "tt:teach:2026-09-03",
      "tt:teach:2026-09-10",
    ]);
  });

  it("ignores an exception for a different entry", () => {
    expect(expand(new Set(["somethingelse:2026-08-27"]))).toHaveLength(3);
  });

  it("restores the lesson when the exception is removed", () => {
    expect(expand(new Set())).toHaveLength(3);
  });
});
