import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM_INDEX,
  ZOOM_LEVELS,
  clampZoomIndex,
  gridStepMin,
} from "./zoom";

describe("zoom levels", () => {
  it("only ever yields a level that exists", () => {
    for (const i of [-5, -1, 0, 2, 99, 4.7]) {
      const c = clampZoomIndex(i);
      expect(ZOOM_LEVELS[c]).toBeDefined();
    }
  });

  it("falls back to the default for junk", () => {
    expect(clampZoomIndex(NaN)).toBe(DEFAULT_ZOOM_INDEX);
    expect(clampZoomIndex(Number("nonsense"))).toBe(DEFAULT_ZOOM_INDEX);
  });

  it("gets taller with every step", () => {
    for (let i = 1; i < ZOOM_LEVELS.length; i++) {
      expect(ZOOM_LEVELS[i]).toBeGreaterThan(ZOOM_LEVELS[i - 1]);
    }
  });
});

describe("gridlines follow the zoom", () => {
  it("shows hours when there is no room for more", () => {
    expect(gridStepMin(2.25)).toBe(60);
    expect(gridStepMin(3.5)).toBe(60);
  });

  it("adds half-hours once an hour is tall enough", () => {
    expect(gridStepMin(5)).toBe(30);
  });

  it("adds quarters at the top of the range", () => {
    expect(gridStepMin(11)).toBe(15);
  });

  it("never gets finer as it gets shorter", () => {
    const steps = ZOOM_LEVELS.map(gridStepMin);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeLessThanOrEqual(steps[i - 1]);
    }
  });
});
