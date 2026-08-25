import { describe, expect, it } from "vitest";
import { dueReminders, reminderBody, type RemindableBlock } from "./reminders";

const NOW = 1_000_000;
const block = (id: string, startsAt: number, title = id): RemindableBlock => ({
  id,
  title,
  startsAt,
});

const run = (blocks: RemindableBlock[], over: Partial<Parameters<typeof dueReminders>[1]> = {}) =>
  dueReminders(blocks, { nowMin: NOW, leadMin: 10, ...over });

describe("what gets a reminder", () => {
  it("arms one lead time before the session", () => {
    const r = run([block("a", NOW + 60)]);
    expect(r[0]).toMatchObject({ blockId: "a", fireAt: NOW + 50, leadMin: 10 });
  });

  it("never fires for work that already started", () => {
    // "Starts in 10 minutes" twenty minutes in is nagging, not help.
    expect(run([block("past", NOW - 20)])).toEqual([]);
  });

  it("still reminds you if you opened the tab inside the lead window", () => {
    const r = run([block("soon", NOW + 4)]);
    expect(r[0].fireAt).toBe(NOW);
    expect(r[0].leadMin).toBe(4);
  });

  it("does not arm a timer for tomorrow", () => {
    expect(run([block("far", NOW + 24 * 60)])).toEqual([]);
  });

  it("respects a wider horizon when asked", () => {
    expect(run([block("far", NOW + 24 * 60)], { horizonMin: 48 * 60 })).toHaveLength(1);
  });

  it("never notifies the same block twice", () => {
    const sent = new Set(["a"]);
    expect(run([block("a", NOW + 60)], { alreadySent: sent })).toEqual([]);
  });

  it("orders by when they fire, not when they were passed in", () => {
    const r = run([block("late", NOW + 200), block("early", NOW + 30)]);
    expect(r.map((x) => x.blockId)).toEqual(["early", "late"]);
  });

  it("handles a zero lead time as 'now'", () => {
    const r = run([block("a", NOW + 5)], { leadMin: 0 });
    expect(r[0].fireAt).toBe(NOW + 5);
    expect(reminderBody(r[0])).toBe("Starting now.");
  });
});

describe("wording", () => {
  it("does not say '1 minutes'", () => {
    expect(reminderBody({ blockId: "a", title: "x", startsAt: 0, fireAt: 0, leadMin: 1 }))
      .toBe("Starts in a minute.");
  });

  it("counts down in whole minutes", () => {
    expect(reminderBody({ blockId: "a", title: "x", startsAt: 0, fireAt: 0, leadMin: 15 }))
      .toBe("Starts in 15 minutes.");
  });
});
