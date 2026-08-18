import { describe, expect, it } from "vitest";
import { inferPropertyMap, toTaskDraft, type NotionPage } from "./mapping";

const schema = {
  Name: { type: "title" },
  "Due date": { type: "date" },
  "Estimate (min)": { type: "number" },
  Subject: { type: "select" },
  Done: { type: "checkbox" },
};

const page = (over: Partial<NotionPage["properties"]> = {}): NotionPage => ({
  id: "page-1",
  properties: {
    Name: { id: "t", type: "title", title: [{ plain_text: "Physics IA draft" }] },
    "Due date": { id: "d", type: "date", date: { start: "2026-03-14", end: null } },
    "Estimate (min)": { id: "e", type: "number", number: 180 },
    Subject: { id: "s", type: "select", select: { name: "Physics" } },
    Done: { id: "c", type: "checkbox", checkbox: false },
    ...over,
  },
});

describe("property inference", () => {
  it("finds the title by type, whatever the user named it", () => {
    const map = inferPropertyMap({ "My Thing": { type: "title" } });
    expect(map?.title).toBe("My Thing");
  });

  it("matches the other columns by name and type", () => {
    const map = inferPropertyMap(schema)!;
    expect(map.deadline).toBe("Due date");
    expect(map.estimate).toBe("Estimate (min)");
    expect(map.subject).toBe("Subject");
    expect(map.done).toBe("Done");
  });

  it("falls back to any date column when none is named like a deadline", () => {
    const map = inferPropertyMap({
      Name: { type: "title" },
      Whenever: { type: "date" },
    })!;
    expect(map.deadline).toBe("Whenever");
  });

  it("returns null for a database with no title property", () => {
    expect(inferPropertyMap({ Notes: { type: "rich_text" } })).toBeNull();
  });
});

describe("page translation", () => {
  const map = inferPropertyMap(schema)!;

  it("reads a well-formed row", () => {
    const draft = toTaskDraft(page(), map)!;
    expect(draft.title).toBe("Physics IA draft");
    expect(draft.estimateMin).toBe(180);
    expect(draft.subjectName).toBe("Physics");
    expect(draft.isDone).toBe(false);
    expect(draft.deadlineIso?.slice(0, 10)).toBe("2026-03-14");
  });

  it("skips a row with no title", () => {
    expect(toTaskDraft(page({ Name: { id: "t", type: "title", title: [] } }), map)).toBeNull();
  });

  it("clamps an absurd estimate before it reaches a CHECK constraint", () => {
    const draft = toTaskDraft(
      page({ "Estimate (min)": { id: "e", type: "number", number: 999999 } }),
      map,
    )!;
    expect(draft.estimateMin).toBeLessThanOrEqual(2400);
  });

  it("ignores a zero or negative estimate rather than storing it", () => {
    const draft = toTaskDraft(
      page({ "Estimate (min)": { id: "e", type: "number", number: 0 } }),
      map,
    )!;
    expect(draft.estimateMin).toBeNull();
  });

  it("recognises completion from a status column too", () => {
    const statusMap = inferPropertyMap({
      Name: { type: "title" },
      Status: { type: "status" },
    })!;
    const draft = toTaskDraft(
      {
        id: "p",
        properties: {
          Name: { id: "t", type: "title", title: [{ plain_text: "Essay" }] },
          Status: { id: "s", type: "status", status: { name: "Completed" } },
        },
      },
      statusMap,
    )!;
    expect(draft.isDone).toBe(true);
  });

  it("truncates an over-long title", () => {
    const draft = toTaskDraft(
      page({
        Name: { id: "t", type: "title", title: [{ plain_text: "x".repeat(500) }] },
      }),
      map,
    )!;
    expect(draft.title.length).toBe(200);
  });
});
