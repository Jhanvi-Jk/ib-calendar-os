"use client";

import { useState, useTransition } from "react";
import { generatePlan, undoLastPlan } from "@/app/(app)/calendar/actions";
import { Button, Card, Chip } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import type { Infeasibility } from "@/lib/domain/types";

const REASON_COPY: Record<Infeasibility["reason"], string> = {
  insufficient_capacity: "Not enough free time in the horizon",
  deadline_passed: "The deadline has already passed",
  blocked_by_dependency: "Waiting on a prerequisite that could not be scheduled",
  window_too_narrow: "Too little room between now and the deadline",
};

export function PlanBar({
  infeasibility,
  weekScheduledMin,
  horizonScheduledMin,
  taskTitles,
  hasPlan,
}: {
  infeasibility: Infeasibility[];
  /** Minutes scheduled in the week currently on screen. */
  weekScheduledMin: number;
  /** Minutes scheduled across the whole planning horizon. */
  horizonScheduledMin: number;
  taskTitles: Record<string, string>;
  hasPlan: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function run(action: () => Promise<{ ok: boolean; error?: string; message?: string }>) {
    setError("");
    setMessage("");
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else if (res.message) setMessage(res.message);
    });
  }

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={pending} onClick={() => run(generatePlan)}>
          {pending ? "Planning…" : hasPlan ? "Re-plan" : "Generate plan"}
        </Button>
        {hasPlan && (
          <Button disabled={pending} onClick={() => run(undoLastPlan)}>
            Undo
          </Button>
        )}

        {/*
          Every figure here is derived from the same blocks the grid renders,
          so the header can no longer disagree with the body. When the visible
          week is empty but the plan is not, say so explicitly rather than
          quoting a horizon-wide total that looks like a contradiction.
        */}
        {hasPlan && (
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            {weekScheduledMin > 0 ? (
              <span>{formatDuration(weekScheduledMin)} scheduled this week</span>
            ) : (
              <span>Nothing scheduled this week</span>
            )}
            {horizonScheduledMin > weekScheduledMin && (
              <Chip className="bg-surface-sunken">
                {formatDuration(horizonScheduledMin - weekScheduledMin)} in other weeks
              </Chip>
            )}
          </div>
        )}
      </div>

      {message && <p className="text-sm text-muted">{message}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}

      {/*
        Unplaceable work is a decision to make, not a failure to feel bad
        about. Each item states the shortfall plainly and offers concrete ways
        out, ordered from least to most drastic.
      */}
      {infeasibility.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <p className="font-medium">
            {infeasibility.length === 1
              ? "One thing doesn't fit"
              : `${infeasibility.length} things don't fit`}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            Your sleep and fixed commitments were protected, so this work needs a
            decision rather than a later night.
          </p>

          <ul className="mt-3 space-y-3">
            {infeasibility.map((item) => (
              <li key={item.taskId} className="rounded-app bg-surface p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">
                    {taskTitles[item.taskId] ?? "Untitled task"}
                  </span>
                  <Chip className="bg-warning/15 text-warning">
                    {formatDuration(item.shortfallMin)} short
                  </Chip>
                </div>
                <p className="mt-0.5 text-sm text-muted">{REASON_COPY[item.reason]}</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {item.remedies.map((remedy, i) => (
                    <li
                      key={i}
                      className="rounded-app border border-border px-2 py-1 text-xs text-muted"
                    >
                      {remedy.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

