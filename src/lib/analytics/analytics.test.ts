import { describe, expect, it } from "vitest";
import {
  computeMomentum,
  heatLevel,
  recoveryPlanFor,
  type DayRecord,
} from "./momentum";
import {
  accuracyReport,
  adjustEstimate,
  calibrate,
  calibrateByBucket,
  percentile,
  RELIABILITY_THRESHOLD,
  type CompletedSample,
} from "./calibration";

const day = (date: string, planned: number, completed: number): DayRecord => ({
  date,
  plannedMin: planned,
  completedMin: completed,
});

const sample = (
  estimateMin: number,
  actualMin: number,
  over: Partial<CompletedSample> = {},
): CompletedSample => ({
  estimateMin,
  actualMin,
  subjectId: null,
  cognitiveLoad: 3,
  ...over,
});

describe("momentum", () => {
  it("reports thriving when the plan is landing", () => {
    const week = Array.from({ length: 7 }, (_, i) =>
      day(`2026-03-0${i + 1}`, 120, 115),
    );
    const result = computeMomentum(week);
    expect(result.state).toBe("thriving");
    expect(result.ratio).toBeGreaterThan(0.9);
  });

  it("reports strained when much of the plan is missed", () => {
    const week = Array.from({ length: 7 }, (_, i) =>
      day(`2026-03-0${i + 1}`, 240, 60),
    );
    expect(computeMomentum(week).state).toBe("strained");
  });

  it("does not punish a deliberate rest day", () => {
    // Six solid days plus one day with nothing planned.
    const week = [
      ...Array.from({ length: 6 }, (_, i) => day(`2026-03-0${i + 1}`, 120, 120)),
      day("2026-03-07", 0, 0),
    ];
    const result = computeMomentum(week);
    expect(result.restDays).toBe(1);
    expect(result.state).toBe("thriving");
  });

  it("never exceeds 1 — overwork is not health", () => {
    const week = Array.from({ length: 7 }, (_, i) =>
      day(`2026-03-0${i + 1}`, 60, 600),
    );
    expect(computeMomentum(week).ratio).toBe(1);
  });

  it("has no zero to reset to — one bad day only moves the number", () => {
    const good = Array.from({ length: 6 }, (_, i) => day(`2026-03-0${i + 1}`, 120, 120));
    const withMiss = [...good, day("2026-03-07", 120, 0)];

    const before = computeMomentum(good).ratio;
    const after = computeMomentum(withMiss).ratio;

    expect(after).toBeLessThan(before);
    // The crucial property: a missed day is a dent, not an erasure.
    expect(after).toBeGreaterThan(0.8);
  });

  it("recognises climbing out of a bad patch as recovering, not merely steady", () => {
    const week = Array.from({ length: 7 }, (_, i) => day(`2026-03-0${i + 1}`, 100, 70));
    expect(computeMomentum(week, { previousState: "strained" }).state).toBe(
      "recovering",
    );
    expect(computeMomentum(week, { previousState: "thriving" }).state).toBe("steady");
  });

  it("only considers the rolling window", () => {
    const history = [
      ...Array.from({ length: 20 }, (_, i) => day(`2026-02-${10 + i}`, 100, 0)),
      ...Array.from({ length: 7 }, (_, i) => day(`2026-03-0${i + 1}`, 100, 100)),
    ];
    expect(computeMomentum(history).state).toBe("thriving");
  });

  it("responds to strain by shrinking the plan, never by demanding more", () => {
    const plan = recoveryPlanFor("strained");
    expect(plan).not.toBeNull();
    expect(plan!.focusScale).toBeLessThan(1);
    expect(plan!.compressElastic).toBe(true);
  });

  it("has no recovery plan when things are fine", () => {
    expect(recoveryPlanFor("thriving")).toBeNull();
  });

  it("scales heatmap intensity with completed work", () => {
    expect(heatLevel(day("d", 0, 0))).toBe(0);
    expect(heatLevel(day("d", 0, 20))).toBe(1);
    expect(heatLevel(day("d", 0, 200))).toBe(4);
  });
});

describe("calibration", () => {
  it("interpolates percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2], 0.5)).toBe(1.5);
    expect(percentile([], 0.5)).toBe(1);
  });

  it("detects consistent underestimation", () => {
    const samples = Array.from({ length: 10 }, () => sample(60, 90));
    const result = calibrate(samples);
    expect(result.ratioP50).toBeCloseTo(1.5, 1);
    expect(result.isReliable).toBe(true);
  });

  it("is not reliable until there is enough data", () => {
    const few = Array.from({ length: RELIABILITY_THRESHOLD - 1 }, () => sample(60, 120));
    expect(calibrate(few).isReliable).toBe(false);
  });

  it("clamps a forgotten timer so one bad row cannot poison every estimate", () => {
    const samples = [
      ...Array.from({ length: 9 }, () => sample(60, 60)),
      sample(60, 6000), // timer left running overnight
    ];
    // Without clamping the p80 would be dragged toward 100x.
    expect(calibrate(samples).ratioP80).toBeLessThanOrEqual(5);
  });

  it("plans with p80 rather than the median", () => {
    const samples = [
      ...Array.from({ length: 8 }, () => sample(60, 60)),
      ...Array.from({ length: 2 }, () => sample(60, 180)),
    ];
    const result = calibrate(samples);
    expect(result.ratioP80).toBeGreaterThan(result.ratioP50);
  });

  it("leaves estimates alone until calibration is reliable", () => {
    const unreliable = calibrate([sample(60, 180)]);
    expect(adjustEstimate(60, unreliable)).toBe(60);
    expect(adjustEstimate(60, undefined)).toBe(60);
  });

  it("inflates estimates once calibration is reliable", () => {
    const reliable = calibrate(Array.from({ length: 10 }, () => sample(60, 120)));
    expect(adjustEstimate(60, reliable)).toBeGreaterThan(60);
  });

  it("buckets by subject and cognitive load", () => {
    const samples = [
      sample(60, 120, { subjectId: "maths", cognitiveLoad: 5 }),
      sample(60, 60, { subjectId: "english", cognitiveLoad: 2 }),
    ];
    const buckets = calibrateByBucket(samples);
    expect(buckets.get("maths:5")?.ratioP50).toBeCloseTo(2, 1);
    expect(buckets.get("english:2")?.ratioP50).toBeCloseTo(1, 1);
  });

  it("summarises accuracy without blaming the student", () => {
    const report = accuracyReport(Array.from({ length: 10 }, () => sample(60, 90)));
    expect(report.underestimated).toBe(10);
    expect(report.headline).toContain("longer than you expect");
    expect(report.headline).not.toMatch(/fail|bad|poor|should have/i);
  });

  it("handles having no data at all", () => {
    expect(accuracyReport([]).totalTasks).toBe(0);
  });
});
