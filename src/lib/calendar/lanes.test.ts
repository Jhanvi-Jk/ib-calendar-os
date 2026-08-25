import { describe, expect, it } from "vitest";
import { assignLanes } from "./lanes";

const at = (startMin: number, endMin: number, id = `${startMin}`) => ({ startMin, endMin, id });
const byId = <T extends { id: string }>(r: T[], id: string) => r.find((x) => x.id === id)!;

describe("lane assignment", () => {
  it("gives a lone item the whole width", () => {
    const r = assignLanes([at(540, 600)]);
    expect(r[0]).toMatchObject({ lane: 0, lanes: 1 });
  });

  it("puts two overlapping items side by side", () => {
    // This is the bug it exists for: full-width stacking hid one entirely.
    const r = assignLanes([at(540, 660, "a"), at(600, 720, "b")]);
    expect(byId(r, "a")).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId(r, "b")).toMatchObject({ lane: 1, lanes: 2 });
  });

  it("keeps sequential items full width", () => {
    const r = assignLanes([at(540, 600, "a"), at(600, 660, "b")]);
    expect(byId(r, "a").lanes).toBe(1);
    expect(byId(r, "b").lanes).toBe(1);
  });

  it("reuses a lane once it is free", () => {
    const r = assignLanes([at(540, 720, "long"), at(540, 600, "x"), at(620, 680, "y")]);
    expect(byId(r, "x").lane).toBe(1);
    expect(byId(r, "y").lane).toBe(1);
    expect(byId(r, "long").lane).toBe(0);
  });

  it("widens the whole cluster to the busiest moment", () => {
    // Every item in a cluster shares a width or the columns do not line up.
    const r = assignLanes([at(540, 660, "a"), at(560, 660, "b"), at(580, 660, "c")]);
    expect(r.every((x) => x.lanes === 3)).toBe(true);
  });

  it("does not let a chain merge two independent clusters", () => {
    const morning = [at(540, 600, "a"), at(550, 610, "b")];
    const evening = [at(1000, 1060, "c"), at(1010, 1070, "d")];
    const r = assignLanes([...morning, ...evening]);
    expect(byId(r, "a").lanes).toBe(2);
    expect(byId(r, "c").lanes).toBe(2);
  });

  it("gives the longer item the left lane on a shared start", () => {
    const r = assignLanes([at(540, 600, "short"), at(540, 720, "long")]);
    expect(byId(r, "long").lane).toBe(0);
    expect(byId(r, "short").lane).toBe(1);
  });

  it("still places a zero-length item rather than hiding it", () => {
    const r = assignLanes([at(540, 600, "real"), at(560, 560, "empty")]);
    expect(byId(r, "empty").lanes).toBe(2);
  });

  it("returns every item it was given", () => {
    const items = Array.from({ length: 25 }, (_, i) => at(540 + i * 10, 540 + i * 10 + 90, `i${i}`));
    expect(assignLanes(items)).toHaveLength(25);
  });
});
