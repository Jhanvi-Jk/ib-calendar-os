import { describe, expect, it } from "vitest";
import { subjectBalance, type SubjectTime } from "./balance";

const s = (
  name: string,
  level: SubjectTime["level"],
  minutes: number,
): SubjectTime => ({ subjectId: name, name, level, minutes });

describe("subject balance", () => {
  it("says nothing when there is barely any tracked time", () => {
    const r = subjectBalance([s("Physics", "HL", 30), s("Economics", "HL", 20)]);
    expect(r.hasEnoughData).toBe(false);
    expect(r.headline).toMatch(/where your time is really going/i);
  });

  it("treats equal time across HL and SL as imbalanced, not balanced", () => {
    // The core judgement: HL carries more of the diploma, so an even split
    // means the HL subject is actually under-served.
    const r = subjectBalance([s("Physics", "HL", 300), s("French", "SL", 300)]);

    const hl = r.subjects.find((x) => x.name === "Physics")!;
    const sl = r.subjects.find((x) => x.name === "French")!;

    expect(hl.ratio).toBeLessThan(1);
    expect(sl.ratio).toBeGreaterThan(1);
  });

  it("counts weighted-proportional time as balanced", () => {
    // 1.6 : 1 matches LEVEL_WEIGHT exactly.
    const r = subjectBalance([s("Physics", "HL", 480), s("French", "SL", 300)]);
    expect(r.subjects.every((x) => x.status === "balanced")).toBe(true);
    expect(r.headline).toMatch(/spread sensibly/i);
  });

  it("flags an untouched subject and names it", () => {
    const r = subjectBalance([
      s("Physics", "HL", 600),
      s("Economics", "HL", 400),
      s("Economics IA", "SL", 0),
    ]);
    const zero = r.subjects.find((x) => x.name === "Economics IA")!;

    expect(zero.status).toBe("neglected");
    expect(r.headline).toContain("Economics IA");
    expect(r.headline).toMatch(/no tracked time/i);
  });

  it("orders by time spent, so the biggest sink is first", () => {
    const r = subjectBalance([
      s("TOK", "CORE", 100),
      s("Physics", "HL", 500),
      s("French", "SL", 200),
    ]);
    expect(r.subjects.map((x) => x.name)).toEqual(["Physics", "French", "TOK"]);
  });

  it("never divides by zero when nothing is tracked", () => {
    const r = subjectBalance([s("Physics", "HL", 0), s("French", "SL", 0)]);
    expect(r.totalMin).toBe(0);
    expect(r.hasEnoughData).toBe(false);
    expect(r.subjects.every((x) => Number.isFinite(x.ratio))).toBe(true);
  });

  it("shares sum to 1 when there is time to divide", () => {
    const r = subjectBalance([
      s("Physics", "HL", 300),
      s("French", "SL", 100),
      s("TOK", "CORE", 200),
    ]);
    const total = r.subjects.reduce((sum, x) => sum + x.share, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("does not label worked subjects 'heavy' while most subjects sit at zero", () => {
    // Three subjects carry all the time and six are untouched. Against a
    // per-subject target the worked ones look excessive, but the finding is
    // the six zeros — calling the actual work "Heavy" reads as a reprimand.
    const r = subjectBalance([
      s("Physics", "HL", 180),
      s("Economics", "HL", 90),
      s("Maths", "HL", 45),
      s("English", "SL", 0),
      s("CompSci", "SL", 0),
      s("French", "CORE", 0),
      s("EE", "CORE", 0),
      s("TOK", "CORE", 0),
      s("CAS", "CORE", 0),
    ]);

    expect(r.subjects.some((x) => x.status === "heavy")).toBe(false);
    expect(r.subjects.filter((x) => x.status === "neglected").length).toBe(6);
    // The ratio is still reported honestly even though the label is softened.
    expect(r.subjects.find((x) => x.name === "Physics")!.ratio).toBeGreaterThan(2);
  });

  it("still calls out genuine over-investment once subjects are mostly covered", () => {
    const r = subjectBalance([
      s("Physics", "HL", 600),
      s("Economics", "HL", 60),
      s("Maths", "HL", 60),
      s("English", "SL", 60),
    ]);
    expect(r.subjects.find((x) => x.name === "Physics")!.status).toBe("heavy");
  });
});
