import { describe, expect, it } from "vitest";
import { buildDayBudgets, buildFreeIntervals, effectiveDailyCapacity } from "./capacity";
import { solve } from "./solver";
import { snapshot as makeSnapshot, task } from "./fixtures";
import { localDateKey } from "@/lib/time";

/**
 * Writing a day off must remove its capacity, not merely annotate it.
 * If the solver still schedules into a sick day the feature is decorative.
 */
describe("written-off days", () => {
  it("gives a written-off day zero capacity", () => {
    const base = makeSnapshot({
      tasks: [
        task("t1", { remainingMin: 120 }),
        task("t2", { remainingMin: 90 }),
        task("t3", { remainingMin: 60 }),
      ],
    });
    const firstDay = localDateKey(base.horizonStart, base.timezone);
    const snapshot = { ...base, writtenOffDays: [firstDay] };

    const budgets = buildDayBudgets(snapshot, buildFreeIntervals(snapshot));
    expect(effectiveDailyCapacity(budgets.get(firstDay)!)).toBe(0);
  });

  it("leaves other days untouched", () => {
    const base = makeSnapshot({
      tasks: [
        task("t1", { remainingMin: 120 }),
        task("t2", { remainingMin: 90 }),
        task("t3", { remainingMin: 60 }),
      ],
    });
    const firstDay = localDateKey(base.horizonStart, base.timezone);
    const withOff = { ...base, writtenOffDays: [firstDay] };

    const before = buildDayBudgets(base, buildFreeIntervals(base));
    const after = buildDayBudgets(withOff, buildFreeIntervals(withOff));

    for (const [key, budget] of after) {
      if (key === firstDay) continue;
      expect(effectiveDailyCapacity(budget)).toBe(
        effectiveDailyCapacity(before.get(key)!),
      );
    }
  });

  it("schedules nothing into a written-off day", () => {
    const base = makeSnapshot({
      tasks: [
        task("t1", { remainingMin: 120 }),
        task("t2", { remainingMin: 90 }),
        task("t3", { remainingMin: 60 }),
      ],
    });
    const firstDay = localDateKey(base.horizonStart, base.timezone);
    const result = solve({ ...base, writtenOffDays: [firstDay] });

    const onSickDay = result.blocks.filter(
      (b) => localDateKey(b.startsAt, base.timezone) === firstDay,
    );
    expect(onSickDay).toEqual([]);
  });

  it("moves the work rather than dropping it", () => {
    // The point is redistribution. Losing the task entirely would be worse
    // than leaving it where it was.
    const base = makeSnapshot({
      tasks: [
        task("t1", { remainingMin: 120 }),
        task("t2", { remainingMin: 90 }),
        task("t3", { remainingMin: 60 }),
      ],
    });
    const firstDay = localDateKey(base.horizonStart, base.timezone);

    const normal = solve(base);
    const sick = solve({ ...base, writtenOffDays: [firstDay] });

    const placed = (r: typeof normal) => new Set(r.blocks.map((b) => b.taskId));
    // Every task that could be placed normally is still placed somewhere,
    // unless it genuinely no longer fits before its deadline.
    const lost = [...placed(normal)].filter((id) => !placed(sick).has(id));
    const unplaceable = new Set(sick.infeasibility.map((i) => i.taskId));
    for (const id of lost) expect(unplaceable.has(id)).toBe(true);
  });

  it("is a no-op when nothing is written off", () => {
    const base = makeSnapshot({
      tasks: [
        task("t1", { remainingMin: 120 }),
        task("t2", { remainingMin: 90 }),
        task("t3", { remainingMin: 60 }),
      ],
    });
    expect(solve({ ...base, writtenOffDays: [] }).blocks.length).toBe(
      solve(base).blocks.length,
    );
  });
});
