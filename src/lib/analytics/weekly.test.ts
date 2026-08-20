import { describe, expect, it } from "vitest";
import { buildWeeklyReview } from "./weekly";
import type { DayRecord } from "./momentum";

const day = (date: string, plannedMin: number, completedMin: number): DayRecord => ({
  date,
  plannedMin,
  completedMin,
});

const task = (
  id: string,
  remainingMin: number,
  estimateMin: number,
  deadlineKey: string | null,
) => ({ id, title: id, remainingMin, estimateMin, deadlineKey });

const week = (planned: number, completed: number) =>
  Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, planned, completed));

const base = {
  todayKey: "2026-09-08",
  todayDow: 2, // Tuesday — not a review day
  lastReviewKey: null as string | null,
  week: week(60, 60),
  openTasks: [] as ReturnType<typeof task>[],
};

describe("when the review is due", () => {
  it("is due on Sunday and Monday", () => {
    expect(buildWeeklyReview({ ...base, todayDow: 0, lastReviewKey: "2026-09-01" }).isDue).toBe(true);
    expect(buildWeeklyReview({ ...base, todayDow: 1, lastReviewKey: "2026-09-01" }).isDue).toBe(true);
  });

  it("is not due mid-week if one was done recently", () => {
    expect(
      buildWeeklyReview({ ...base, todayDow: 3, lastReviewKey: "2026-09-06" }).isDue,
    ).toBe(false);
  });

  it("is due mid-week once a week has passed", () => {
    expect(
      buildWeeklyReview({ ...base, todayDow: 3, lastReviewKey: "2026-09-01" }).isDue,
    ).toBe(true);
  });

  it("is due when there has never been one", () => {
    expect(buildWeeklyReview({ ...base, todayDow: 3, lastReviewKey: null }).isDue).toBe(true);
  });

  it("does not prompt twice on the same day", () => {
    // Even on a Sunday, once today's review is saved the prompt goes away.
    expect(
      buildWeeklyReview({ ...base, todayDow: 0, lastReviewKey: "2026-09-08" }).isDue,
    ).toBe(false);
  });
});

describe("follow-through", () => {
  it("reports null rather than zero when nothing was planned", () => {
    const r = buildWeeklyReview({ ...base, week: week(0, 0) });
    expect(r.followThrough).toBeNull();
    expect(r.headline).toMatch(/nothing was planned/i);
  });

  it("never exceeds 1 when more was done than planned", () => {
    expect(buildWeeklyReview({ ...base, week: week(60, 600) }).followThrough).toBe(1);
  });

  it("blames the plan, not the student, when most of it slipped", () => {
    const r = buildWeeklyReview({ ...base, week: week(120, 20) });
    expect(r.headline).toMatch(/about the plan, not about you/i);
  });
});

describe("what slipped", () => {
  it("puts overdue work first and leads with it", () => {
    const r = buildWeeklyReview({
      ...base,
      openTasks: [
        task("partial", 30, 60, "2026-09-20"),
        task("late", 60, 60, "2026-09-01"),
      ],
    });
    expect(r.slipped[0].id).toBe("late");
    expect(r.slipped[0].reason).toBe("overdue");
    expect(r.headline).toMatch(/past their deadline|past its deadline/i);
  });

  it("ignores untouched work that is not yet late", () => {
    // Not started and not due is simply "not started" — surfacing it as a
    // failure would make the review noise.
    const r = buildWeeklyReview({
      ...base,
      openTasks: [task("future", 60, 60, "2026-12-01")],
    });
    expect(r.slipped).toHaveLength(0);
  });

  it("counts partly-done work as slipped", () => {
    const r = buildWeeklyReview({
      ...base,
      openTasks: [task("half", 30, 60, "2026-09-20")],
    });
    expect(r.slipped[0].reason).toBe("partial");
  });

  it("caps the list so the review stays readable", () => {
    const many = Array.from({ length: 12 }, (_, i) => task(`t${i}`, 30, 60, "2026-09-20"));
    expect(buildWeeklyReview({ ...base, openTasks: many }).slipped).toHaveLength(6);
  });
});

describe("next week's load", () => {
  it("counts only work due within the next seven days", () => {
    const r = buildWeeklyReview({
      ...base,
      openTasks: [
        task("soon", 120, 120, "2026-09-10"),
        task("later", 300, 300, "2026-10-30"),
        task("undated", 90, 90, null),
      ],
    });
    expect(r.nextWeekCommittedMin).toBe(120);
  });

  it("excludes work that is already overdue from next week's load", () => {
    const r = buildWeeklyReview({
      ...base,
      openTasks: [task("late", 120, 120, "2026-09-01")],
    });
    expect(r.nextWeekCommittedMin).toBe(0);
  });
});
