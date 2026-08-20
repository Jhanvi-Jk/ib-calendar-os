"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { loadSnapshot } from "@/lib/data/snapshot";
import { findRunByInputHash, persistRun } from "@/lib/data/runs";
import { solve } from "@/lib/scheduling/solver";
import { DependencyCycleError } from "@/lib/scheduling/dag";
import { hashSnapshot } from "@/lib/scheduling/hash";
import { isSafeToAutoReplan } from "@/lib/data/planning";
import type { EpochMinute } from "@/lib/domain/types";

type ActionResult =
  | { ok: true; runId: string; unchanged?: boolean; message?: string }
  | { ok: false; error: string };

/**
 * Generate and activate a plan.
 *
 * The whole scheduling decision happens in the pure solver; this action only
 * moves data in and out of it.
 */
export async function generatePlan(): Promise<ActionResult> {
  const snapshot = await loadSnapshot();
  if (!snapshot) return { ok: false, error: "Finish onboarding first." };

  // Nothing changed since the active plan was built, so leave it alone. Users
  // trust a planner that stops moving things without a reason.
  const existing = await findRunByInputHash(hashSnapshot(snapshot));
  if (existing) {
    return { ok: true, runId: existing, unchanged: true, message: "Your plan is already up to date." };
  }

  try {
    const result = solve(snapshot);
    const saved = await persistRun(snapshot, result, { activate: true });
    if (!saved.ok) return saved;

    revalidatePath("/calendar");
    return { ok: true, runId: saved.runId };
  } catch (error) {
    if (error instanceof DependencyCycleError) {
      return {
        ok: false,
        error: `Circular dependency between tasks: ${error.taskIds.join(", ")}`,
      };
    }
    throw error;
  }
}

/**
 * Re-plan a single day, leaving the rest of the week untouched.
 * Same mechanism as a full solve, only with a narrower horizon.
 */
export async function resetDay(dayEpochMinute: EpochMinute): Promise<ActionResult> {
  const snapshot = await loadSnapshot({ scopeToDay: dayEpochMinute });
  if (!snapshot) return { ok: false, error: "Finish onboarding first." };

  const result = solve(snapshot);
  const saved = await persistRun(snapshot, result, {
    activate: true,
    strategy: "reset_day",
    label: "Reset day",
  });
  if (!saved.ok) return saved;

  revalidatePath("/calendar");
  return { ok: true, runId: saved.runId };
}

/**
 * Stage a what-if branch without touching the active plan. The user sees the
 * consequences first and decides whether to adopt them.
 */
export async function createWhatIfBranch(label: string): Promise<ActionResult> {
  const snapshot = await loadSnapshot();
  if (!snapshot) return { ok: false, error: "Finish onboarding first." };

  const supabase = await createClient();
  const { data: active } = await supabase
    .from("schedule_runs")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  const result = solve(snapshot);
  const saved = await persistRun(snapshot, result, {
    activate: false,
    parentRunId: active?.id ?? null,
    label,
    strategy: "what_if",
  });
  if (!saved.ok) return saved;

  revalidatePath("/calendar");
  return { ok: true, runId: saved.runId };
}

export async function adoptRun(runId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("activate_schedule_run", { p_run_id: runId });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/calendar");
  return { ok: true, runId };
}

/**
 * Undo: re-activate the generation that preceded the current one. Nothing was
 * deleted when it was superseded, so this is always available.
 */
export async function undoLastPlan(): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: runs } = await supabase
    .from("schedule_runs")
    .select("id, is_active, status")
    .in("status", ["active", "superseded"])
    .order("created_at", { ascending: false })
    .limit(5);

  const previous = (runs ?? []).find((r) => !r.is_active);
  if (!previous) return { ok: false, error: "No earlier plan to go back to." };

  const { error } = await supabase.rpc("activate_schedule_run", { p_run_id: previous.id });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/calendar");
  return { ok: true, runId: previous.id };
}

/**
 * Pinning a block. Locked blocks are treated as walls by every later solve,
 * exactly like a Tier 1 event.
 */
export async function toggleBlockLock(blockId: string, locked: boolean) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("scheduled_blocks")
    .update({ is_locked: locked })
    .eq("id", blockId);
  if (error) return { ok: false as const, error: error.message };

  revalidatePath("/calendar");
  return { ok: true as const };
}

/**
 * Rebuild the plan after a change, but only when nobody is mid-session.
 *
 * Called from the task mutations. Deliberately silent about failure: this is a
 * convenience on top of an explicit Re-plan button, and a task edit must not
 * fail because a solve did. When it declines, PlanBar's stale banner is what
 * tells the student the plan needs rebuilding.
 */
export async function autoReplanIfSafe(): Promise<void> {
  try {
    if (!(await isSafeToAutoReplan())) return;
    await generatePlan();
  } catch {
    // Swallowed on purpose — see above.
  }
}
