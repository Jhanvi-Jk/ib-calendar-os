/**
 * A ticking clock, as an external store.
 *
 * Reading Date.now() during render is an eslint error in this project — the
 * "today" highlight and overdue badges would drift on unrelated re-renders.
 * But the now-line has to move on its own, or it is worse than no line at all:
 * a marker that only advances when you happen to navigate quietly lies about
 * where you are in the day.
 *
 * useSyncExternalStore is the way out. The snapshot is a whole minute number,
 * so it is reference-stable between ticks and React re-renders exactly once a
 * minute rather than on every frame. One interval is shared by every
 * subscriber and stops when the last one unmounts.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Half a minute, so the line is never more than ~30s stale. */
const TICK_MS = 30_000;

export function subscribeMinute(onTick: () => void): () => void {
  listeners.add(onTick);
  if (timer === null) {
    timer = setInterval(() => {
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onTick);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Epoch MINUTES. A number, so equal minutes are referentially equal. */
export function minuteSnapshot(): number {
  return Math.floor(Date.now() / 60_000);
}
