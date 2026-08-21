"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const AcademicDateInput = z.object({
  kind: z.enum([
    "exam_session",
    "mock_exams",
    "term_start",
    "term_end",
    "half_term",
    "holiday",
    "coursework_deadline",
  ]),
  label: z.string().min(1).max(120),
  startsOn: z.string().regex(DATE_KEY),
  endsOn: z.string().regex(DATE_KEY).optional().or(z.literal("")),
  isPrimary: z.boolean().default(false),
});

export async function createAcademicDate(raw: unknown) {
  const parsed = AcademicDateInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid date" };
  }
  const d = parsed.data;
  const endsOn = d.endsOn || null;

  if (endsOn && endsOn < d.startsOn) {
    return { ok: false as const, error: "The end date is before the start date." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  // Only one anchor may exist, enforced by a partial unique index. Demote the
  // incumbent first rather than letting the insert fail with a constraint
  // error the user cannot act on.
  if (d.isPrimary) {
    await supabase
      .from("academic_dates")
      .update({ is_primary: false })
      .eq("user_id", user.id)
      .eq("is_primary", true);
  }

  const { error } = await supabase.from("academic_dates").insert({
    user_id: user.id,
    kind: d.kind,
    label: d.label.trim(),
    starts_on: d.startsOn,
    ends_on: endsOn,
    is_primary: d.isPrimary,
  });
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}

export async function deleteAcademicDate(id: string) {
  const supabase = await createClient();
  const { error } = await supabase.from("academic_dates").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}

const WeightInput = z.object({
  subjectId: z.string().uuid(),
  // 0.5 coasting .. 2.0 decides the offer. Bounded because the solver divides
  // by 2 to normalise, and an unbounded value would swamp every other term.
  gradeWeight: z.number().min(0.5).max(2),
});

export async function setSubjectWeight(raw: unknown) {
  const parsed = WeightInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: "Weight must be between 0.5 and 2." };
  }
  const { subjectId, gradeWeight } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase
    .from("subjects")
    .update({ grade_weight: gradeWeight })
    .eq("id", subjectId);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/settings");
  // Weight feeds the solver's priority term, so the existing plan is now stale.
  revalidatePath("/calendar");
  return { ok: true as const };
}

const QuotaInput = z.object({
  label: z.string().min(1).max(80),
  subjectId: z.string().uuid().nullable().optional(),
  targetMinWeek: z.number().int().min(15).max(3000),
  minSessionMin: z.number().int().min(10).max(240),
  maxSessionMin: z.number().int().min(10).max(300),
  cognitiveLoad: z.number().int().min(1).max(5),
});

/**
 * A recurring weekly commitment — SAT, TOPIK, language drilling.
 *
 * Deliberately no topic field. The quota protects the hours; what gets
 * studied inside them is decided at the desk, because a topic plan written in
 * September does not survive contact with a real term.
 */
export async function createStudyQuota(raw: unknown) {
  const parsed = QuotaInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Invalid quota" };
  }
  const q = parsed.data;
  if (q.maxSessionMin < q.minSessionMin) {
    return { ok: false as const, error: "Longest session can't be shorter than the shortest." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { error } = await supabase.from("study_quotas").insert({
    user_id: user.id,
    label: q.label.trim(),
    subject_id: q.subjectId || null,
    target_min_week: q.targetMinWeek,
    min_session_min: q.minSessionMin,
    max_session_min: q.maxSessionMin,
    cognitive_load: q.cognitiveLoad,
  });
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}

export async function setQuotaActive(id: string, isActive: boolean) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("study_quotas")
    .update({ is_active: isActive })
    .eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function deleteStudyQuota(id: string) {
  // Cascades to this quota's generated weekly tasks, including their tracked
  // time. The UI confirms before calling this.
  const supabase = await createClient();
  const { error } = await supabase.from("study_quotas").delete().eq("id", id);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/settings");
  revalidatePath("/calendar");
  return { ok: true as const };
}
