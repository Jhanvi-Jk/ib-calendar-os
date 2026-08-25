import { describe, expect, it } from "vitest";
import {
  addDaysKey,
  proRatedTarget,
  mondayOf,
  quotaAttainment,
  quotaTasksNeeded,
  quotaWeeksBetween,
  type StudyQuota,
} from "./quotas";

const quota = (over: Partial<StudyQuota> = {}): StudyQuota => ({
  id: "sat-math",
  label: "SAT Maths",
  subjectId: null,
  targetMinWeek: 180,
  minSessionMin: 30,
  maxSessionMin: 60,
  cognitiveLoad: 4,
  priorityPin: 0,
  isActive: true,
  activeFrom: null,
  activeTo: null,
  ...over,
});

describe("week boundaries", () => {
  it("finds the Monday on or before a date", () => {
    expect(mondayOf("2026-08-20")).toBe("2026-08-17"); // Thursday -> Monday
    expect(mondayOf("2026-08-17")).toBe("2026-08-17"); // already Monday
    expect(mondayOf("2026-08-23")).toBe("2026-08-17"); // Sunday belongs to that week
  });

  it("keeps the weekend with the week it follows", () => {
    // A Saturday revision session must not fall into the next quota period.
    expect(mondayOf("2026-08-22")).toBe("2026-08-17");
  });

  it("adds days across a month boundary", () => {
    expect(addDaysKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("lists every week Monday touching the window", () => {
    expect(quotaWeeksBetween("2026-08-20", "2026-09-06")).toEqual([
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
    ]);
  });
});

describe("generating weekly quota tasks", () => {
  const window = { fromKey: "2026-08-17", toKey: "2026-08-30", existing: new Set<string>() };

  it("creates one task per week per quota", () => {
    const out = quotaTasksNeeded([quota()], window);
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.quotaWeek)).toEqual(["2026-08-17", "2026-08-24"]);
  });

  it("carries the quota's target and chunking onto the task", () => {
    const [t] = quotaTasksNeeded([quota()], window);
    expect(t.estimateMin).toBe(180);
    expect(t.minChunkMin).toBe(30);
    expect(t.maxChunkMin).toBe(60);
    expect(t.cognitiveLoad).toBe(4);
  });

  it("makes the task due at the end of its week", () => {
    const [t] = quotaTasksNeeded([quota()], window);
    expect(t.deadlineKey).toBe("2026-08-23"); // the Sunday
  });

  it("is idempotent — never regenerates a week that already exists", () => {
    // Without this, every re-plan would duplicate the week's SAT block and
    // reset progress on a week already under way.
    const existing = new Set(["sat-math:2026-08-17"]);
    const out = quotaTasksNeeded([quota()], { ...window, existing });
    expect(out.map((t) => t.quotaWeek)).toEqual(["2026-08-24"]);
  });

  it("skips inactive quotas", () => {
    expect(quotaTasksNeeded([quota({ isActive: false })], window)).toHaveLength(0);
  });

  it("applies a quota to the week it starts in, even mid-week", () => {
    // Starting on Wednesday should still produce that week's task rather than
    // silently losing the first week.
    const out = quotaTasksNeeded([quota({ activeFrom: "2026-08-19" })], window);
    expect(out.map((t) => t.quotaWeek)).toEqual(["2026-08-17", "2026-08-24"]);
  });

  it("stops after the quota ends", () => {
    const out = quotaTasksNeeded([quota({ activeTo: "2026-08-21" })], window);
    expect(out.map((t) => t.quotaWeek)).toEqual(["2026-08-17"]);
  });

  it("handles several quotas independently", () => {
    const out = quotaTasksNeeded(
      [quota(), quota({ id: "topik", label: "TOPIK", targetMinWeek: 135 })],
      window,
    );
    expect(out).toHaveLength(4);
    expect(new Set(out.map((t) => t.quotaId))).toEqual(new Set(["sat-math", "topik"]));
  });
});

describe("attainment", () => {
  const row = (over: Partial<Parameters<typeof quotaAttainment>[0][0]> = {}) => ({
    quotaId: "sat-math",
    label: "SAT Maths",
    weekMonday: "2026-08-17",
    targetMin: 180,
    doneMin: 180,
    ...over,
  });

  it("says nothing without quotas", () => {
    const r = quotaAttainment([]);
    expect(r.hasData).toBe(false);
    expect(r.headline).toMatch(/never finish/i);
  });

  it("counts 90% as hitting the target", () => {
    // A quota is a rate, not an exam — 2h50 of a 3h target is a good week.
    expect(quotaAttainment([row({ doneMin: 165 })]).weeks[0].status).toBe("hit");
  });

  it("flags a clear miss", () => {
    expect(quotaAttainment([row({ doneMin: 40 })]).weeks[0].status).toBe("missed");
  });

  it("caps attainment at 1 for an over-delivered week", () => {
    expect(quotaAttainment([row({ doneMin: 600 })]).weeks[0].attainment).toBe(1);
  });

  it("calls out a quota missed repeatedly rather than a one-off", () => {
    const r = quotaAttainment([
      row({ weekMonday: "2026-08-17", doneMin: 0 }),
      row({ weekMonday: "2026-08-24", doneMin: 30 }),
    ]);
    expect(r.headline).toMatch(/2 weeks running/i);
    expect(r.headline).toMatch(/too high|protecting earlier/i);
  });

  it("does not divide by zero on a zero target", () => {
    const r = quotaAttainment([row({ targetMin: 0, doneMin: 0 })]);
    expect(Number.isFinite(r.weeks[0].attainment)).toBe(true);
  });
});

describe("the week you are still in", () => {
  const row = (weekMonday: string, doneMin: number) => ({
    quotaId: "q1",
    label: "Physics HL study",
    weekMonday,
    targetMin: 240,
    doneMin,
  });

  it("does not call the current week missed", () => {
    // Monday morning is not a failure. Scoring a live week against a whole
    // week's target told a student who had just set a target that they had
    // already missed it.
    const r = quotaAttainment([row("2026-08-24", 0)], {
      currentWeekMonday: "2026-08-24",
    });
    expect(r.weeks[0].status).toBe("in_progress");
  });

  it("still lets the current week be hit early", () => {
    const r = quotaAttainment([row("2026-08-24", 240)], {
      currentWeekMonday: "2026-08-24",
    });
    expect(r.weeks[0].status).toBe("hit");
  });

  it("keeps the current week out of the missed-weeks headline", () => {
    const r = quotaAttainment(
      [row("2026-08-24", 0), row("2026-08-17", 0)],
      { currentWeekMonday: "2026-08-24" },
    );
    expect(r.headline).not.toMatch(/2 weeks running/);
  });

  it("still judges a week that has finished", () => {
    const r = quotaAttainment([row("2026-08-17", 0)], {
      currentWeekMonday: "2026-08-24",
    });
    expect(r.weeks[0].status).toBe("missed");
  });
});

describe("weeks the horizon cannot honour", () => {
  const quota = (over = {}) => ({
    id: "q", label: "Maths", subjectId: null, targetMinWeek: 350,
    minSessionMin: 30, maxSessionMin: 60, cognitiveLoad: 3 as const,
    priorityPin: 0 as const, isActive: true, activeFrom: null, activeTo: null,
    ...over,
  });

  it("does not generate a week that barely touches the horizon", () => {
    // Horizon ends Tue 15 Sept; w/c 14 Sept has ONE day inside it. Generating
    // a full week there produced work that could never fit and was then
    // reported to the student as a failure.
    const specs = quotaTasksNeeded([quota()], {
      fromKey: "2026-08-25",
      toKey: "2026-09-15",
      existing: new Set(),
    });
    expect(specs.map((s) => s.quotaWeek)).not.toContain("2026-09-14");
  });

  it("still generates every week that fits", () => {
    const specs = quotaTasksNeeded([quota()], {
      fromKey: "2026-08-25",
      toKey: "2026-09-15",
      existing: new Set(),
    });
    expect(specs.map((s) => s.quotaWeek)).toEqual([
      "2026-08-24", "2026-08-31", "2026-09-07",
    ]);
  });

  it("pro-rates the week already under way", () => {
    // Asked on Tuesday: Tue-Sun is six days left, not seven.
    const specs = quotaTasksNeeded([quota()], {
      fromKey: "2026-08-25",
      toKey: "2026-09-15",
      existing: new Set(),
    });
    const current = specs.find((s) => s.quotaWeek === "2026-08-24")!;
    expect(current.estimateMin).toBe(Math.round((350 * 6) / 7));
  });

  it("gives a future week its whole target", () => {
    const specs = quotaTasksNeeded([quota()], {
      fromKey: "2026-08-25",
      toKey: "2026-09-15",
      existing: new Set(),
    });
    expect(specs.find((s) => s.quotaWeek === "2026-08-31")!.estimateMin).toBe(350);
  });

  it("skips a token task when almost no week remains", () => {
    // Sunday: one day left, and a sliver of a target is not worth a row.
    const specs = quotaTasksNeeded([quota({ targetMinWeek: 60 })], {
      fromKey: "2026-08-30",
      toKey: "2026-09-15",
      existing: new Set(),
    });
    expect(specs.some((s) => s.quotaWeek === "2026-08-24")).toBe(false);
  });
});

describe("pro-rating", () => {
  it("leaves a week that has not started alone", () => {
    expect(proRatedTarget(350, "2026-08-31", "2026-08-25")).toBe(350);
  });

  it("scales by the days that remain", () => {
    expect(proRatedTarget(700, "2026-08-24", "2026-08-27")).toBe(400); // 4/7
  });

  it("returns nothing for a week already over", () => {
    expect(proRatedTarget(350, "2026-08-24", "2026-08-31")).toBe(0);
  });
});
