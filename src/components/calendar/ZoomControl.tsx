"use client";

import { useSyncExternalStore } from "react";
import {
  ZOOM_LEVELS,
  setZoomIndex,
  subscribeZoom,
  zoomServerSnapshot,
  zoomSnapshot,
} from "@/lib/calendar/zoom";

/**
 * Zoom for the week grid.
 *
 * Two buttons rather than a slider: the levels are discrete, and a slider on a
 * five-step range is a worse target than a plus and a minus. Both stay in the
 * DOM at the ends of the range and disable, so the control does not resize
 * under the cursor as you use it.
 */
export function ZoomControl() {
  const index = useSyncExternalStore(subscribeZoom, zoomSnapshot, zoomServerSnapshot);

  const step = (delta: number) => setZoomIndex(index + delta);

  return (
    <div
      className="flex items-center rounded-app border border-border"
      role="group"
      aria-label="Calendar zoom"
    >
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={index === 0}
        aria-label="Zoom out"
        className="flex h-8 w-8 items-center justify-center rounded-l-app text-muted hover:bg-surface-sunken disabled:opacity-40"
      >
        −
      </button>
      <span className="px-1 text-xs tabular-nums text-subtle" aria-hidden>
        {index + 1}/{ZOOM_LEVELS.length}
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={index === ZOOM_LEVELS.length - 1}
        aria-label="Zoom in"
        className="flex h-8 w-8 items-center justify-center rounded-r-app text-muted hover:bg-surface-sunken disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
