"use client";

import { useEffect, useState } from "react";
import { stopTimer } from "@/app/(app)/actions";
import { Button } from "@/components/ui";

/**
 * Always-visible indicator for a running timer.
 *
 * A timer left running quietly accumulates hours and then shows up as
 * study time that never happened, which corrupts momentum, the heatmap and
 * estimate calibration all at once. Making it impossible to miss is the fix;
 * the long-running warning below covers the case where it was already missed.
 */
export function RunningTimerBar({
  title,
  startedAt,
}: {
  title: string;
  startedAt: string;
}) {
  const [elapsedMin, setElapsedMin] = useState(() => minutesSince(startedAt));
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setElapsedMin(minutesSince(startedAt)), 15_000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Beyond a normal study block, the likeliest explanation is that it was left
  // running rather than that someone worked four unbroken hours.
  const suspiciouslyLong = elapsedMin >= 240;

  return (
    <div
      className={
        suspiciouslyLong
          ? "border-b border-warning/40 bg-warning/10"
          : "border-b border-border bg-primary-soft"
      }
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-2 text-sm">
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span className="font-medium">Timer running</span>
        <span className="truncate text-muted">{title}</span>
        <span className="tabular-nums text-muted">{formatElapsed(elapsedMin)}</span>

        {suspiciouslyLong && (
          <span className="text-warning">
            Running a long time — stop it if you have finished.
          </span>
        )}

        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={stopping}
          onClick={async () => {
            setStopping(true);
            await stopTimer();
            setStopping(false);
          }}
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      </div>
    </div>
  );
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}

function formatElapsed(min: number): string {
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
