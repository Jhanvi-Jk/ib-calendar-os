import type {
  DependencyEdge,
  EpochMinute,
  Minutes,
  SchedulableTask,
} from "@/lib/domain/types";

/**
 * Dependency graph resolution.
 *
 * Three outputs, all consumed by the placement pass:
 *   order              topological order, priority-broken
 *   effectiveDeadline  deadlines pulled backward from dependents
 *   criticalPathMin    longest remaining chain through each task
 *
 * The database rejects cycles at write time, so reaching a cycle here means
 * something bypassed that trigger. We surface it loudly rather than looping.
 */

export class DependencyCycleError extends Error {
  constructor(readonly taskIds: string[]) {
    super(`Dependency cycle among tasks: ${taskIds.join(" -> ")}`);
    this.name = "DependencyCycleError";
  }
}

export interface DagResult {
  order: string[];
  effectiveDeadline: Map<string, EpochMinute | null>;
  criticalPathMin: Map<string, Minutes>;
  predecessors: Map<string, DependencyEdge[]>;
  successors: Map<string, DependencyEdge[]>;
}

export function buildDag(
  tasks: SchedulableTask[],
  edges: DependencyEdge[],
): DagResult {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Edges pointing at tasks outside the snapshot (already done, or dropped)
  // carry no constraint and must be discarded, not treated as missing nodes.
  const live = edges.filter((e) => byId.has(e.predecessorId) && byId.has(e.successorId));

  const predecessors = new Map<string, DependencyEdge[]>();
  const successors = new Map<string, DependencyEdge[]>();
  for (const t of tasks) {
    predecessors.set(t.id, []);
    successors.set(t.id, []);
  }
  for (const e of live) {
    predecessors.get(e.successorId)!.push(e);
    successors.get(e.predecessorId)!.push(e);
  }

  // --- Kahn's algorithm. Ties broken by id so the order is reproducible. ---
  const indegree = new Map<string, number>();
  for (const t of tasks) indegree.set(t.id, predecessors.get(t.id)!.length);

  const ready = tasks
    .filter((t) => indegree.get(t.id) === 0)
    .map((t) => t.id)
    .sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of successors.get(id)!) {
      const next = indegree.get(e.successorId)! - 1;
      indegree.set(e.successorId, next);
      if (next === 0) {
        // Insert in sorted position rather than push+sort: keeps the whole
        // traversal deterministic regardless of edge insertion order.
        const at = ready.findIndex((r) => r > e.successorId);
        if (at === -1) ready.push(e.successorId);
        else ready.splice(at, 0, e.successorId);
      }
    }
  }

  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => !order.includes(t.id)).map((t) => t.id);
    throw new DependencyCycleError(stuck);
  }

  // --- Critical path: longest remaining-minute chain from each node. ---
  const criticalPathMin = new Map<string, Minutes>();
  for (const id of [...order].reverse()) {
    const task = byId.get(id)!;
    let longestTail = 0;
    for (const e of successors.get(id)!) {
      longestTail = Math.max(longestTail, criticalPathMin.get(e.successorId) ?? 0);
    }
    criticalPathMin.set(id, task.remainingMin + longestTail);
  }

  // --- Effective deadlines, propagated backward. ---
  // A task that feeds a dependent inherits a deadline early enough for that
  // dependent to still finish. Without this the solver happily schedules an
  // outline the same afternoon as the essay that depends on it.
  const effectiveDeadline = new Map<string, EpochMinute | null>();
  for (const id of [...order].reverse()) {
    const task = byId.get(id)!;
    let deadline = task.deadlineAt;

    for (const e of successors.get(id)!) {
      const successor = byId.get(e.successorId)!;
      const successorDeadline = effectiveDeadline.get(e.successorId) ?? null;
      if (successorDeadline === null) continue;

      // FS: predecessor finishes before successor starts.
      // SS: both may run in parallel, so only the start needs to precede.
      // FF: predecessor need only finish by the successor's finish.
      const limit =
        e.depType === "FS"
          ? successorDeadline - successor.remainingMin - e.lagMin
          : e.depType === "SS"
            ? successorDeadline - successor.remainingMin - e.lagMin
            : successorDeadline - e.lagMin;

      deadline = deadline === null ? limit : Math.min(deadline, limit);
    }

    effectiveDeadline.set(id, deadline);
  }

  return { order, effectiveDeadline, criticalPathMin, predecessors, successors };
}

/**
 * Earliest a task may start given where its predecessors actually landed.
 *
 * Returns null when the dependent cannot legitimately be scheduled at all.
 * Crucially that includes a predecessor that was only PARTIALLY placed: a
 * finish-to-start dependency means the prerequisite must actually finish, and
 * scheduling an essay after a half-written outline is precisely the failure
 * the graph exists to prevent. The caller reports this as blocked rather than
 * as a capacity shortfall, because the remedies are different.
 */
export function earliestStartFromPredecessors(
  taskId: string,
  dag: DagResult,
  placedEnd: Map<string, EpochMinute>,
  placedStart: Map<string, EpochMinute>,
  fullyPlaced: Set<string>,
): EpochMinute | null {
  let earliest = -Infinity;
  for (const e of dag.predecessors.get(taskId) ?? []) {
    if (e.depType === "SS") {
      // Start-to-start only needs the predecessor under way, so a partial
      // placement is genuinely enough here.
      const start = placedStart.get(e.predecessorId);
      if (start === undefined) return null;
      earliest = Math.max(earliest, start + e.lagMin);
    } else {
      if (!fullyPlaced.has(e.predecessorId)) return null;
      const end = placedEnd.get(e.predecessorId);
      if (end === undefined) return null;
      earliest = Math.max(earliest, end + e.lagMin);
    }
  }
  return earliest === -Infinity ? 0 : earliest;
}
