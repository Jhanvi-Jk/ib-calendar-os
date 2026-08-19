"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { startTimer, stopTimer } from "@/app/(app)/actions";
import { Button, Hint } from "@/components/ui";
import { formatDuration, formatRange } from "@/lib/time";
import type { EpochMinute } from "@/lib/domain/types";

/** Schemes we are willing to hand to an href. Anything else is rendered as text. */
const SAFE_SCHEMES = ["https:", "http:", "obsidian:", "vscode:", "file:", "notion:", "zotero:"];

function safeHref(uri: string | null): string | null {
  if (!uri) return null;
  try {
    // The database CHECK already constrains this, but a second look costs
    // nothing and this value ends up in an href.
    return SAFE_SCHEMES.includes(new URL(uri).protocol) ? uri : null;
  } catch {
    return null;
  }
}

export function FocusSession({
  taskId,
  title,
  notes,
  contextUri,
  contextLabel,
  remainingMin,
  startsAt,
  endsAt,
  timezone,
  isRunning,
  startsInFuture,
}: {
  taskId: string;
  title: string;
  notes: string | null;
  contextUri: string | null;
  contextLabel: string | null;
  remainingMin: number;
  startsAt: EpochMinute;
  endsAt: EpochMinute;
  timezone: string;
  isRunning: boolean;
  startsInFuture: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const href = safeHref(contextUri);
  const blockMinutes = endsAt - startsAt;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center py-10">
      <p className="text-sm text-subtle">
        {/* A running timer outranks the schedule: once you have started, the
            block is in progress regardless of what its start time says. */}
        {isRunning ? "In progress" : startsInFuture ? "Up next" : "Now"} ·{" "}
        {formatRange(startsAt, endsAt, timezone)} ·{" "}
        {formatDuration(blockMinutes)}
      </p>

      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>

      {remainingMin > 0 && (
        <Hint className="mt-2">{formatDuration(remainingMin)} of work left on this.</Hint>
      )}

      {notes && (
        <p className="mt-4 rounded-app bg-surface-sunken p-4 text-sm text-muted">{notes}</p>
      )}

      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex w-fit items-center gap-2 rounded-app border border-border px-3 py-2 text-sm hover:bg-surface-sunken"
        >
          Open {contextLabel || "linked context"} →
        </a>
      )}
      {contextUri && !href && (
        <Hint className="mt-4">
          This task has a linked resource, but its address isn&apos;t one we can
          safely open.
        </Hint>
      )}

      <div className="mt-8 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              if (isRunning) await stopTimer();
              else await startTimer(taskId);
              setElapsed(0);
            })
          }
        >
          {isRunning ? "Stop" : "Start working"}
        </Button>

        {isRunning && (
          <span className="text-2xl font-semibold tabular-nums">
            {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
            {String(elapsed % 60).padStart(2, "0")}
          </span>
        )}

        <Link
          href="/calendar"
          className="ml-auto text-sm text-muted underline underline-offset-4"
        >
          Back to calendar
        </Link>
      </div>
    </div>
  );
}
