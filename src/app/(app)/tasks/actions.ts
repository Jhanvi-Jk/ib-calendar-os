"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

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
  const { error } = await supabase.from("subjects").insert({
    user_id: user.id,
    name: s.name,
    level: s.level,
    ib_group: s.level === "CORE" ? null : (s.ibGroup ?? 1),
    color_token: "neutral",
  });
  if (error) {
    return {
      ok: false as const,
      error: error.code === "23505" ? "You already have a subject with that name." : error.message,
    };
  }

  revalidatePath("/tasks");
  revalidatePath("/calendar");
  return { ok: true as const };
}
