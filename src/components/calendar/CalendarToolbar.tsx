"use client";

import { useState, useTransition } from "react";
import { generatePlan, undoLastPlan } from "@/app/(app)/calendar/actions";
import { WeekNav } from "@/components/calendar/WeekNav";
import { WriteOffDay } from "@/components/calendar/WriteOffDay";
import { Button, Chip } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { Countdown } from "@/lib/analytics/countdown";
import type { Infeasibility } from "@/lib/domain/types";
import type { RunwayReport } from "@/lib/analytics/runway";

/**
 * One toolbar instead of four stacked banners.
 *
 * Previously the week header, the countdown strip, the plan controls and the
 * stale-plan notice were separate full-width rows, so the grid began 306px
 * down an empty page — and *further* down the more was going on, because
 * warnings pushed it lower. That is backwards: the busier the week, the more
 * of it you need to see at once.
 *
 * Everything routine now lives on one line. Anything that needs explaining
 * collapses to a single summary row and opens on demand, so the cost of a
 * warning is one line, not a card.
 */
export function CalendarToolbar({
  weekLabel,
  offset,
  primary,
  upcoming,
  hasPlan,
  isStale,
  weekScheduledMin,
  elsewhereMin,
  runway,
  infeasibility,
  taskTitles,
  timezone,
  todayKey,
  todayIsWrittenOff,
}: {
  weekLabel: string;
  offset: number;
  primary: Countdown | null;
  upcoming: Countdown[];
  hasPlan: boolean;
  isStale: boolean;
  weekScheduledMin: number;
  elsewhereMin: number;
  runway: RunwayReport;
  infeasibility: Infeasibility[];
  taskTitles: Record<string, string>;
  /**
   * A timezone string, NOT a formatter function. Server Components cannot
   * pass functions across the client boundary — it type-checks and builds
   * fine, then throws at runtime. The formatting happens here instead.
   */
  timezone: string;
  todayKey: string;
  todayIsWrittenOff: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [openPanel, setOpenPanel] = useState<"none" | "runway" | "blocked">("none");
  const [error, setError] = useState("");

  const dateFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const formatDate = (key: string) => dateFmt.format(new Date(`${key}T12:00:00Z`));

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError("");
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
    });
  }

  const runwayAlert = runway.hasData && runway.worst && runway.worst.status !== "comfortable";
  const toggle = (p: "runway" | "blocked") =>
    setOpenPanel((cur) => (cur === p ? "none" : p));

  return (
    <div className="mb-3">
      {/* ---- single control row ------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-base font-semibold tracking-tight">{weekLabel}</h1>
        <WeekNav offset={offset} />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Countdown reduced to a chip. It is orientation, not a headline —
              it does not need its own band across the page every day. */}
          {primary && (
            <Chip
              className="bg-tier-1-soft text-tier-1"
              title={`${primary.label} — ${primary.phrase}`}
            >
              {primary.isActive && primary.daysUntilEnd !== null
                ? `${primary.daysUntilEnd}d left`
                : `${Math.max(0, primary.daysUntilStart)}d to ${primary.label}`}
            </Chip>
          )}
          {upcoming.slice(0, 2).map((c) => (
            <Chip key={c.id} className="bg-surface-sunken text-muted" title={c.phrase}>
              {c.label} · {c.daysUntilStart}d
            </Chip>
          ))}

          <span className="text-sm text-muted">
            {weekScheduledMin > 0
              ? `${formatDuration(weekScheduledMin)} this week`
              : "Nothing this week"}
            {elsewhereMin > 0 && ` · ${formatDuration(elsewhereMin)} elsewhere`}
          </span>

          <WriteOffDay todayKey={todayKey} isWrittenOff={todayIsWrittenOff} />

          {hasPlan && (
            <Button size="sm" disabled={pending} onClick={() => run(undoLastPlan)}>
              Undo
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={() => run(generatePlan)}
          >
            {pending ? "Planning…" : hasPlan ? "Re-plan" : "Generate plan"}
            {/* Staleness is a dot on the button that fixes it, rather than a
                separate full-width bar explaining that the button exists. */}
            {isStale && !pending && (
              <span
                className="ml-1 h-2 w-2 rounded-full bg-strained"
                aria-label="Plan is out of date"
              />
            )}
          </Button>
        </div>
      </div>

      {/* ---- one-line alerts, expandable --------------------------------- */}
      {(runwayAlert || infeasibility.length > 0 || error || isStale) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {isStale && !pending && (
            <span className="text-muted">Plan is out of date.</span>
          )}

          {runwayAlert && (
            <button
              type="button"
              onClick={() => toggle("runway")}
              aria-expanded={openPanel === "runway"}
              className={cn(
                "rounded-app px-2 py-1 font-medium underline-offset-2 hover:underline",
                runway.worst!.status === "over" ? "text-danger" : "text-strained",
              )}
            >
              {runway.worst!.status === "over"
                ? `Doesn't fit: ${formatDuration(runway.worst!.shortfallMin)} short by ${formatDate(runway.worst!.deadlineKey)}`
                : `Tight before ${formatDate(runway.worst!.deadlineKey)}`}
            </button>
          )}

          {infeasibility.length > 0 && (
            <button
              type="button"
              onClick={() => toggle("blocked")}
              aria-expanded={openPanel === "blocked"}
              className="rounded-app px-2 py-1 font-medium text-warning underline-offset-2 hover:underline"
            >
              {infeasibility.length} couldn&apos;t be scheduled
            </button>
          )}

          {error && <span className="text-danger">{error}</span>}
        </div>
      )}

      {openPanel === "runway" && runway.worst && (
        <Panel onClose={() => setOpenPanel("none")}>
          <p className="text-sm text-muted">{runway.headline}</p>
          <ul className="mt-3 space-y-2">
            {runway.loads
              .filter((l) => l.status !== "comfortable")
              .slice(0, 4)
              .map((l) => (
                <li key={l.deadlineKey} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-medium">{formatDate(l.deadlineKey)}</span>
                  <span className="text-subtle">{l.taskCount} due</span>
                  <span className="ml-auto tabular-nums text-muted">
                    {formatDuration(l.committedMin)} owed / {formatDuration(l.capacityMin)} free
                  </span>
                </li>
              ))}
          </ul>
        </Panel>
      )}

      {openPanel === "blocked" && (
        <Panel onClose={() => setOpenPanel("none")}>
          <p className="text-sm text-muted">
            Sleep and fixed commitments were protected, so this needs a decision
            rather than a later night.
          </p>
          <ul className="mt-3 space-y-2">
            {infeasibility.map((item) => (
              <li key={item.taskId} className="text-sm">
                <span className="font-medium">
                  {taskTitles[item.taskId] ?? "Untitled task"}
                </span>{" "}
                <span className="text-muted">
                  — {formatDuration(item.shortfallMin)} short
                </span>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {item.remedies.map((r, i) => (
                    <li
                      key={i}
                      className="rounded-app border border-border px-2 py-0.5 text-xs text-muted"
                    >
                      {r.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Panel({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="mt-2 rounded-app border border-border bg-surface p-3">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {children}
    </div>
  );
}
