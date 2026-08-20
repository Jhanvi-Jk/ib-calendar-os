import { describe, expect, it } from "vitest";
import {
  buildCountdowns,
  daysBetween,
  studyDaysUntil,
  toCountdown,
  type AcademicDate,
} from "./countdown";

const d = (
  id: string,
  kind: AcademicDate["kind"],
  label: string,
  startsOn: string,
  endsOn: string | null = null,
  isPrimary = false,
): AcademicDate => ({ id, kind, label, startsOn, endsOn, isPrimary });

describe("day arithmetic", () => {
  it("counts calendar days, not 24-hour periods", () => {
    expect(daysBetween("2027-05-01", "2027-05-02")).toBe(1);
    expect(daysBetween("2027-05-02", "2027-05-01")).toBe(-1);
    expect(daysBetween("2027-05-01", "2027-05-01")).toBe(0);
  });

  it("survives a spring-forward DST boundary", () => {
    // 2027-03-28 is the UK clock change. Anchoring at midnight would make this
    // 23 hours and round to 0 days.
    expect(daysBetween("2027-03-27", "2027-03-29")).toBe(2);
  });

  it("counts across a leap day", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("rejects malformed keys rather than returning NaN", () => {
    expect(() => daysBetween("May 2027", "2027-05-01")).toThrow(/YYYY-MM-DD/);
  });
});

describe("countdowns", () => {
  it("counts down to a future landmark", () => {
    const c = toCountdown(d("1", "exam_session", "IB May 2027", "2027-05-01"), "2027-03-21");
    expect(c.daysUntilStart).toBe(41);
    expect(c.phrase).toBe("starts in 41 days");
    expect(c.isActive).toBe(false);
    expect(c.isPast).toBe(false);
  });

  it("switches to counting down the END once something is running", () => {
    // Mid-half-term, "started 3 days ago" is useless; "ends in 4 days" is the
    // number the student is actually planning against.
    const c = toCountdown(
      d("2", "half_term", "October half term", "2026-10-24", "2026-11-01"),
      "2026-10-27",
    );
    expect(c.isActive).toBe(true);
    expect(c.phrase).toBe("ends in 5 days");
  });

  it("treats a range as past only after its end date", () => {
    const half = d("3", "half_term", "Half term", "2026-10-24", "2026-11-01");
    expect(toCountdown(half, "2026-11-01").isPast).toBe(false);
    expect(toCountdown(half, "2026-11-02").isPast).toBe(true);
  });

  it("says today/tomorrow rather than 0 and 1 days", () => {
    expect(toCountdown(d("4", "term_start", "Term", "2026-09-02"), "2026-09-02").phrase)
      .toBe("starts today");
    expect(toCountdown(d("5", "term_start", "Term", "2026-09-02"), "2026-09-01").phrase)
      .toBe("starts tomorrow");
  });

  it("pins the exam session as primary and keeps it out of the upcoming list", () => {
    const board = buildCountdowns(
      [
        d("exam", "exam_session", "IB May 2027", "2027-05-01", "2027-05-19", true),
        d("ht", "half_term", "Half term", "2026-10-24", "2026-11-01"),
        d("mock", "mock_exams", "Mocks", "2027-01-12", "2027-01-23"),
      ],
      "2026-09-01",
    );
    expect(board.primary?.id).toBe("exam");
    expect(board.upcoming.map((c) => c.id)).toEqual(["ht", "mock"]);
  });

  it("keeps the exam session pinned even once it has started", () => {
    const board = buildCountdowns(
      [d("exam", "exam_session", "IB May 2027", "2027-05-01", "2027-05-19", true)],
      "2027-05-04",
    );
    expect(board.primary?.isActive).toBe(true);
    expect(board.primary?.phrase).toBe("ends in 15 days");
  });

  it("drops finished landmarks out of upcoming", () => {
    const board = buildCountdowns(
      [
        d("old", "half_term", "Last half term", "2026-02-14", "2026-02-22"),
        d("next", "term_start", "Summer term", "2026-04-20"),
      ],
      "2026-03-01",
    );
    expect(board.upcoming.map((c) => c.id)).toEqual(["next"]);
    expect(board.past.map((c) => c.id)).toEqual(["old"]);
  });
});

describe("study days", () => {
  it("separates break days from term days in the run-up", () => {
    const r = studyDaysUntil("2027-04-01", "2027-05-01", [
      { startsOn: "2027-04-03", endsOn: "2027-04-18", kind: "half_term" },
    ]);
    expect(r.calendarDays).toBe(30);
    expect(r.inBreak).toBe(16);
  });

  it("clamps a break that runs past the target", () => {
    const r = studyDaysUntil("2027-04-01", "2027-04-05", [
      { startsOn: "2027-03-20", endsOn: "2027-05-01", kind: "holiday" },
    ]);
    expect(r.inBreak).toBeLessThanOrEqual(r.calendarDays);
  });

  it("ignores landmarks that are not breaks", () => {
    const r = studyDaysUntil("2027-04-01", "2027-05-01", [
      { startsOn: "2027-04-10", endsOn: "2027-04-12", kind: "mock_exams" },
    ]);
    expect(r.inBreak).toBe(0);
  });
});
