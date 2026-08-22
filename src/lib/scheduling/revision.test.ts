import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVALS,
  passMinutes,
  planRevisionPasses,
  shouldRestartCycle,
  type RevisionTopic,
} from "./revision";

const topic = (over: Partial<RevisionTopic> = {}): RevisionTopic => ({
  id: "t1",
  label: "Circular motion",
  subjectId: "physics",
  confidence: 2,
  triggeredOn: "2026-09-07",
  ...over,
});

const EXAM = "2028-04-27";

describe("spaced passes", () => {
  it("schedules the cycle at 1-3, ~7 and ~13 days", () => {
    const passes = planRevisionPasses(topic(), { examStartsOn: null });
    expect(passes.map((p) => [p.earliestOn, p.dueOn])).toEqual([
      ["2026-09-08", "2026-09-10"], // 1-3 days
      ["2026-09-13", "2026-09-15"], // ~7 days
      ["2026-09-18", "2026-09-22"], // ~13 days
    ]);
  });

  it("gives each pass a window, not a fixed day", () => {
    // A fixed date that lands on a written-off day or a triple-lesson
    // Wednesday just gets missed. The solver needs room to place it.
    const passes = planRevisionPasses(topic(), { examStartsOn: null });
    expect(passes.every((p) => p.dueOn > p.earliestOn)).toBe(true);
  });

  it("adds a pre-exam pass anchored to the exam, not the trigger", () => {
    const passes = planRevisionPasses(topic(), { examStartsOn: EXAM });
    const pre = passes.find((p) => p.isPreExam)!;
    expect(pre.earliestOn).toBe("2028-04-06"); // 21 days before
    expect(pre.dueOn).toBe("2028-04-20"); // 7 days before
  });

  it("skips the pre-exam pass when it would collide with the spaced ones", () => {
    // Flagged a fortnight before exams: a "pre-exam" pass would land on top of
    // the day-13 pass, which is two sessions on one topic in one day.
    const passes = planRevisionPasses(
      topic({ triggeredOn: "2028-04-10" }),
      { examStartsOn: EXAM },
    );
    expect(passes.some((p) => p.isPreExam)).toBe(false);
  });

  it("is idempotent — never regenerates a pass that exists", () => {
    const passes = planRevisionPasses(topic(), {
      examStartsOn: EXAM,
      existingPassIndices: new Set([0, 1]),
    });
    expect(passes.map((p) => p.passIndex)).toEqual([2, 3]);
  });

  it("emits nothing when the whole cycle is already scheduled", () => {
    const passes = planRevisionPasses(topic(), {
      examStartsOn: EXAM,
      existingPassIndices: new Set([0, 1, 2, 3]),
    });
    expect(passes).toEqual([]);
  });

  it("handles a trigger that crosses a month and year boundary", () => {
    const passes = planRevisionPasses(
      topic({ triggeredOn: "2026-12-28" }),
      { examStartsOn: null },
    );
    expect(passes[2].dueOn).toBe("2027-01-12");
  });
});

describe("pass length", () => {
  it("front-loads the first pass, where the relearning happens", () => {
    const first = passMinutes(2, 0, false);
    const second = passMinutes(2, 1, false);
    const third = passMinutes(2, 2, false);
    expect(first).toBeGreaterThan(second);
    expect(second).toBeGreaterThanOrEqual(third);
  });

  it("gives a shaky topic more time than a solid one", () => {
    expect(passMinutes(1, 0, false)).toBeGreaterThan(passMinutes(5, 0, false));
  });

  it("never schedules a session too short to be worth sitting down for", () => {
    for (const c of [1, 2, 3, 4, 5]) {
      for (const i of [0, 1, 2]) {
        expect(passMinutes(c, i, false)).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it("keeps later passes short — retrieval practice, not re-reading", () => {
    expect(passMinutes(2, 2, false)).toBeLessThanOrEqual(passMinutes(2, 0, false) * 0.75);
  });
});

describe("missed passes", () => {
  it("restarts the cycle when a pass is badly overdue", () => {
    // A day-7 pass done on day 30 did not buy the spacing it was meant to.
    expect(shouldRestartCycle("2026-09-14", "2026-10-14")).toBe(true);
  });

  it("tolerates a pass that slipped by a couple of days", () => {
    expect(shouldRestartCycle("2026-09-14", "2026-09-17")).toBe(false);
  });
});

describe("the interval set itself", () => {
  it("expands — each gap is longer than the last", () => {
    const starts = DEFAULT_INTERVALS.windows.map((w) => w.earliest);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThan(
        i > 1 ? starts[i - 1] - starts[i - 2] - 1 : 0,
      );
    }
  });

  it("widens the window as the gap grows", () => {
    const widths = DEFAULT_INTERVALS.windows.map((w) => w.due - w.earliest);
    expect(widths.at(-1)!).toBeGreaterThan(widths[0]);
  });
});
