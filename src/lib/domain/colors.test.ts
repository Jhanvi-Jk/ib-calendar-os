import { describe, expect, it } from "vitest";
import {
  SUBJECT_COLOR_COUNT,
  nextFreeSubjectColor,
  subjectColorToken,
} from "./colors";

describe("subject colours", () => {
  it("gives a full IB diploma nine distinct hues", () => {
    // Six subjects plus TOK, CAS and the Extended Essay. Wrapping at 8 meant
    // the ninth silently shared a colour with the first.
    const tokens = Array.from({ length: 9 }, (_, i) => subjectColorToken(i));
    expect(new Set(tokens).size).toBe(9);
  });

  it("only ever names a hue the stylesheet defines", () => {
    for (let i = 0; i < 40; i++) {
      const n = Number(subjectColorToken(i).replace("subject-", ""));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(SUBJECT_COLOR_COUNT);
    }
  });

  it("takes the lowest colour nobody has", () => {
    expect(nextFreeSubjectColor(["subject-0", "subject-1"])).toBe("subject-2");
    expect(nextFreeSubjectColor(["subject-1", "subject-2"])).toBe("subject-0");
  });

  it("ignores tokens it did not issue", () => {
    // Subjects created before this existed carry "neutral".
    expect(nextFreeSubjectColor(["neutral", "neutral"])).toBe("subject-0");
  });

  it("does not hand out the same colour twice while any remain", () => {
    const taken: string[] = [];
    for (let i = 0; i < SUBJECT_COLOR_COUNT; i++) taken.push(nextFreeSubjectColor(taken));
    expect(new Set(taken).size).toBe(SUBJECT_COLOR_COUNT);
  });
});
