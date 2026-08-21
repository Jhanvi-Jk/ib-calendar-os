import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/data/queries";
import {
  addDaysKey,
  mondayOf,
  quotaAttainment,
  quotaTasksNeeded,
  type QuotaReport,
  type StudyQuota,
} from "@/lib/scheduling/quotas";
import { addLocalDays, localDateKey, toEpochMinute } from "@/lib/time";

/**
 * Recurring quotas: reading them, materialising their weekly tasks, and
 * reporting attainment. All judgement lives in src/lib/scheduling/quotas.ts.
 */

export const getStudyQuotas = cache(async (): Promise<StudyQuota[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("study_quotas")
    .select(
      "id, label, subject_id, target_min_week, min_session_min, max_session_min, cognitive_load, priority_pin, is_active, active_from, active_to",
    )
    .order("label");

  // Migration 008 may not be applied yet — no quotas is a valid state, a
  // broken page is not.
  if (error) return [];

  return (data ?? []).map((q) => ({
    id: q.id,
    label: q.label,
    subjectId: q.subject_id,
    targetMinWeek: q.target_min_week,
    minSessionMin: q.min_session_min,
    maxSessionMin: q.max_session_min,
    cognitiveLoad: q.cognitive_load as StudyQuota["cognitiveLoad"],
    priorityPin: q.priority_pin as StudyQuota["priorityPin"],
    isActive: q.is_active,
    activeFrom: q.active_from,
    activeTo: q.active_to,
  }));
});

/**
 * Ensure a task exists for every active quota-week in the planning horizon.
 *
 * Called before a solve. Diff-based and guarded by a unique index, so running
 * it repeatedly — or concurrently from two devices — cannot duplicate a week
 * or reset progress on one already under way.
 *
 * Returns the number created, so callers can tell the student when the app
 * has added work on their behalf rather than doing it silently.
 */
export async function ensureQuotaTasks(horizonDays = 21): Promise<number> {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return 0;

  const quotas = (await getStudyQuotas()).filter((q) => q.isActive);
  if (quotas.length === 0) return 0;

  const nowMin = toEpochMinute(new Date());
  const fromKey = localDateKey(nowMin, ctx.timezone);
  const toKey = localDateKey(
    addLocalDays(nowMin, horizonDays, ctx.timezone),
    ctx.timezone,
  );

  const { data: existingRows } = await supabase
    .from("tasks")
    .select("quota_id, quota_week")
    .not("quota_id", "is", null)
    .gte("quota_week", mondayOf(fromKey));

  const existing = new Set(
    (existingRows ?? []).map((r) => `${r.quota_id}:${r.quota_week}`),
  );

  const specs = quotaTasksNeeded(quotas, { fromKey, toKey, existing });
  if (specs.length === 0) return 0;

  const { error } = await supabase.from("tasks").insert(
    specs.map((s) => ({
      user_id: ctx.userId,
      quota_id: s.quotaId,
      quota_week: s.quotaWeek,
      subject_id: s.subjectId,
      title: s.title,
      estimate_min: s.estimateMin,
      min_chunk_min: s.minChunkMin,
      max_chunk_min: s.maxChunkMin,
      cognitive_load: s.cognitiveLoad,
      priority_pin: s.priorityPin,
      // End of the quota week, local. 23:59 rather than midnight so the task
      // is due at the close of Sunday, not at its start.
      deadline_at: new Date(`${s.deadlineKey}T23:59:00Z`).toISOString(),
      splittable: true,
    })),
  );

  // A duplicate here means another request won the race — the desired state
  // already holds, so it is not an error worth surfacing.
  if (error && error.code !== "23505") {
    console.error("[quotas] failed to materialise weekly tasks:", error.message);
    return 0;
  }

  return specs.length;
}

/** Attainment over the recent past — did the hours actually happen? */
export const getQuotaReport = cache(async (weeks = 4): Promise<QuotaReport> => {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return quotaAttainment([]);

  const nowMin = toEpochMinute(new Date());
  const todayKey = localDateKey(nowMin, ctx.timezone);
  const firstWeek = addDaysKey(mondayOf(todayKey), -7 * (weeks - 1));

  const { data, error } = await supabase
    .from("tasks")
    .select("quota_week, estimate_min, actual_min, study_quotas(id, label)")
    .not("quota_id", "is", null)
    .gte("quota_week", firstWeek)
    .order("quota_week", { ascending: false });

  if (error) return quotaAttainment([]);

  return quotaAttainment(
    (data ?? []).map((t) => {
      const q = t.study_quotas as unknown as { id: string; label: string } | null;
      return {
        quotaId: q?.id ?? "unknown",
        label: q?.label ?? "Quota",
        weekMonday: t.quota_week as string,
        targetMin: t.estimate_min,
        doneMin: t.actual_min,
      };
    }),
  );
});
