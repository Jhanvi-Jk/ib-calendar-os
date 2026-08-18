import { describe, expect, it } from "vitest";
import { diffBlocks } from "./diff";
import { at } from "./fixtures";
import type { PlacedBlock } from "@/lib/domain/types";

const block = (taskId: string, start: number, minutes = 60): PlacedBlock => ({
  taskId,
  startsAt: start,
  endsAt: start + minutes,
  sequenceIndex: 0,
  isLocked: false,
  energyScore: 1,
});

describe("diffBlocks", () => {
  it("reports an unchanged plan as entirely unchanged", () => {
    const blocks = [block("a", at(1, 9)), block("b", at(1, 14))];
    const diff = diffBlocks(blocks, blocks);
    expect(diff.unchanged).toBe(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.moved).toHaveLength(0);
  });

  it("reads a shifted block as moved, not as a delete plus an insert", () => {
    const before = [block("a", at(1, 9))];
    const after = [block("a", at(1, 15))];
    const diff = diffBlocks(before, after);

    expect(diff.moved).toHaveLength(1);
    expect(diff.moved[0].from.startsAt).toBe(at(1, 9));
    expect(diff.moved[0].to.startsAt).toBe(at(1, 15));
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("detects added and removed work", () => {
    const diff = diffBlocks([block("gone", at(1, 9))], [block("fresh", at(2, 9))]);
    expect(diff.removed.map((b) => b.taskId)).toEqual(["gone"]);
    expect(diff.added.map((b) => b.taskId)).toEqual(["fresh"]);
  });

  it("handles a task gaining an extra block", () => {
    const before = [block("a", at(1, 9))];
    const after = [block("a", at(1, 9)), block("a", at(2, 9))];
    const diff = diffBlocks(before, after);
    expect(diff.unchanged).toBe(1);
    expect(diff.added).toHaveLength(1);
  });

  it("is independent of input ordering", () => {
    const before = [block("a", at(1, 9)), block("b", at(1, 14))];
    const after = [block("b", at(1, 14)), block("a", at(1, 9))];
    expect(diffBlocks(before, after).unchanged).toBe(2);
  });
});
