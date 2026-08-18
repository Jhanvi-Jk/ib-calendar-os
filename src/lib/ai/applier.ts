"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PROPOSAL_SCHEMAS, requiresConfirmation, type ProposalKind } from "./schemas";
import type { Json } from "@/lib/types/database";

/**
 * The deterministic applier — the only path from model output to a database
 * write.
 *
 * Every write below is ordinary application code operating on data that has
 * already been validated twice: once when the proposal was stored, and again
 * here immediately before it is applied. The second validation is not
 * redundant: a proposal row is JSON that has been sitting in a table, and the
 * cost of re-checking it is a microsecond.
 */

export async function storeProposal(input: {
  kind: ProposalKind;
  payload: unknown;
  confidence: number;
  sourceKind: "user" | "pdf" | "notion" | "google" | "system";
  sourceRef?: string;
  isTrustedSource: boolean;
  suspectedInjection?: boolean;
  model?: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const schema = PROPOSAL_SCHEMAS[input.kind];
  const parsed = schema.safeParse(input.payload);

  // An invalid proposal is still recorded — silently discarding it would hide
  // a systematic parsing failure from whoever has to debug it.
  const status = parsed.success ? "pending" : "invalid";

  const { data, error } = await supabase
    .from("ai_proposals")
    .insert({
      user_id: user.id,
      kind: input.kind,
      status,
      payload: (parsed.success ? parsed.data : input.payload) as Json,
      model: input.model ?? "claude-opus-5",
      confidence: input.confidence,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef ?? null,
      is_trusted_source: input.isTrustedSource,
      validation_errors: parsed.success
        ? null
        : (parsed.error.issues as unknown as Json),
      requires_confirmation: requiresConfirmation({
        kind: input.kind,
        confidence: input.confidence,
        isTrustedSource: input.isTrustedSource,
        suspectedInjection: input.suspectedInjection,
      }),
    })
    .select("id")
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? "Insert failed" };
  return { ok: true, id: data.id };
}

export async function applyProposal(
  proposalId: string,
): Promise<{ ok: true; applied: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: proposal } = await supabase
    .from("ai_proposals")
    .select("id, kind, status, payload, requires_confirmation")
    .eq("id", proposalId)
    .single();

  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status === "applied") return { ok: false, error: "Already applied." };
  if (proposal.status === "invalid") {
    return { ok: false, error: "This proposal failed validation and cannot be applied." };
  }
  // A proposal needing confirmation must be explicitly approved first. This is
  // the gate that stops a high-confidence extraction from a hostile PDF being
  // written just because the pipeline ran.
  if (proposal.requires_confirmation && proposal.status !== "approved") {
    return { ok: false, error: "This proposal needs your confirmation first." };
  }

  const kind = proposal.kind as ProposalKind;
  const parsed = PROPOSAL_SCHEMAS[kind].safeParse(proposal.payload);
  if (!parsed.success) {
    await supabase
      .from("ai_proposals")
      .update({
        status: "invalid",
        validation_errors: parsed.error.issues as unknown as Json,
      })
      .eq("id", proposalId);
    return { ok: false, error: "Proposal no longer validates; it was not applied." };
  }

  let applied = 0;

  switch (kind) {
    case "task_extract": {
      const payload = parsed.data as import("./schemas").TaskExtraction;
      const { data: subjects } = await supabase.from("subjects").select("id, name");
      const byName = new Map(
        (subjects ?? []).map((s) => [s.name.toLowerCase(), s.id]),
      );

      const rows = payload.tasks.map((t) => ({
        user_id: user.id,
        title: t.title,
        subject_id: t.subjectHint ? (byName.get(t.subjectHint.toLowerCase()) ?? null) : null,
        estimate_min: t.estimateMin,
        cognitive_load: t.cognitiveLoad,
        splittable: t.splittable,
        deadline_at: parseIsoOrNull(t.deadlineIso),
        notes: t.sourceQuote ? `Extracted from: "${t.sourceQuote}"` : null,
      }));

      if (rows.length > 0) {
        const { error } = await supabase.from("tasks").insert(rows);
        if (error) return { ok: false, error: error.message };
        applied = rows.length;
      }
      break;
    }

    case "estimate": {
      const payload = parsed.data as import("./schemas").EstimateProposal;
      const { error } = await supabase
        .from("tasks")
        .update({
          estimate_min: payload.estimateMin,
          cognitive_load: payload.cognitiveLoad,
        })
        .eq("id", payload.taskId);
      if (error) return { ok: false, error: error.message };
      applied = 1;
      break;
    }

    case "classify": {
      const payload = parsed.data as import("./schemas").ClassificationProposal;
      let subjectId: string | null = null;
      if (payload.subjectName) {
        const { data: subject } = await supabase
          .from("subjects")
          .select("id")
          .ilike("name", payload.subjectName)
          .maybeSingle();
        subjectId = subject?.id ?? null;
      }
      const { error } = await supabase
        .from("tasks")
        .update({
          subject_id: subjectId,
          cognitive_load: payload.cognitiveLoad,
          splittable: payload.splittable,
        })
        .eq("id", payload.taskId);
      if (error) return { ok: false, error: error.message };
      applied = 1;
      break;
    }

    case "dependency": {
      const payload = parsed.data as import("./schemas").DependencyProposal;
      const { data: tasks } = await supabase.from("tasks").select("id, title");
      const byTitle = new Map((tasks ?? []).map((t) => [t.title.toLowerCase(), t.id]));

      for (const edge of payload.edges) {
        const predecessor = byTitle.get(edge.predecessorTitle.toLowerCase());
        const successor = byTitle.get(edge.successorTitle.toLowerCase());
        if (!predecessor || !successor || predecessor === successor) continue;

        // Cycles are rejected by the database trigger. One bad edge should not
        // abort the rest of the batch, so failures are skipped, not thrown.
        const { error } = await supabase.from("task_dependencies").insert({
          user_id: user.id,
          predecessor_id: predecessor,
          successor_id: successor,
        });
        if (!error) applied++;
      }
      break;
    }

    case "reschedule_intent":
      // Intents are executed by the calendar actions, not written as rows.
      return { ok: false, error: "Reschedule intents are not applied through this path." };
  }

  await supabase
    .from("ai_proposals")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("id", proposalId);

  revalidatePath("/tasks");
  revalidatePath("/calendar");
  return { ok: true, applied };
}

export async function setProposalStatus(
  proposalId: string,
  status: "approved" | "rejected",
) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("ai_proposals")
    .update({ status })
    .eq("id", proposalId);
  if (error) return { ok: false as const, error: error.message };
  revalidatePath("/tasks");
  return { ok: true as const };
}

function parseIsoOrNull(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
