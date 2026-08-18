/**
 * Notion property mapping — pure, so the fragile part is testable.
 *
 * Notion databases have user-defined schemas. Rather than guessing column
 * names at call time, we resolve a mapping once and reuse it, and we treat
 * every page's text as untrusted (a shared Notion database is something other
 * people can write to).
 */

export interface NotionProperty {
  id: string;
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  date?: { start: string | null; end: string | null } | null;
  number?: number | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  checkbox?: boolean;
  status?: { name: string } | null;
}

export interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  properties: Record<string, NotionProperty>;
}

export interface PropertyMap {
  title: string;
  deadline: string | null;
  estimate: string | null;
  subject: string | null;
  done: string | null;
}

/**
 * Infers which Notion columns mean what, by type first and name second.
 *
 * Type-first matters: exactly one property in a Notion database can be the
 * title, so that one is unambiguous no matter what the user called it.
 */
export function inferPropertyMap(
  schema: Record<string, { type: string }>,
): PropertyMap | null {
  const entries = Object.entries(schema);

  const title = entries.find(([, p]) => p.type === "title")?.[0];
  if (!title) return null;

  const byName = (candidates: string[], types: string[]) =>
    entries.find(
      ([name, prop]) =>
        types.includes(prop.type) &&
        candidates.some((c) => name.toLowerCase().includes(c)),
    )?.[0] ?? null;

  return {
    title,
    deadline:
      byName(["due", "deadline", "date"], ["date"]) ??
      entries.find(([, p]) => p.type === "date")?.[0] ??
      null,
    estimate: byName(["estimate", "duration", "time", "min"], ["number"]),
    subject: byName(["subject", "class", "course"], ["select", "multi_select"]),
    done: byName(["done", "complete", "status"], ["checkbox", "status"]),
  };
}

export interface NotionTaskDraft {
  remoteId: string;
  title: string;
  deadlineIso: string | null;
  estimateMin: number | null;
  subjectName: string | null;
  isDone: boolean;
}

export function toTaskDraft(
  page: NotionPage,
  map: PropertyMap,
): NotionTaskDraft | null {
  const titleProp = page.properties[map.title];
  const title = titleProp?.title?.map((t) => t.plain_text).join("").trim();
  // A row with no title is a placeholder the user hasn't filled in yet.
  if (!title) return null;

  const deadline = map.deadline ? page.properties[map.deadline]?.date?.start : null;

  const rawEstimate = map.estimate ? page.properties[map.estimate]?.number : null;
  // Notion numbers are unbounded; clamp before they reach a CHECK constraint.
  const estimateMin =
    typeof rawEstimate === "number" && rawEstimate > 0
      ? Math.min(2400, Math.max(5, Math.round(rawEstimate)))
      : null;

  const subjectProp = map.subject ? page.properties[map.subject] : undefined;
  const subjectName =
    subjectProp?.select?.name ?? subjectProp?.multi_select?.[0]?.name ?? null;

  const doneProp = map.done ? page.properties[map.done] : undefined;
  const isDone =
    doneProp?.checkbox === true ||
    /^(done|complete|completed|finished)$/i.test(doneProp?.status?.name ?? "");

  return {
    remoteId: page.id,
    title: title.slice(0, 200),
    deadlineIso: deadline ? new Date(deadline).toISOString() : null,
    estimateMin,
    subjectName,
    isDone,
  };
}
