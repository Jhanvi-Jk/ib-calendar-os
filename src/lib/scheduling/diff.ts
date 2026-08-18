import type { PlacedBlock } from "@/lib/domain/types";

/**
 * Pure diffing of two solver generations. Lives with the engine rather than
 * the data layer so it can be unit tested without a database.
 */

export interface BlockDiff {
  added: PlacedBlock[];
  removed: PlacedBlock[];
  moved: Array<{ from: PlacedBlock; to: PlacedBlock }>;
  unchanged: number;
}

/**
 * Diff two generations so the user can see what a re-solve would actually do
 * before committing to it. Keyed on (taskId, sequence within task) so a block
 * that shifts in time reads as "moved" rather than as a delete plus an insert.
 */
export function diffBlocks(previous: PlacedBlock[], next: PlacedBlock[]): BlockDiff {
  const byTask = (blocks: PlacedBlock[]) => {
    const map = new Map<string, PlacedBlock[]>();
    for (const b of [...blocks].sort((a, z) => a.startsAt - z.startsAt)) {
      const list = map.get(b.taskId) ?? [];
      list.push(b);
      map.set(b.taskId, list);
    }
    return map;
  };

  const prevByTask = byTask(previous);
  const nextByTask = byTask(next);

  const added: PlacedBlock[] = [];
  const removed: PlacedBlock[] = [];
  const moved: Array<{ from: PlacedBlock; to: PlacedBlock }> = [];
  let unchanged = 0;

  const taskIds = new Set([...prevByTask.keys(), ...nextByTask.keys()]);
  for (const taskId of [...taskIds].sort()) {
    const before = prevByTask.get(taskId) ?? [];
    const after = nextByTask.get(taskId) ?? [];

    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const from = before[i];
      const to = after[i];
      if (from && to) {
        if (from.startsAt === to.startsAt && from.endsAt === to.endsAt) unchanged++;
        else moved.push({ from, to });
      } else if (to) {
        added.push(to);
      } else if (from) {
        removed.push(from);
      }
    }
  }

  return { added, removed, moved, unchanged };
}
