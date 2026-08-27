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
