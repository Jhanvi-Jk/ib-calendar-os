"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { autoReplanIfSafe } from "@/app/(app)/calendar/actions";

const HHMM = /^\d{2}:\d{2}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const LessonInput = z.object({
  label: z.string().min(1).max(120),
  subjectId: z.string().uuid().nullable().optional(),
  room: z.string().max(60).optional(),
  dayOfWeek: z.number().int().min(0).max(6),
  startsAt: z.string().regex(HHMM),
  endsAt: z.string().regex(HHMM),
  parity: z.enum(["every", "A", "B"]).default("every"),
});

export async function createLesson(raw: unknown) {
  const parsed = LessonInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid lesson" };
  }
  const l = parsed.data;
  const startsMin = toMinutes(l.startsAt);
  const endsMin = toMinutes(l.endsAt);

  if (endsMin <= startsMin) {
    return { ok: false as const, error: "The lesson ends before it starts." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error } = await supabase.from("timetable_entries").insert({
    user_id: user.id,
    subject_id: l.subjectId || null,
    label: l.label.trim(),
    room: l.room?.trim() || null,
    day_of_week: l.dayOfWeek,
    starts_min: startsMin,
    ends_min: endsMin,
    parity: l.parity,
  });
  if (error) return { ok: false as const, error: error.message };

  // Lessons are Tier 1, so adding one changes what the solver may use.
  await autoReplanIfSafe();
  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}

export async function deleteLesson(id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("timetable_entries").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };

  await autoReplanIfSafe();
  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}

const AnchorInput = z.object({
  anchorMonday: z.string().regex(DATE_KEY).nullable(),
});

/** Sets which real week counts as Week A, or clears it for a 1-week timetable. */
export async function setTimetableAnchor(raw: unknown) {
  const parsed = AnchorInput.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "Invalid date." };
  const { anchorMonday } = parsed.data;

  if (anchorMonday) {
    // Parity counts whole weeks from this date, so a non-Monday anchor would
    // put the A/B boundary mid-week and quietly mislabel every lesson.
    const dow = new Date(`${anchorMonday}T12:00:00Z`).getUTCDay();
    if (dow !== 1) {
      return { ok: false as const, error: "Pick a Monday — weeks are counted from there." };
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error } = await supabase
    .from("user_settings")
    .update({ timetable_anchor_monday: anchorMonday })
    .eq("user_id", user.id);
  if (error) return { ok: false as const, error: error.message };

  await autoReplanIfSafe();
  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}
