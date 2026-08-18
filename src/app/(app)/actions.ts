"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/** Time tracking. The feedback loop that makes estimates true. */

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

  revalidatePath("/tasks");
  revalidatePath("/review");
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

  revalidatePath("/tasks");
  revalidatePath("/review");
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
