import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/data/queries";
import { getAcademicDates } from "@/lib/data/planning";
import {
  planRevisionPasses,
  type RevisionTopic,
} from "@/lib/scheduling/revision";
import { localDateKey, toEpochMinute } from "@/lib/time";

/**
 * Revision cycles: starting one, and materialising its passes as real tasks.
 *
 * A pass becomes an ordinary task with a window (earliest_start_at ..
 * deadline_at), so the existing solver places it. That means revision
 * automatically respects sleep, lessons, quotas, written-off days and the
 * capacity model, with no revision-specific scheduling code.
 */

export const getRevisionTopics = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("revision_topics")
    .select("id, label, subject_id, confidence, triggered_on, origin, is_active, subjects(name)")
    .eq("is_active", true)
    .order("triggered_on", { ascending: false });

  if (error) return [];
  return (data ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    subjectId: t.subject_id,
    subjectName: (t.subjects as unknown as { name: string } | null)?.name ?? null,
    confidence: t.confidence,
    triggeredOn: t.triggered_on,
    origin: t.origin,
  }));
});

/**
 * Flag a topic as shaky and schedule its cycle.
 *
 * `todayKey` is the trigger date; every pass offset counts from it. Returns
 * how many passes were created so the caller can say what happened rather
 * than silently adding work.
 */
export async function startRevisionCycle(input: {
  subjectId: string | null;
  label: string;
  confidence: number;
}): Promise<{ ok: true; passes: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) return { ok: false, error: "Not signed in." };

  const todayKey = localDateKey(toEpochMinute(new Date()), ctx.timezone);

  const { data: topic, error } = await supabase
    .from("revision_topics")
    .insert({
      user_id: ctx.userId,
      subject_id: input.subjectId,
      label: input.label.trim(),
      confidence: input.confidence,
      origin: "weak_spot",
      triggered_on: todayKey,
    })
    .select("id, label, subject_id, confidence, triggered_on")
    .single();

  if (error || !topic) return { ok: false, error: error?.message ?? "Could not save." };

  const board = await getAcademicDates();
  // Anchor the final pass to the exam session if one is set.
  const examStartsOn = board.primary?.startsOn ?? null;

  const domainTopic: RevisionTopic = {
    id: topic.id,
    label: topic.label,
    subjectId: topic.subject_id,
    confidence: topic.confidence,
    triggeredOn: topic.triggered_on,
  };

  const specs = planRevisionPasses(domainTopic, { examStartsOn });
  if (specs.length === 0) return { ok: true, passes: 0 };

  // Create the tasks first, then the passes that point at them, so a pass row
  // never references a task that failed to insert.
  const { data: tasks, error: taskError } = await supabase
    .from("tasks")
    .insert(
      specs.map((s) => ({
        user_id: ctx.userId,
        subject_id: input.subjectId,
        title: `Revise: ${input.label}${s.isPreExam ? " (pre-exam)" : ` (pass ${s.passIndex + 1})`}`,
        estimate_min: s.estimateMin,
        // Recall practice is demanding even when short.
        cognitive_load: 4,
        min_chunk_min: Math.min(20, s.estimateMin),
        max_chunk_min: s.estimateMin,
        splittable: false,
        earliest_start_at: new Date(`${s.earliestOn}T00:00:00Z`).toISOString(),
        deadline_at: new Date(`${s.dueOn}T23:59:00Z`).toISOString(),
      })),
    )
    .select("id");

  if (taskError || !tasks) return { ok: false, error: taskError?.message ?? "Could not schedule." };

  const { error: passError } = await supabase.from("revision_passes").insert(
    specs.map((s, i) => ({
      user_id: ctx.userId,
      topic_id: topic.id,
      pass_index: s.passIndex,
      is_pre_exam: s.isPreExam,
      earliest_on: s.earliestOn,
      due_on: s.dueOn,
      estimate_min: s.estimateMin,
      task_id: tasks[i]?.id ?? null,
    })),
  );
  if (passError) return { ok: false, error: passError.message };

  return { ok: true, passes: specs.length };
}

export async function endRevisionCycle(topicId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("revision_topics")
    .update({ is_active: false })
    .eq("id", topicId);
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const };
}
