import { describe, expect, it } from "vitest";
import { computeRunway, type DayCapacity, type RunwayTask } from "./runway";

const t = (id: string, remainingMin: number, deadlineKey: string | null): RunwayTask => ({
  id,
  title: id,
  remainingMin,
  deadlineKey,
});

/** `days` consecutive days from `from`, each with `perDay` free minutes. */
function capacity(from: string, days: number, perDay: number): DayCapacity[] {
  const out: DayCapacity[] = [];
  const start = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push({ dateKey: d.toISOString().slice(0, 10), capacityMin: perDay });
  }
  return out;
}

describe("deadline runway", () => {
  it("says nothing useful without dated work", () => {
    const r = computeRunway([t("a", 120, null)], capacity("2026-09-01", 7, 180), "2026-09-01");
    expect(r.hasData).toBe(false);
    expect(r.worst).toBeNull();
  });

  it("reports comfortable when the work fits easily", () => {
    // 2h owed, 7 days x 3h free.
    const r = computeRunway([t("a", 120, "2026-09-07")], capacity("2026-09-01", 7, 180), "2026-09-01");
    expect(r.worst?.status).toBe("comfortable");
    expect(r.headline).toMatch(/comfortable/i);
  });

  it("detects a shortfall before the deadline arrives", () => {
    // 10h owed in 2 days, 1h free per day.
    const r = computeRunway([t("a", 600, "2026-09-02")], capacity("2026-09-01", 2, 60), "2026-09-01");
    expect(r.worst?.status).toBe("over");
    expect(r.worst?.shortfallMin).toBe(480);
    expect(r.headline).toMatch(/short/i);
  });

  it("accumulates across deadlines — earlier work eats later capacity", () => {
    // Each task alone fits. Together they do not, and that is the real story.
    const r = computeRunway(
      [t("a", 300, "2026-09-03"), t("b", 300, "2026-09-06")],
      capacity("2026-09-01", 6, 120), // 2h/day
      "2026-09-01",
    );
    const [first, second] = r.loads;

    expect(first.committedMin).toBe(300);
    // Second is cumulative, not just its own 300.
    expect(second.committedMin).toBe(600);
    expect(second.capacityMin).toBe(720);
    expect(second.status).toBe("tight");
  });

  it("points at the FIRST impossible deadline, not the worst ratio", () => {
    // Acting on the earliest breach is what actually helps.
    const r = computeRunway(
      [t("a", 600, "2026-09-02"), t("b", 6000, "2026-09-20")],
      capacity("2026-09-01", 20, 60),
      "2026-09-01",
    );
    expect(r.worst?.deadlineKey).toBe("2026-09-02");
  });

  it("does not bank capacity from days already gone", () => {
    // Capacity starts a week before "today"; none of it should count.
    const r = computeRunway(
      [t("a", 300, "2026-09-10")],
      capacity("2026-09-01", 14, 60),
      "2026-09-08",
    );
    // Only the 8th, 9th and 10th are available: 3h.
    expect(r.worst?.capacityMin).toBe(180);
  });

  it("flags an overdue deadline rather than hiding it", () => {
    const r = computeRunway(
      [t("a", 300, "2026-08-30")],
      capacity("2026-09-01", 7, 180),
      "2026-09-01",
    );
    expect(r.worst?.daysAway).toBeLessThan(0);
    expect(r.headline).toMatch(/overdue/i);
  });

  it("treats work with zero capacity as impossible, not as divide-by-zero", () => {
    const r = computeRunway(
      [t("a", 300, "2026-09-02")],
      [{ dateKey: "2026-09-01", capacityMin: 0 }, { dateKey: "2026-09-02", capacityMin: 0 }],
      "2026-09-01",
    );
    expect(r.worst?.status).toBe("over");
    expect(Number.isFinite(r.worst!.utilisation)).toBe(true);
  });

  it("ignores completed work", () => {
    const r = computeRunway(
      [t("done", 0, "2026-09-02"), t("open", 60, "2026-09-02")],
      capacity("2026-09-01", 3, 180),
      "2026-09-01",
    );
    expect(r.loads[0].taskCount).toBe(1);
    expect(r.loads[0].committedMin).toBe(60);
  });
});
