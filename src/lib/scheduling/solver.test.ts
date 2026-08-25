import { describe, expect, it } from "vitest";
import { solve } from "./solver";
import { buildDag, DependencyCycleError } from "./dag";
import { hashSnapshot, canonicalize } from "./hash";
import { normalize, subtract, totalMinutes } from "./intervals";
import { buildFreeIntervals, sleepIntervals } from "./capacity";
import {
  DEFAULT_SETTINGS,
  MONDAY,
  at,
  dep,
  event,
  larkEnergy,
  owlEnergy,
  snapshot,
  subject,
  task,
} from "./fixtures";
import { minutesIntoLocalDay } from "@/lib/time";
import type { PlacedBlock } from "@/lib/domain/types";

const minutesOf = (b: PlacedBlock) => b.endsAt - b.startsAt;
const totalPlaced = (blocks: PlacedBlock[]) => blocks.reduce((s, b) => s + minutesOf(b), 0);
const forTask = (blocks: PlacedBlock[], id: string) => blocks.filter((b) => b.taskId === id);

describe("intervals", () => {
  it("coalesces touching intervals", () => {
    expect(normalize([{ start: 10, end: 20 }, { start: 20, end: 30 }])).toEqual([
      { start: 10, end: 30 },
    ]);
  });

  it("treats half-open intervals as non-overlapping when they touch", () => {
    const free = subtract([{ start: 0, end: 100 }], [{ start: 0, end: 50 }]);
    expect(free).toEqual([{ start: 50, end: 100 }]);
  });

  it("punches a hole in the middle", () => {
    expect(subtract([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });
});

describe("capacity", () => {
  it("protects sleep across midnight", () => {
    const s = snapshot();
    const sleep = sleepIntervals(
      { start: s.horizonStart, end: s.horizonEnd },
      s.settings,
      "UTC",
    );
    // 23:00 -> 07:00 is an 8h window that must not be split at midnight.
    expect(sleep.every((i) => i.end - i.start === 480)).toBe(true);
  });

  it("never offers free time inside the sleep window", () => {
    const free = buildFreeIntervals(snapshot());
    for (const slot of free) {
      const startMin = minutesIntoLocalDay(slot.start, "UTC");
      const endMin = startMin + (slot.end - slot.start);
      expect(startMin).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.dayStartMin);
      expect(endMin).toBeLessThanOrEqual(DEFAULT_SETTINGS.dayEndMin);
    }
  });

  it("removes tier-1 events from available time", () => {
    const exam = event("exam", at(1, 9), 120, { tier: 1, kind: "exam" });
    const withExam = totalMinutes(buildFreeIntervals(snapshot({ events: [exam] })));
    const without = totalMinutes(buildFreeIntervals(snapshot()));
    expect(without - withExam).toBe(120);
  });
});

describe("dag", () => {
  it("orders prerequisites first", () => {
    const tasks = [task("final"), task("draft"), task("outline")];
    const edges = [dep("outline", "draft"), dep("draft", "final")];
    const { order } = buildDag(tasks, edges);
    expect(order).toEqual(["outline", "draft", "final"]);
  });

  it("pulls deadlines backward through the chain", () => {
    const deadline = at(6, 12);
    const tasks = [
      task("outline", { remainingMin: 60 }),
      task("draft", { remainingMin: 180, deadlineAt: deadline }),
    ];
    const { effectiveDeadline } = buildDag(tasks, [dep("outline", "draft")]);

    // The outline inherits: draft's deadline minus the draft's own 180 minutes.
    expect(effectiveDeadline.get("outline")).toBe(deadline - 180);
    expect(effectiveDeadline.get("draft")).toBe(deadline);
  });

  it("computes the critical path through the longest chain", () => {
    const tasks = [
      task("a", { remainingMin: 60 }),
      task("b", { remainingMin: 120 }),
      task("c", { remainingMin: 30 }),
    ];
    const { criticalPathMin } = buildDag(tasks, [dep("a", "b"), dep("a", "c")]);
    expect(criticalPathMin.get("a")).toBe(180); // 60 + max(120, 30)
  });

  it("throws rather than looping when a cycle slips past the database", () => {
    const tasks = [task("a"), task("b")];
    expect(() => buildDag(tasks, [dep("a", "b"), dep("b", "a")])).toThrow(
      DependencyCycleError,
    );
  });

  it("ignores edges pointing at tasks outside the snapshot", () => {
    const tasks = [task("a")];
    const { order } = buildDag(tasks, [dep("a", "already-done")]);
    expect(order).toEqual(["a"]);
  });
});

describe("solver — guarantees", () => {
  it("schedules a simple task in full", () => {
    const result = solve(snapshot({ tasks: [task("t1", { remainingMin: 120 })] }));
    expect(totalPlaced(result.blocks)).toBe(120);
    expect(result.infeasibility).toHaveLength(0);
    expect(result.stats.tasksPlaced).toBe(1);
  });

  it("never schedules during protected sleep", () => {
    // Far more work than the waking day can hold, so the solver is under
    // maximum pressure to spill into the night.
    const tasks = Array.from({ length: 30 }, (_, i) =>
      task(`t${i}`, { remainingMin: 240 }),
    );
    const result = solve(snapshot({ tasks }));

    for (const block of result.blocks) {
      const startMin = minutesIntoLocalDay(block.startsAt, "UTC");
      const endMin = startMin + minutesOf(block);
      expect(startMin).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.dayStartMin);
      expect(endMin).toBeLessThanOrEqual(DEFAULT_SETTINGS.dayEndMin);
    }
  });

  it("never overlaps a tier-1 event", () => {
    const exam = event("exam", at(1, 9), 180, { tier: 1, kind: "exam" });
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task(`t${i}`, { remainingMin: 180 }),
    );
    const result = solve(snapshot({ events: [exam], tasks }));

    for (const b of result.blocks) {
      expect(b.startsAt < exam.endsAt && exam.startsAt < b.endsAt).toBe(false);
    }
  });

  it("produces no overlapping blocks", () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task(`t${i}`, { remainingMin: 150 }),
    );
    const { blocks } = solve(snapshot({ tasks }));
    const sorted = [...blocks].sort((a, b) => a.startsAt - b.startsAt);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startsAt).toBeGreaterThanOrEqual(sorted[i - 1].endsAt);
    }
  });

  it("respects max_daily_focus_min", () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task(`t${i}`, { remainingMin: 240 }),
    );
    const { blocks } = solve(snapshot({ tasks }));

    const perDay = new Map<number, number>();
    for (const b of blocks) {
      const day = Math.floor((b.startsAt - MONDAY) / 1440);
      perDay.set(day, (perDay.get(day) ?? 0) + minutesOf(b));
    }
    for (const total of perDay.values()) {
      expect(total).toBeLessThanOrEqual(DEFAULT_SETTINGS.maxDailyFocusMin);
    }
  });

  it("never emits a block shorter than the minimum session", () => {
    // Quota-shaped work: a weekly target that does not divide evenly by the
    // session length. Greedy chunking used to take maxChunk until whatever was
    // left could not fill one, then wave the remainder through as a "final
    // stub" — 240 in 75s became 75+75+75+15, and a real plan came out with 18
    // of 78 blocks under the floor.
    const tasks = [
      task("physics", { remainingMin: 240, minChunkMin: 45, maxChunkMin: 75 }),
      task("french", { remainingMin: 150, minChunkMin: 25, maxChunkMin: 35 }),
      task("maths", { remainingMin: 330, minChunkMin: 60, maxChunkMin: 75 }),
    ];
    const { blocks } = solve(snapshot({ tasks }));

    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      const floor = Math.max(
        DEFAULT_SETTINGS.minBlockMin,
        tasks.find((t) => t.id === b.taskId)!.minChunkMin,
      );
      expect(minutesOf(b)).toBeGreaterThanOrEqual(floor);
    }
  });

  it("spreads a quota evenly instead of stranding the remainder", () => {
    // 240 minutes in sessions of at most 75 needs four sittings. Four even
    // sittings of 60 beat three of 75 and a 15-minute orphan.
    const tasks = [task("physics", { remainingMin: 240, minChunkMin: 45, maxChunkMin: 75 })];
    const { blocks } = solve(snapshot({ tasks }));

    expect(totalPlaced(blocks)).toBe(240);
    const sizes = blocks.map(minutesOf);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("finishes a prerequisite before its dependent starts", () => {
    const tasks = [
      task("draft", { remainingMin: 120, deadlineAt: at(5, 12) }),
      task("outline", { remainingMin: 60 }),
    ];
    const result = solve(
      snapshot({ tasks, dependencies: [dep("outline", "draft")] }),
    );

    const outlineEnd = Math.max(...forTask(result.blocks, "outline").map((b) => b.endsAt));
    const draftStart = Math.min(...forTask(result.blocks, "draft").map((b) => b.startsAt));
    expect(outlineEnd).toBeLessThanOrEqual(draftStart);
  });

  it("honours a start-to-start dependency without requiring completion", () => {
    const tasks = [
      task("reading", { remainingMin: 120 }),
      task("notes", { remainingMin: 60 }),
    ];
    const result = solve(
      snapshot({ tasks, dependencies: [dep("reading", "notes", { depType: "SS" })] }),
    );
    const readingStart = Math.min(...forTask(result.blocks, "reading").map((b) => b.startsAt));
    const notesStart = Math.min(...forTask(result.blocks, "notes").map((b) => b.startsAt));
    expect(notesStart).toBeGreaterThanOrEqual(readingStart);
  });

  it("carries locked blocks through untouched", () => {
    const locked = {
      taskId: "pinned",
      startsAt: at(2, 14),
      endsAt: at(2, 16),
      sequenceIndex: 0,
      isLocked: true,
      energyScore: 1,
    };
    const result = solve(
      snapshot({
        tasks: [task("pinned", { remainingMin: 120 }), task("other", { remainingMin: 180 })],
        lockedBlocks: [locked],
      }),
    );

    const kept = result.blocks.find(
      (b) => b.taskId === "pinned" && b.startsAt === locked.startsAt,
    );
    expect(kept).toBeDefined();
    expect(kept?.isLocked).toBe(true);
    // Nothing else may be placed on top of it.
    for (const b of result.blocks) {
      if (b === kept) continue;
      expect(b.startsAt < locked.endsAt && locked.startsAt < b.endsAt).toBe(false);
    }
  });

  it("reports unplaceable work instead of silently dropping it", () => {
    // 40 hours due in two days: impossible by construction.
    const impossible = task("huge", {
      remainingMin: 2400,
      deadlineAt: at(2, 12),
    });
    const result = solve(snapshot({ tasks: [impossible] }));

    expect(result.infeasibility).toHaveLength(1);
    const report = result.infeasibility[0];
    expect(report.taskId).toBe("huge");
    expect(report.shortfallMin).toBeGreaterThan(0);
    expect(report.remedies.length).toBeGreaterThan(0);
    // Whatever it could fit, it still scheduled.
    expect(totalPlaced(result.blocks)).toBeGreaterThan(0);
  });

  it("marks a dependent blocked, not merely short of capacity", () => {
    const tasks = [
      task("prereq", { remainingMin: 4000, deadlineAt: at(1, 8) }),
      task("dependent", { remainingMin: 60, deadlineAt: at(6, 12) }),
    ];
    const result = solve(snapshot({ tasks, dependencies: [dep("prereq", "dependent")] }));

    const reasons = result.infeasibility.map((i) => i.reason);
    expect(reasons).toContain("blocked_by_dependency");
  });

  it("prioritises the urgent task when capacity is scarce", () => {
    const tasks = [
      task("urgent", { remainingMin: 300, deadlineAt: at(1, 23) }),
      task("relaxed", { remainingMin: 300, deadlineAt: at(6, 23) }),
    ];
    const result = solve(snapshot({ tasks }));

    const urgentEnd = Math.max(...forTask(result.blocks, "urgent").map((b) => b.endsAt));
    expect(urgentEnd).toBeLessThanOrEqual(at(1, 23));
  });

  it("places demanding work in peak hours for a lark", () => {
    const result = solve(
      snapshot({
        energy: larkEnergy(),
        tasks: [task("deep", { remainingMin: 120, cognitiveLoad: 5 })],
      }),
    );
    const start = minutesIntoLocalDay(result.blocks[0].startsAt, "UTC");
    // Lark peak is 08:00-11:00.
    expect(start).toBeGreaterThanOrEqual(7 * 60 + 30);
    expect(start).toBeLessThan(12 * 60);
  });

  it("places demanding work later in the day for an owl", () => {
    const result = solve(
      snapshot({
        energy: owlEnergy(),
        tasks: [task("deep", { remainingMin: 120, cognitiveLoad: 5 })],
      }),
    );
    const start = minutesIntoLocalDay(result.blocks[0].startsAt, "UTC");
    expect(start).toBeGreaterThanOrEqual(15 * 60);
  });

  it("keeps an unsplittable task in one contiguous block", () => {
    const result = solve(
      snapshot({
        tasks: [task("mock", { remainingMin: 150, splittable: false, maxChunkMin: 150 })],
      }),
    );
    const blocks = forTask(result.blocks, "mock");
    expect(blocks).toHaveLength(1);
    expect(minutesOf(blocks[0])).toBe(150);
  });

  it("respects a task's earliest start date", () => {
    const earliest = at(3, 9);
    const result = solve(
      snapshot({ tasks: [task("later", { remainingMin: 60, earliestStartAt: earliest })] }),
    );
    for (const b of result.blocks) {
      expect(b.startsAt).toBeGreaterThanOrEqual(earliest);
    }
  });

  it("does not schedule tasks that are already done", () => {
    const result = solve(
      snapshot({ tasks: [task("done", { remainingMin: 0, status: "done" })] }),
    );
    expect(result.blocks).toHaveLength(0);
  });
});

