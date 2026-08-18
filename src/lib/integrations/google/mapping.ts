import { fnv1a, canonicalize } from "@/lib/scheduling/hash";
import type { ConstraintTier } from "@/lib/domain/types";

/**
 * Pure translation between Google Calendar events and our own.
 *
 * Kept free of I/O so the echo-suppression and tier-inference rules — the two
 * places where two-way sync usually goes wrong — can be unit tested.
 */

export interface GoogleEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  etag?: string;
  updated?: string;
  transparency?: "opaque" | "transparent";
  eventType?: string;
}

export interface LocalEventDraft {
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  tier: ConstraintTier;
  kind: "class" | "exam" | "appointment" | "sleep" | "commitment" | "travel" | "general";
  rrule: string | null;
}

/**
 * Infers how immovable an imported event is.
 *
 * Deliberately conservative: anything that looks like an exam or a lesson is
 * Tier 1, because the cost of wrongly treating an exam as movable is far
 * higher than the cost of wrongly protecting a study group. Users can demote
 * anything; the sync layer never promotes silently after they do.
 */
export function inferTierAndKind(event: GoogleEvent): {
  tier: ConstraintTier;
  kind: LocalEventDraft["kind"];
} {
  const text = `${event.summary ?? ""} ${event.description ?? ""}`.toLowerCase();

  if (/\b(exam|paper [123]|mock|final|midterm|assessment|ib exam)\b/.test(text)) {
    return { tier: 1, kind: "exam" };
  }
  if (/\b(class|lesson|lecture|period|tutorial|lab|seminar)\b/.test(text)) {
    return { tier: 1, kind: "class" };
  }
  if (/\b(doctor|dentist|appointment|interview|therapy|orthodont)\b/.test(text)) {
    return { tier: 1, kind: "appointment" };
  }
  if (/\b(flight|train|commute|travel|drive)\b/.test(text)) {
    return { tier: 2, kind: "travel" };
  }
  if (/\b(practice|rehearsal|training|club|cas|volunteer|meeting)\b/.test(text)) {
    return { tier: 2, kind: "commitment" };
  }

  // "transparent" is Google's way of saying "I'm free during this". Treating
  // it as a hard block would wall off large parts of the week for nothing.
  if (event.transparency === "transparent") {
    return { tier: 4, kind: "general" };
  }

  return { tier: 2, kind: "general" };
}

export function toLocalEvent(event: GoogleEvent): LocalEventDraft | null {
  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date;
  if (!startRaw || !endRaw) return null;

  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  const { tier, kind } = inferTierAndKind(event);

  return {
    title: event.summary?.trim() || "(no title)",
    description: event.description ?? null,
    location: event.location ?? null,
    startsAt: new Date(startRaw).toISOString(),
    endsAt: new Date(endRaw).toISOString(),
    allDay,
    tier,
    kind,
    rrule: event.recurrence?.find((r) => r.startsWith("RRULE:")) ?? null,
  };
}

/**
 * Canonical fingerprint of an event's user-visible content.
 *
 * Echo suppression depends entirely on this: when we push a change to Google,
 * Google pushes it straight back on the next sync. If the inbound hash equals
 * the one we stored, it is our own write returning and must be dropped.
 * Without this the two systems update each other forever.
 *
 * Only fields we actually round-trip are included — etag and `updated` change
 * on every write and would defeat the whole mechanism.
 */
export function contentHash(draft: LocalEventDraft): string {
  return fnv1a(
    canonicalize({
      title: draft.title,
      description: draft.description,
      location: draft.location,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      allDay: draft.allDay,
      rrule: draft.rrule,
    }),
  );
}

/** Our event, in the shape Google's API expects. */
export function toGoogleEvent(draft: LocalEventDraft): Record<string, unknown> {
  return {
    summary: draft.title,
    description: draft.description ?? undefined,
    location: draft.location ?? undefined,
    start: draft.allDay
      ? { date: draft.startsAt.slice(0, 10) }
      : { dateTime: draft.startsAt },
    end: draft.allDay ? { date: draft.endsAt.slice(0, 10) } : { dateTime: draft.endsAt },
    ...(draft.rrule ? { recurrence: [draft.rrule] } : {}),
  };
}

export const isCancelled = (event: GoogleEvent): boolean => event.status === "cancelled";
