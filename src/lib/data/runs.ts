import { createClient } from "@/lib/supabase/server";
import { fromEpochMinute } from "@/lib/time";
import { hashSnapshot } from "@/lib/scheduling/hash";
import type { Json } from "@/lib/types/database";
import type { SolveResult, SolverSnapshot } from "@/lib/domain/types";

/**
 * Persistence for solver output.
 *
 * A run is written as a new immutable generation and only then activated, so a
 * failed write can never leave the user with a half-applied schedule. Undo is
 * just re-activating the previous generation.
 */

export interface PersistOptions {
  /** Leave false to stage a what-if branch the user can preview first. */
  activate?: boolean;
  parentRunId?: string | null;
  label?: string;
  strategy?: string;
}

export async function persistRun(
  snapshot: SolverSnapshot,
  result: SolveResult,
  options: PersistOptions = {},
): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const supabase = await createClient();

  const { data: run, error: runError } = await supabase
    .from("schedule_runs")
    .insert({
      user_id: snapshot.userId,
      parent_run_id: options.parentRunId ?? null,
      horizon_start: fromEpochMinute(snapshot.horizonStart).toISOString(),
      horizon_end: fromEpochMinute(snapshot.horizonEnd).toISOString(),
      input_hash: hashSnapshot(snapshot),
      strategy: options.strategy ?? "default",
      seed: snapshot.seed,
      status: "draft",
      is_active: false,
      infeasibility: result.infeasibility as unknown as Json,
      stats: result.stats as unknown as Json,
      label: options.label ?? null,
    })
    .select("id")
    .single();

  if (runError || !run) {
    return { ok: false, error: runError?.message ?? "Could not create schedule run" };
  }

  if (result.blocks.length > 0) {
    const { error: blockError } = await supabase.from("scheduled_blocks").insert(
      result.blocks.map((b) => ({
        user_id: snapshot.userId,
        run_id: run.id,
        task_id: b.taskId,
        starts_at: fromEpochMinute(b.startsAt).toISOString(),
        ends_at: fromEpochMinute(b.endsAt).toISOString(),
        sequence_index: b.sequenceIndex,
        is_locked: b.isLocked,
        energy_score: b.energyScore,
      })),
    );

    if (blockError) {
      // Roll the empty shell back rather than leaving a draft that claims to
      // hold a plan it does not.
      await supabase.from("schedule_runs").delete().eq("id", run.id);
      return { ok: false, error: blockError.message };
    }
  }

  if (options.activate) {
    const { error } = await supabase.rpc("activate_schedule_run", { p_run_id: run.id });
    if (error) return { ok: false, error: error.message };
  }

  return { ok: true, runId: run.id };
}

/**
 * Short-circuit: if the active run was solved from an identical snapshot there
 * is nothing to recompute. This is what stops the plan reshuffling every time
 * a page revalidates.
 */
export async function findRunByInputHash(hash: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("schedule_runs")
    .select("id")
    .eq("input_hash", hash)
    .eq("is_active", true)
    .maybeSingle();
  return data?.id ?? null;
}

export { diffBlocks, type BlockDiff } from "@/lib/scheduling/diff";
