"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/** Time tracking. The feedback loop that makes estimates true. */

/**
 * Every surface that displays remaining time or timer state. Focus and
 * Calendar were previously missing, so stopping a timer left the Focus screen
 * showing the pre-timer "1h left" until a manual reload.
 */
function revalidateTimerViews() {
  revalidatePath("/tasks");
  revalidatePath("/review");
  revalidatePath("/focus");
  revalidatePath("/calendar");
}

export async function startTimer(taskId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  // Only one timer may run at a time — the database enforces this with a
  // partial unique index, so close any open entry first rather than letting
  // the insert fail.
  await supabase
    .from("time_entries")
    .update({ ended_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("ended_at", null);

  const { error } = await supabase.from("time_entries").insert({
    user_id: user.id,
    task_id: taskId,
    started_at: new Date().toISOString(),
  });
  if (error) return { ok: false as const, error: error.message };

  await supabase.from("tasks").update({ status: "in_progress" }).eq("id", taskId);

  revalidateTimerViews();
  return { ok: true as const };
}

export async function stopTimer() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  // The trigger on time_entries rolls the minutes into tasks.actual_min and
  // decrements remaining_min, so nothing else needs updating here.
  const { error } = await supabase
    .from("time_entries")
    .update({ ended_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .is("ended_at", null);
  if (error) return { ok: false as const, error: error.message };

  revalidateTimerViews();
  return { ok: true as const };
}

/** End-of-day retrospective. */
export async function saveRetrospective(input: {
  day: string;
  wins: string[];
  friction: string[];
  energyRating: number | null;
  note: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error } = await supabase.from("retrospectives").upsert(
    {
      user_id: user.id,
      day: input.day,
      wins: input.wins,
      friction: input.friction,
      energy_rating: input.energyRating,
      note: input.note || null,
    },
    { onConflict: "user_id,day" },
  );
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/review");
  return { ok: true as const };
}

/**
 * Write off a day — illness, family, burnout.
 *
 * Idempotent by unique index: writing off the same day twice is a no-op, not
 * two write-offs. Re-plans afterwards so the work actually moves instead of
 * silently becoming an overdue pile.
 */
export async function writeOffDay(input: {
  day: string;
  reason?: "illness" | "family" | "travel" | "burnout" | "other";
  note?: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) {
    return { ok: false as const, error: "Invalid date." };
  }

  const { error } = await supabase.from("day_write_offs").upsert(
    {
      user_id: user.id,
      day: input.day,
      reason: input.reason ?? "illness",
      note: input.note || null,
    },
    { onConflict: "user_id,day" },
  );
  if (error) return { ok: false as const, error: error.message };

  const { autoReplanIfSafe } = await import("@/app/(app)/calendar/actions");
  await autoReplanIfSafe();

  revalidateTimerViews();
  return { ok: true as const };
}

export async function undoWriteOff(day: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("day_write_offs").delete().eq("day", day);
  if (error) return { ok: false as const, error: error.message };

  const { autoReplanIfSafe } = await import("@/app/(app)/calendar/actions");
  await autoReplanIfSafe();

  revalidateTimerViews();
  return { ok: true as const };
}
