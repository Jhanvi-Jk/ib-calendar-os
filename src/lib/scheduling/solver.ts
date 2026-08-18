import type {
  EpochMinute,
  Infeasibility,
  Minutes,
  PlacedBlock,
  SchedulableTask,
  SolveResult,
  SolverSnapshot,
} from "@/lib/domain/types";
import { localDateKey } from "@/lib/time";
import {
  averageEnergy,
  buildDayBudgets,
  buildFreeIntervals,
  type DayBudget,
} from "./capacity";
import { buildDag, earliestStartFromPredecessors, type DagResult } from "./dag";
import { type Interval, intersect, length, subtract, totalMinutes } from "./intervals";
import { compareByPriority, computeWeight } from "./priority";

/**
 * The scheduling engine.
 *
 * PURE. No I/O, no Date.now(), no Math.random, integer minutes only. Given the
 * same snapshot and seed it returns byte-identical output on any machine —
 * which is what makes it testable, cacheable by input_hash, and safe to re-run.
 *
 * Strategy: priority-ordered list scheduling over a topological order.
 * Dependencies force the order; the priority weight chooses among whatever is
 * ready. Each task is then placed into the best-scoring free slots inside its
 * feasible window.
 */

/** Placement granularity. Keeps candidate positions on a human-legible grid. */
const GRID_MIN = 15;

const SCORE = {
  energy: 1000,
  delay: 260,
  contextSwitch: 120,
  fragmentation: 90,
} as const;

interface Candidate {
  start: EpochMinute;
  end: EpochMinute;
  score: number;
  energy: number;
}

