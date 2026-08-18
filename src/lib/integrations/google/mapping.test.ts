import { describe, expect, it } from "vitest";
import {
  contentHash,
  inferTierAndKind,
  isCancelled,
  toGoogleEvent,
  toLocalEvent,
  type GoogleEvent,
} from "./mapping";

const gEvent = (over: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: "evt-1",
  status: "confirmed",
  summary: "Something",
  start: { dateTime: "2026-05-04T09:00:00Z" },
  end: { dateTime: "2026-05-04T10:00:00Z" },
  ...over,
});

describe("tier inference", () => {
  it("treats exams as immutable", () => {
    expect(inferTierAndKind(gEvent({ summary: "Physics HL Paper 1" })).tier).toBe(1);
    expect(inferTierAndKind(gEvent({ summary: "Maths Mock Exam" })).kind).toBe("exam");
  });

  it("treats timetabled lessons as immutable", () => {
    const result = inferTierAndKind(gEvent({ summary: "Chemistry class" }));
    expect(result.tier).toBe(1);
    expect(result.kind).toBe("class");
  });

  it("treats appointments as immutable", () => {
    expect(inferTierAndKind(gEvent({ summary: "Dentist appointment" })).tier).toBe(1);
  });

  it("treats extracurriculars as committed rather than immutable", () => {
    expect(inferTierAndKind(gEvent({ summary: "Orchestra rehearsal" })).tier).toBe(2);
  });

  it("does not wall off time the user marked as free", () => {
    // Google's "transparent" means "I'm available"; blocking it would erase
    // large parts of the week for no reason.
    const result = inferTierAndKind(
      gEvent({ summary: "Tentative hangout", transparency: "transparent" }),
    );
    expect(result.tier).toBe(4);
  });

  it("defaults unknown events to committed, not immutable", () => {
    expect(inferTierAndKind(gEvent({ summary: "Coffee with Sam" })).tier).toBe(2);
  });
});

describe("event translation", () => {
  it("converts a timed event", () => {
    const draft = toLocalEvent(gEvent());
    expect(draft?.allDay).toBe(false);
    expect(draft?.startsAt).toBe("2026-05-04T09:00:00.000Z");
  });

  it("recognises all-day events", () => {
    const draft = toLocalEvent(
      gEvent({ start: { date: "2026-05-04" }, end: { date: "2026-05-05" } }),
    );
    expect(draft?.allDay).toBe(true);
  });

  it("returns null for an event with no usable times", () => {
    expect(toLocalEvent(gEvent({ start: undefined, end: undefined }))).toBeNull();
  });

  it("falls back to a placeholder title rather than an empty string", () => {
    expect(toLocalEvent(gEvent({ summary: "   " }))?.title).toBe("(no title)");
  });

  it("round-trips through the Google shape", () => {
    const draft = toLocalEvent(gEvent())!;
    const google = toGoogleEvent(draft) as { summary: string };
    expect(google.summary).toBe(draft.title);
  });

  it("detects cancellation", () => {
    expect(isCancelled(gEvent({ status: "cancelled" }))).toBe(true);
  });
});

describe("echo suppression", () => {
  it("hashes identical content identically", () => {
    const a = toLocalEvent(gEvent())!;
    const b = toLocalEvent(gEvent())!;
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("ignores etag and updated timestamps", () => {
    // These change on every write. If they fed the hash, every push would
    // look like a remote change and the two systems would loop forever.
    const a = toLocalEvent(gEvent({ etag: "aaa", updated: "2026-01-01T00:00:00Z" }))!;
    const b = toLocalEvent(gEvent({ etag: "zzz", updated: "2026-09-09T00:00:00Z" }))!;
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("changes when the user-visible content changes", () => {
    const before = toLocalEvent(gEvent())!;
    const renamed = toLocalEvent(gEvent({ summary: "Renamed" }))!;
    const moved = toLocalEvent(
      gEvent({ start: { dateTime: "2026-05-04T11:00:00Z" } }),
    )!;

    expect(contentHash(renamed)).not.toBe(contentHash(before));
    expect(contentHash(moved)).not.toBe(contentHash(before));
  });
});
