"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { nextFreeSubjectColor } from "@/lib/domain/colors";
import { autoReplanIfSafe } from "@/app/(app)/calendar/actions";

const TaskInput = z.object({
  title: z.string().min(1).max(200),
  subjectId: z.string().uuid().nullable().optional(),
  estimateMin: z.number().int().min(5).max(2400),
  deadlineAt: z.string().optional(),
  cognitiveLoad: z.number().int().min(1).max(5),
  splittable: z.boolean().default(true),
});

export async function createTask(raw: unknown) {
  const parsed = TaskInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid task" };
  }
  const t = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error } = await supabase.from("tasks").insert({
    user_id: user.id,
    title: t.title,
    subject_id: t.subjectId || null,
    estimate_min: t.estimateMin,
    deadline_at: t.deadlineAt ? new Date(t.deadlineAt).toISOString() : null,
    cognitive_load: t.cognitiveLoad,
    splittable: t.splittable,
  });
  if (error) return { ok: false as const, error: error.message };

  await autoReplanIfSafe();
  revalidatePath("/tasks");
  revalidatePath("/calendar");
  return { ok: true as const };
}

export async function setTaskStatus(taskId: string, done: boolean) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("tasks")
    .update({
      status: done ? "done" : "todo",
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq("id", taskId);
  if (error) return { ok: false as const, error: error.message };

  await autoReplanIfSafe();
  revalidatePath("/tasks");
  revalidatePath("/calendar");
  return { ok: true as const };
}

export async function deleteTask(taskId: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/tasks");
  return { ok: true as const };
}

/**
 * Dependency edges are validated by the database, not here — the acyclicity
 * trigger is the authority. We surface its message rather than duplicating
 * graph logic that could drift out of sync with it.
 */
export async function linkDependency(predecessorId: string, successorId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error } = await supabase.from("task_dependencies").insert({
    user_id: user.id,
    predecessor_id: predecessorId,
    successor_id: successorId,
  });
  if (error) {
    return {
      ok: false as const,
      error: error.message.includes("Dependency cycle")
        ? "That would create a circular dependency."
        : error.message,
    };
  }
  revalidatePath("/tasks");
  return { ok: true as const };
}

const SubjectInput = z.object({
  name: z.string().min(1).max(80),
  level: z.enum(["HL", "SL", "CORE"]),
  ibGroup: z.number().int().min(1).max(6).nullable(),
});

/**
 * Subjects were only creatable during onboarding, which left anyone who
 * skipped a subject — or picked one up later — with no way to add it.
 */
export async function createSubject(raw: unknown) {
  const parsed = SubjectInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid subject" };
  }
  const s = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  // The DB enforces that CORE subjects carry no IB group; mirror that here so
  // the user gets a clean form rather than a constraint violation.
  // Trailing whitespace produces subjects that look identical but sort and
  // compare differently — "Maths AA " and "Maths AA " are not the same row.
  const name = s.name.trim();

  // "neutral" is not a colour the stylesheet defines, so a subject added after
  // onboarding used to come out uncoloured on the calendar. Take the lowest
  // hue nobody has yet.
  const { data: existing } = await supabase
    .from("subjects")
    .select("color_token")
    .eq("user_id", user.id);

  const { error } = await supabase.from("subjects").insert({
    user_id: user.id,
    name,
    level: s.level,
    ib_group: s.level === "CORE" ? null : (s.ibGroup ?? 1),
    color_token: nextFreeSubjectColor((existing ?? []).map((r) => r.color_token)),
  });
  if (error) {
    // The uniqueness constraint is on the NAME alone, not name+level. The
    // dropdown renders "Physics (HL)" by appending the level, so the stored
    // name looks different from what is displayed — quote it back exactly,
    // otherwise the error reads as false.
    return {
      ok: false as const,
      error:
        error.code === "23505"
          ? `You already have a subject called "${name}". Levels aren't part of the name, so you can't have two.`
          : error.message,
    };
  }

  await autoReplanIfSafe();
  revalidatePath("/tasks");
  revalidatePath("/calendar");
  return { ok: true as const };
}

const TaskUpdate = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  subjectId: z.string().uuid().nullable().optional(),
  estimateMin: z.number().int().min(5).max(2400),
  deadlineAt: z.string().nullable().optional(),
  cognitiveLoad: z.number().int().min(1).max(5),
});

/**
 * Edit an existing task. Previously the only way to correct a typo or move a
 * deadline was to delete and re-create, which threw away tracked time.
 */
export async function updateTask(raw: unknown) {
  const parsed = TaskUpdate.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid task" };
  }
  const t = parsed.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  // remaining_min is deliberately not touched: it is owned by the time-entry
  // trigger, and recomputing it here would discard tracked work.
  const { error } = await supabase
    .from("tasks")
    .update({
      title: t.title,
      subject_id: t.subjectId || null,
      estimate_min: t.estimateMin,
      deadline_at: t.deadlineAt ? new Date(t.deadlineAt).toISOString() : null,
      cognitive_load: t.cognitiveLoad,
    })
    .eq("id", t.id);
  if (error) return { ok: false as const, error: error.message };

  await autoReplanIfSafe();
  revalidatePath("/tasks");
  revalidatePath("/calendar");
  return { ok: true as const };
}