describe("solver — determinism", () => {
  const base = snapshot({
    subjects: [subject("maths"), subject("physics")],
    tasks: [
      task("a", { remainingMin: 180, subjectId: "maths", deadlineAt: at(4, 12) }),
      task("b", { remainingMin: 120, subjectId: "physics", cognitiveLoad: 5 }),
      task("c", { remainingMin: 240, subjectId: "maths", deadlineAt: at(6, 12) }),
      task("d", { remainingMin: 60, priorityPin: 2 }),
    ],
    dependencies: [dep("a", "c")],
    energy: larkEnergy(),
  });

  it("returns identical output for identical input", () => {
    const first = solve(base);
    const second = solve(base);
    expect(JSON.stringify(second.blocks)).toBe(JSON.stringify(first.blocks));
  });

  it("is unaffected by the order of tasks and dependencies in the input", () => {
    const shuffled = {
      ...base,
      tasks: [...base.tasks].reverse(),
      dependencies: [...base.dependencies].reverse(),
    };
    const a = solve(base);
    const b = solve(shuffled);
    expect(JSON.stringify(b.blocks)).toBe(JSON.stringify(a.blocks));
  });

  it("hashes identical snapshots identically regardless of key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(hashSnapshot(base)).toBe(hashSnapshot({ ...base }));
  });

  it("changes the hash when any scheduling input changes", () => {
    const before = hashSnapshot(base);
    const after = hashSnapshot({
      ...base,
      tasks: [...base.tasks, task("new", { remainingMin: 30 })],
    });
    expect(after).not.toBe(before);
  });

  it("uses only integer minutes in its output", () => {
    for (const b of solve(base).blocks) {
      expect(Number.isInteger(b.startsAt)).toBe(true);
      expect(Number.isInteger(b.endsAt)).toBe(true);
    }
  });
});
