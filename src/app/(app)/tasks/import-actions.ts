"use server";

import { createClient } from "@/lib/supabase/server";
import { extractTasksFromDocument } from "@/lib/ai/extract";
import { storeProposal } from "@/lib/ai/applier";
import { getSubjects } from "@/lib/data/queries";
import { AiUnavailableError } from "@/lib/ai/client";

/**
 * Syllabus / assignment-sheet import.
 *
 * The document never reaches the database directly. It is parsed into a
 * proposal, which the user reviews and applies. Because the source is a file
 * a third party wrote, the proposal always requires confirmation — see
 * requiresConfirmation() in src/lib/ai/schemas.ts.
 */
export async function importSyllabus(input: { text: string; label: string }) {
  if (!input.text.trim()) {
    return { ok: false as const, error: "Paste some text first." };
  }
  if (input.text.length > 120_000) {
    return { ok: false as const, error: "That document is too long — split it up." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("timezone")
    .eq("id", user.id)
    .single();

  const subjects = await getSubjects();

  let result;
  try {
    result = await extractTasksFromDocument({
      text: input.text,
      label: input.label,
      subjects,
      todayIso: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return {
        ok: false as const,
        error: "AI import isn't configured yet (missing ANTHROPIC_API_KEY).",
      };
    }
    throw error;
  }

  if (!result.ok) {
    return {
      ok: false as const,
      error:
        result.reason === "refusal"
          ? "The model declined to parse that document."
          : `Could not read that document: ${result.detail}`,
    };
  }

  // Two independent injection signals: our own pre-scan, which ran before the
  // model saw anything, and the model's own report. Either one is enough to
  // put the whole import behind an explicit warning.
  const heuristic = result.heuristicFindings.length > 0 ? result.heuristicFindings : null;
  const suspected = result.value.suspectedInjection || heuristic !== null;

  const stored = await storeProposal({
    kind: "task_extract",
    payload: result.value,
    confidence: averageConfidence(result.value.tasks),
    sourceKind: "pdf",
    sourceRef: input.label,
    isTrustedSource: false,
    suspectedInjection: suspected,
  });

  if (!stored.ok) return { ok: false as const, error: stored.error };

  void profile;
  return {
    ok: true as const,
    proposalId: stored.id,
    taskCount: result.value.tasks.length,
    suspectedInjection: suspected,
    injectionQuote:
      result.value.injectionQuote ?? heuristic?.[0]?.quote ?? null,
    tasks: result.value.tasks,
  };
}

function averageConfidence(tasks: Array<{ confidence: number }>): number {
  if (tasks.length === 0) return 0;
  return tasks.reduce((sum, t) => sum + t.confidence, 0) / tasks.length;
}
