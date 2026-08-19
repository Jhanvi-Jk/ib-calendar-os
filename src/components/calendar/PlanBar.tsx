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
  stats,
  taskTitles,
  hasPlan,
}: {
  infeasibility: Infeasibility[];
  stats: { totalScheduledMin?: number; capacityUtilisation?: number; tasksPlaced?: number };
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

        {hasPlan && stats.totalScheduledMin !== undefined && (
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span>{formatDuration(stats.totalScheduledMin)} scheduled</span>
            {stats.capacityUtilisation !== undefined && (
              <Chip
                className={
                  stats.capacityUtilisation > 0.85
                    ? "bg-danger-soft text-danger"
                    : "bg-surface-sunken"
                }
                title="Share of your free time across the whole planning horizon, not just this week"
              >
                {/*
                  Utilisation is measured over the full horizon (~3 weeks), so a
                  single hour is genuinely a fraction of a percent. Rounding that
                  to "0%" read as broken, so anything non-zero floors at "<1%".
                */}
                {formatUtilisation(stats.capacityUtilisation)} of free time
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

/** Never renders a non-zero utilisation as "0%". */
function formatUtilisation(ratio: number): string {
  if (ratio <= 0) return "0%";
  if (ratio < 0.01) return "<1%";
  return `${Math.round(ratio * 100)}%`;
}
