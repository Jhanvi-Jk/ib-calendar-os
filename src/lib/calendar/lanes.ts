/**
 * Side-by-side placement for overlapping calendar items.
 *
 * Without this every item in a day column is drawn at full width, so anything
 * simultaneous is painted on top of whatever came before it and simply
 * disappears. A lesson hidden behind a study block is worse than useless: the
 * student believes the hour is free.
 *
 * The rule is the one every calendar uses. Items that overlap, directly or
 * through a chain of neighbours, form a cluster. Every item in a cluster is
 * drawn at the same width so the columns line up, and each takes the lowest
 * lane that is free at the moment it starts.
 *
 * Pure — no DOM, no clock.
 */

export interface Placeable {
  startMin: number;
  endMin: number;
}

export interface Placed {
  /** Zero-based column within the cluster. */
  lane: number;
  /** How many columns the cluster needs. Width is 1/lanes of the day. */
  lanes: number;
}

export function assignLanes<T extends Placeable>(items: T[]): Array<T & Placed> {
  // Longest-first on a tie so a lesson that spans several short blocks takes
  // the left lane and reads as the container it is.
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin,
  );

  const out: Array<T & Placed> = [];
  let cluster: Array<T & Placed> = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const lanes = laneEnds.length || 1;
    for (const item of cluster) out.push({ ...item, lanes });
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const item of sorted) {
    // A zero-length item would otherwise never overlap anything and could sit
    // under a real one; give it a sliver so it still claims a lane.
    const end = Math.max(item.endMin, item.startMin + 1);

    if (item.startMin >= clusterEnd) flush();

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= item.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }

    cluster.push({ ...item, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return out;
}
