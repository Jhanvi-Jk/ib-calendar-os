import { describe, expect, it } from "vitest";
import { parseTimetableCommand, type CommandEntry } from "./timetable-commands";

// Monday 24 August 2026. The 27th of that month is a Thursday.
const TODAY = "2026-08-24";

const entries: CommandEntry[] = [
  { id: "teach", label: "Teaching", dayOfWeek: 4 },
  { id: "maths", label: "C3 Maths AA", dayOfWeek: 1 },
  { id: "physics", label: "C5 Physics", dayOfWeek: 2 },
  { id: "sports", label: "Sports", dayOfWeek: 1 },
];

const parse = (text: string, todayKey = TODAY) =>
  parseTimetableCommand(text, { entries, todayKey });

describe("the sentence the student actually types", () => {
  it("understands 'Cancel Thursday 27th teaching session'", () => {
    const r = parse("Cancel Thursday 27th teaching session");
    expect(r).toEqual({
      ok: true,
      command: { kind: "cancel", entryId: "teach", label: "Teaching", dateKey: "2026-08-27" },
    });
  });

  it("does not care about case, order or punctuation", () => {
    for (const text of [
      "cancel teaching thursday 27th",
      "CANCEL THURSDAY 27 TEACHING",
      "cancel the teaching session on Thursday the 27th",
      "skip teaching, thursday 27th",
    ]) {
      const r = parse(text);
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(r.command.dateKey, text).toBe("2026-08-27");
    }
  });

  it("restores an occurrence it cancelled", () => {
    const r = parse("restore Thursday 27th teaching");
    expect(r.ok && r.command.kind).toBe("restore");
  });
});

describe("dates", () => {
  it("takes the weekday alone to mean the next one", () => {
    const r = parse("cancel teaching thursday");
    expect(r.ok && r.command.dateKey).toBe("2026-08-27");
  });

  it("falls back to the recent past when no future date matches", () => {
    // Asked on Friday the 28th. There is no Thursday-the-27th anywhere in the
    // next six months, so "thursday 27th" can only mean yesterday's session —
    // which is a legitimate thing to record as cancelled after the fact.
    const r = parse("cancel teaching thursday 27th", "2026-08-28");
    expect(r.ok && r.command.dateKey).toBe("2026-08-27");
  });

  it("rolls forward to the next month when this month's has gone", () => {
    // Maths runs Mondays. Monday 31 August 2026 is still ahead on the 24th.
    const r = parse("cancel maths monday 31st", "2026-08-24");
    expect(r.ok && r.command.dateKey).toBe("2026-08-31");
  });

  it("looks forward, not back, when only a weekday is given", () => {
    // Asked on Friday the 28th, "thursday" means the one coming, not
    // yesterday's — you cancel things before they happen.
    const r = parse("cancel teaching thursday", "2026-08-28");
    expect(r.ok && r.command.dateKey).toBe("2026-09-03");
  });

  it("refuses a date the thing does not run on", () => {
    // The 25th is a Tuesday; teaching is Thursday.
    const r = parse("cancel teaching 25th");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not run/i);
  });

  it("asks for a day when none is given", () => {
    const r = parse("cancel teaching");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/which day/i);
  });
});

describe("refusing to guess", () => {
  it("will not act without a verb it knows", () => {
    const r = parse("thursday 27th teaching");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cancel.*restore/i);
  });

  it("says so when nothing in the timetable matches", () => {
    const r = parse("cancel Thursday 27th orchestra");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/nothing in your timetable/i);
  });

  it("refuses an ambiguous name rather than picking one", () => {
    // Cancelling the wrong lesson silently is worse than asking again.
    const ambiguous: CommandEntry[] = [
      { id: "a", label: "Economics lecture", dayOfWeek: 4 },
      { id: "b", label: "Economics seminar", dayOfWeek: 4 },
    ];
    const r = parseTimetableCommand("cancel economics thursday 27th", {
      entries: ambiguous,
      todayKey: TODAY,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/could be/i);
  });

  it("does not match a lesson on the strength of a noise word alone", () => {
    // "session" appears in the sentence and must not select anything.
    const r = parseTimetableCommand("cancel thursday 27th session", {
      entries: [{ id: "x", label: "Session", dayOfWeek: 4 }],
      todayKey: TODAY,
    });
    expect(r.ok).toBe(false);
  });

  it("ignores a number that could not be a day of the month", () => {
    const r = parse("cancel teaching thursday 99");
    expect(r.ok && r.command.dateKey).toBe("2026-08-27");
  });
});
