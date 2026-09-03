import { describe, expect, it } from "vitest";
import { parseChatCommand } from "./chat";
import { type CommandEntry as Entry } from "./timetable-commands";

// Thursday 27 August 2026.
const TODAY = "2026-08-27";
const entries: Entry[] = [
  { id: "teach", label: "Teaching", dayOfWeek: 4 },
  { id: "maths", label: "C3 Maths AA", dayOfWeek: 1 },
];
const parse = (t: string, todayKey = TODAY) => parseChatCommand(t, { entries, todayKey });

describe("blocking time out", () => {
  it("understands 'block 7 to 9 tonight for family'", () => {
    const r = parse("block 7 to 9 tonight for family");
    expect(r.ok).toBe(true);
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent).toMatchObject({
        dateKey: TODAY, startMin: 19 * 60, endMin: 21 * 60, label: "Family",
      });
    }
  });

  it("reads a bare evening hour as pm, because nobody blocks 7am for dinner", () => {
    const r = parse("block 8 to 10 for dinner");
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent.startMin).toBe(20 * 60);
    }
  });

  it("respects an explicit am", () => {
    const r = parse("block 8 am to 10 am for the dentist");
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent.startMin).toBe(8 * 60);
      expect(r.intent.endMin).toBe(10 * 60);
    }
  });

  it("takes 24-hour times literally", () => {
    const r = parse("block 19:30 to 21:15 tonight gym");
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent.startMin).toBe(19 * 60 + 30);
      expect(r.intent.endMin).toBe(21 * 60 + 15);
    }
  });

  it("handles a dash instead of 'to'", () => {
    const r = parse("block 6-8 tomorrow swimming");
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent.dateKey).toBe("2026-08-28");
      expect(r.intent.endMin).toBe(20 * 60);
    }
  });

  it("resolves a named weekday forwards", () => {
    const r = parse("block 4 to 6 saturday for the wedding");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.dateKey).toBe("2026-08-29");
  });

  it("defaults to today when no day is named", () => {
    const r = parse("block 7 to 9 for family");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.dateKey).toBe(TODAY);
  });

  it("crossing noon does not produce a negative range", () => {
    const r = parse("block 11 to 1 lunch with dad");
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent.endMin).toBeGreaterThan(r.intent.startMin);
    }
  });

  it("asks for a time range rather than guessing one", () => {
    const r = parse("block some time for family");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/time range/i);
  });

  it("falls back to a usable label when none is given", () => {
    const r = parse("block 7 to 9");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.label).toBe("Blocked");
  });
});

describe("the other intents", () => {
  it("recognises finishing early", () => {
    const r = parse("finished physics early");
    expect(r.ok && r.intent.kind).toBe("finished_early");
  });

  it("recognises writing the day off", () => {
    const r = parse("i'm sick today");
    expect(r.ok && r.intent.kind).toBe("write_off_today");
  });

  it("recognises a plain re-plan", () => {
    expect(parse("replan").ok && parse("replan")).toBeTruthy();
  });

  it("still handles lesson cancellations", () => {
    const r = parse("cancel thursday teaching");
    expect(r.ok && r.intent.kind).toBe("lesson");
  });
});

describe("always explains itself before acting", () => {
  it("describes a block in words, with real times and a date", () => {
    const r = parse("block 7 to 9 tonight for family");
    expect(r.ok && r.summary).toMatch(/19:00–21:00/);
    expect(r.ok && r.summary).toMatch(/2026-08-27/);
    expect(r.ok && r.summary).toMatch(/Family/);
  });

  it("refuses rather than guessing at nonsense", () => {
    expect(parse("asdfgh").ok).toBe(false);
  });
});

describe("the sentence that failed", () => {
  it('understands "Cancel 4th September 5 AM to 10 PM For MUN"', () => {
    // "cancel" used to mean lesson-cancellation only, so this fell through to
    // the lesson matcher and answered "Nothing in your timetable matches that
    // name" — for a day the student was telling it they would be away.
    const r = parse("Cancel 4th September 5 AM to 10 PM For MUN");
    expect(r.ok).toBe(true);
    if (r.ok && r.intent.kind === "block_time") {
      expect(r.intent).toMatchObject({
        dateKey: "2026-09-04",
        startMin: 5 * 60,
        endMin: 22 * 60,
        label: "MUN",
      });
    }
  });

  it("keeps an acronym's capitalisation", () => {
    const r = parse("block 9 to 5 on 4th September for MUN");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.label).toBe("MUN");
  });

  it("does not read the times as a day of the month", () => {
    // "5 to 10" must not donate a 5 or a 10 to the date parser.
    const r = parse("cancel 4 September 5 am to 10 pm for MUN");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.dateKey).toBe("2026-09-04");
  });

  it("still treats a verb WITHOUT a time range as a lesson", () => {
    const r = parse("cancel thursday teaching");
    expect(r.ok && r.intent.kind).toBe("lesson");
  });
});

describe("explicit dates", () => {
  it("accepts several spellings of the month", () => {
    for (const t of [
      "block 9 to 5 on 4th September for MUN",
      "block 9 to 5 on 4 Sept for MUN",
      "block 9 to 5 on September 4 for MUN",
      "block 9 to 5 on 4 sep for MUN",
    ]) {
      const r = parse(t);
      expect(r.ok, t).toBe(true);
      if (r.ok && r.intent.kind === "block_time") expect(r.intent.dateKey, t).toBe("2026-09-04");
    }
  });

  it("rolls to next year when the date has gone", () => {
    // Asked in September for a date in January.
    const r = parse("block 9 to 5 on 4 January for MUN");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.dateKey).toBe("2027-01-04");
  });

  it("refuses a date that does not exist", () => {
    expect(parse("block 9 to 5 on 31 February for MUN").ok).toBe(false);
  });

  it("still handles a plain weekday", () => {
    // Today is Thursday 27 August, so "friday" is tomorrow.
    const r = parse("block 7 to 9 friday for family");
    if (r.ok && r.intent.kind === "block_time") expect(r.intent.dateKey).toBe("2026-08-28");
  });
});