export function solve(snapshot: SolverSnapshot): SolveResult {
  const tasks = snapshot.tasks.filter(
    (t) => t.remainingMin > 0 && t.status !== "done" && t.status !== "dropped",
  );
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const subjectById = new Map(snapshot.subjects.map((s) => [s.id, s]));

  const dag: DagResult = buildDag(tasks, snapshot.dependencies);

  let free = buildFreeIntervals(snapshot);
  const budgets = buildDayBudgets(snapshot, free);
  const totalCapacity = totalMinutes(free);

  const previousStart = new Map<string, EpochMinute>();
  for (const b of snapshot.lockedBlocks) previousStart.set(b.taskId, b.startsAt);

  // Locked blocks are carried through untouched and count as already placed.
  const blocks: PlacedBlock[] = snapshot.lockedBlocks
    .filter((b) => b.isLocked)
    .map((b) => ({ ...b }));

  const placedMin = new Map<string, Minutes>();
  const placedStart = new Map<string, EpochMinute>();
  const placedEnd = new Map<string, EpochMinute>();
  /** Tasks whose whole remaining duration found a home. */
  const fullyPlaced = new Set<string>();
  for (const b of blocks) {
    placedMin.set(b.taskId, (placedMin.get(b.taskId) ?? 0) + (b.endsAt - b.startsAt));
    placedStart.set(b.taskId, Math.min(placedStart.get(b.taskId) ?? b.startsAt, b.startsAt));
    placedEnd.set(b.taskId, Math.max(placedEnd.get(b.taskId) ?? b.endsAt, b.endsAt));
  }

  const maxCriticalPathMin = Math.max(1, ...dag.criticalPathMin.values());
  const infeasibility: Infeasibility[] = [];

  // --- weights -------------------------------------------------------------
  const weighted = tasks.map((task) => {
    const effectiveDeadline = dag.effectiveDeadline.get(task.id) ?? null;
    const capacityBeforeDeadline =
      effectiveDeadline === null
        ? totalCapacity
        : totalMinutes(
            subtract(free, [{ start: effectiveDeadline, end: snapshot.horizonEnd + 1 }]),
          );

    const w = computeWeight({
      task,
      effectiveDeadline,
      criticalPathMin: dag.criticalPathMin.get(task.id) ?? task.remainingMin,
      maxCriticalPathMin,
      capacityBeforeDeadline,
      chainRemainingMin: dag.criticalPathMin.get(task.id) ?? task.remainingMin,
      subject: task.subjectId ? subjectById.get(task.subjectId) : undefined,
      horizonStart: snapshot.horizonStart,
      horizonEnd: snapshot.horizonEnd,
      previousStart: previousStart.get(task.id) ?? null,
    });

    return { task, weight: w.weight, effectiveDeadline, atRisk: w.atRisk };
  });
  const weightById = new Map(weighted.map((w) => [w.task.id, w]));

  // --- list scheduling -----------------------------------------------------
  const remainingDeps = new Map<string, number>();
  for (const t of tasks) remainingDeps.set(t.id, dag.predecessors.get(t.id)!.length);

  const ready = weighted.filter((w) => remainingDeps.get(w.task.id) === 0);
  let guard = 0;

  while (ready.length > 0 && guard++ < 10_000) {
    ready.sort(compareByPriority);
    const current = ready.shift()!;
    const task = current.task;

    const already = placedMin.get(task.id) ?? 0;
    const need = Math.max(0, task.remainingMin - already);

    const depStart = earliestStartFromPredecessors(
      task.id,
      dag,
      placedEnd,
      placedStart,
      fullyPlaced,
    );
    if (depStart === null) {
      // A predecessor could not be placed, so this cannot be either. Reporting
      // it as "blocked" rather than "no capacity" is the difference between a
      // useful message and a confusing one.
      infeasibility.push({
        taskId: task.id,
        shortfallMin: need,
        reason: "blocked_by_dependency",
        remedies: [
          {
            kind: "split_task",
            detail: "A prerequisite could not be scheduled. Resolve that first.",
            recoveredMin: 0,
          },
        ],
      });
      releaseSuccessors(task.id);
      continue;
    }

    if (need > 0) {
      const windowStart = Math.max(
        snapshot.horizonStart,
        task.earliestStartAt ?? snapshot.horizonStart,
        depStart,
      );
      const windowEnd = Math.min(
        snapshot.horizonEnd,
        current.effectiveDeadline ?? snapshot.horizonEnd,
      );

      const result = placeTask({
        task,
        need,
        window: { start: windowStart, end: windowEnd },
        free,
        budgets,
        snapshot,
        blocks,
        subjectOf: (id) => byId.get(id)?.subjectId ?? null,
      });

      free = result.free;
      for (const b of result.blocks) {
        blocks.push(b);
        placedMin.set(task.id, (placedMin.get(task.id) ?? 0) + (b.endsAt - b.startsAt));
        placedStart.set(
          task.id,
          Math.min(placedStart.get(task.id) ?? b.startsAt, b.startsAt),
        );
        placedEnd.set(task.id, Math.max(placedEnd.get(task.id) ?? b.endsAt, b.endsAt));
      }

      if (result.shortfallMin > 0) {
        infeasibility.push(
          describeShortfall(task, result.shortfallMin, current.effectiveDeadline, snapshot),
        );
      } else {
        fullyPlaced.add(task.id);
      }
    } else {
      fullyPlaced.add(task.id);
    }

    releaseSuccessors(task.id);
  }

  function releaseSuccessors(taskId: string) {
    for (const edge of dag.successors.get(taskId) ?? []) {
      const left = (remainingDeps.get(edge.successorId) ?? 1) - 1;
      remainingDeps.set(edge.successorId, left);
      if (left === 0) {
        const next = weightById.get(edge.successorId);
        if (next) ready.push(next);
      }
    }
  }

  blocks.sort((a, b) => a.startsAt - b.startsAt || (a.taskId < b.taskId ? -1 : 1));
  blocks.forEach((b, i) => {
    b.sequenceIndex = i;
  });

  const scheduledMin = blocks.reduce((sum, b) => sum + (b.endsAt - b.startsAt), 0);
  const partial = tasks.filter((t) => {
    const p = placedMin.get(t.id) ?? 0;
    return p > 0 && p < t.remainingMin;
  }).length;

  const churned = blocks.filter((b) => {
    const prev = previousStart.get(b.taskId);
    return prev !== undefined && prev !== b.startsAt;
  }).length;

  return {
    blocks,
    infeasibility,
    stats: {
      tasksPlaced: fullyPlaced.size,
      tasksPartial: partial,
      totalScheduledMin: scheduledMin,
      capacityUtilisation:
        totalCapacity === 0 ? 0 : Math.round((scheduledMin / totalCapacity) * 1000) / 1000,
      churnedBlocks: churned,
    },
  };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface PlaceArgs {
  task: SchedulableTask;
  need: Minutes;
  window: Interval;
  free: Interval[];
  budgets: Map<string, DayBudget>;
  snapshot: SolverSnapshot;
  blocks: PlacedBlock[];
  subjectOf: (taskId: string) => string | null;
}

function placeTask(args: PlaceArgs): {
  blocks: PlacedBlock[];
  free: Interval[];
  shortfallMin: Minutes;
} {
  const { task, window, budgets, snapshot, subjectOf } = args;
  let free = args.free;
  let remaining = args.need;
  const out: PlacedBlock[] = [];

  if (window.end <= window.start) {
    return { blocks: out, free, shortfallMin: remaining };
  }

  // Where each already-placed block ends, so context switches can be scored.
  const endingSubject = new Map<EpochMinute, string | null>();
  for (const b of args.blocks) endingSubject.set(b.endsAt, subjectOf(b.taskId));

  let guard = 0;
  while (remaining > 0 && guard++ < 500) {
    const candidates = collectCandidates({
      task,
      remaining,
      window,
      free,
      budgets,
      snapshot,
      endingSubject,
    });
    if (candidates.length === 0) break;

    // Deterministic pick: best score, then earliest, then shortest.
    candidates.sort(
      (a, b) => b.score - a.score || a.start - b.start || a.end - b.end,
    );
    const chosen = candidates[0];

    out.push({
      taskId: task.id,
      startsAt: chosen.start,
      endsAt: chosen.end,
      sequenceIndex: 0,
      isLocked: false,
      energyScore: Math.round(chosen.energy * 100) / 100,
    });

    const used = chosen.end - chosen.start;
    remaining -= used;
    free = subtract(free, [{ start: chosen.start, end: chosen.end }]);

    const budget = budgets.get(localDateKey(chosen.start, snapshot.timezone));
    if (budget) budget.usedMin += used;
    endingSubject.set(chosen.end, task.subjectId);
  }

  return { blocks: out, free, shortfallMin: Math.max(0, remaining) };
}

function collectCandidates(args: {
  task: SchedulableTask;
  remaining: Minutes;
  window: Interval;
  free: Interval[];
  budgets: Map<string, DayBudget>;
  snapshot: SolverSnapshot;
  endingSubject: Map<EpochMinute, string | null>;
}): Candidate[] {
  const { task, remaining, window, free, budgets, snapshot, endingSubject } = args;
  const { settings, timezone, energy } = snapshot;

  const minChunk = Math.max(settings.minBlockMin, task.minChunkMin);
  const maxChunk = Math.min(settings.maxBlockMin, task.maxChunkMin);
  const horizonSpan = Math.max(1, snapshot.horizonEnd - snapshot.horizonStart);

  const candidates: Candidate[] = [];

  for (const slot of free) {
    const usable = intersect(slot, window);
    if (!usable) continue;

    const dateKey = localDateKey(usable.start, timezone);
    const budget = budgets.get(dateKey);
    if (!budget) continue;
    const dayRoom = Math.min(budget.availableMin, budget.capMin) - budget.usedMin;
    if (dayRoom <= 0) continue;

    // A task the user marked unsplittable needs one contiguous run; there is
    // no point offering it a shorter window.
    const wanted = task.splittable
      ? Math.min(remaining, maxChunk, dayRoom)
      : remaining;

    if (length(usable) < wanted) continue;

    // Allow a final stub shorter than minChunk — refusing it would strand the
    // last 10 minutes of a task forever.
    const isFinalStub = remaining <= minChunk;
    if (!isFinalStub && wanted < minChunk) continue;

    // Try grid-aligned starts inside this slot rather than only its left edge,
    // so a morning-peak hour is reachable even when the slot opens at 06:00.
    const firstStart = usable.start;
    const lastStart = usable.end - wanted;
    for (
      let start = firstStart, steps = 0;
      start <= lastStart && steps < 64;
      steps++
    ) {
      const chunk: Interval = { start, end: start + wanted };
      const avgEnergy = averageEnergy(chunk, energy, timezone);

      // High-load work benefits most from peak hours; admin work barely cares.
      const energyFit = 1 + (avgEnergy - 1) * (task.cognitiveLoad / 5);

      const delayRatio = (start - window.start) / horizonSpan;

      const previousSubject = endingSubject.get(start);
      const switching =
        previousSubject !== undefined && previousSubject !== task.subjectId ? 1 : 0;

      // Leaving an unusable sliver behind is worse than a clean fit.
      const leftover = length(usable) - wanted;
      const fragmentation = leftover > 0 && leftover < minChunk ? 1 : 0;

      const score = Math.round(
        SCORE.energy * energyFit -
          SCORE.delay * delayRatio -
          SCORE.contextSwitch * switching -
          SCORE.fragmentation * fragmentation,
      );

      candidates.push({ start: chunk.start, end: chunk.end, score, energy: avgEnergy });

      const next = start + GRID_MIN;
      start = next > lastStart && start < lastStart ? lastStart : next;
    }
  }

  return candidates;
}

function describeShortfall(
  task: SchedulableTask,
  shortfallMin: Minutes,
  effectiveDeadline: EpochMinute | null,
  snapshot: SolverSnapshot,
): Infeasibility {
  const deadlinePassed =
    effectiveDeadline !== null && effectiveDeadline <= snapshot.horizonStart;

  return {
    taskId: task.id,
    shortfallMin,
    reason: deadlinePassed
      ? "deadline_passed"
      : effectiveDeadline !== null && effectiveDeadline < snapshot.horizonEnd
        ? "window_too_narrow"
        : "insufficient_capacity",
    // Ordered most-to-least reversible. The UI renders these as buttons, so
    // the first option is what a stressed student will click.
    remedies: [
      {
        kind: "demote_elastic",
        detail: "Free time by compressing review and habit blocks.",
        recoveredMin: Math.min(shortfallMin, 120),
      },
      {
        kind: "reduce_scope",
        detail: `Cut ${shortfallMin} minutes of scope from "${task.title}".`,
        recoveredMin: shortfallMin,
      },
      {
        kind: "extend_horizon",
        detail: "Plan further ahead to find room.",
        recoveredMin: 0,
      },
      {
        kind: "move_deadline",
        detail: "Negotiate the deadline, if it is not an external IB one.",
        recoveredMin: shortfallMin,
      },
    ],
  };
}
