/**
 * Calendar zoom.
 *
 * Zoom is not decoration: the height of an hour decides what you can read. At
 * 3.5rem a 25-minute block is a sliver with a truncated title, and two things
 * an hour apart look adjacent. Zooming in buys precision — so the gridlines
 * get finer as it grows, from hours to half-hours to quarters. Showing
 * 15-minute rules at every zoom would just be noise.
 *
 * Stored per browser, like reminders: it is a property of the screen you are
 * looking at, not of the account.
 */

export const ZOOM_STORAGE = "ibcal.zoom";

/** Rem per hour. */
export const ZOOM_LEVELS = [2.25, 3.5, 5, 7.5, 11] as const;
export const DEFAULT_ZOOM_INDEX = 1;

/** How fine the gridlines get, in minutes, for a given hour height. */
export function gridStepMin(hourRem: number): number {
  if (hourRem >= 7.5) return 15;
  if (hourRem >= 5) return 30;
  return 60;
}

export function clampZoomIndex(i: number): number {
  if (!Number.isFinite(i)) return DEFAULT_ZOOM_INDEX;
  return Math.min(ZOOM_LEVELS.length - 1, Math.max(0, Math.round(i)));
}

// --- store -----------------------------------------------------------------

const listeners = new Set<() => void>();

export function subscribeZoom(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

let cachedRaw: string | null | undefined;
let cachedIndex = DEFAULT_ZOOM_INDEX;

/** Must be reference-stable while storage is unchanged, or React loops. */
export function zoomSnapshot(): number {
  const raw = window.localStorage.getItem(ZOOM_STORAGE);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedIndex = clampZoomIndex(Number(raw));
  }
  return cachedIndex;
}

export function zoomServerSnapshot(): number {
  return DEFAULT_ZOOM_INDEX;
}

export function setZoomIndex(i: number): void {
  window.localStorage.setItem(ZOOM_STORAGE, String(clampZoomIndex(i)));
  for (const l of listeners) l();
}
