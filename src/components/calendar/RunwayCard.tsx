import { Card, Chip, Hint } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { DeadlineLoad, RunwayReport } from "@/lib/analytics/runway";

/**
 * Whether the promises fit in the time.
 *
 * Only surfaces when there is something to say. A card that renders
 * "everything is fine" every day teaches the student to stop reading it, and
 * then it is not there when it matters.
 */

const STATUS: Record<DeadlineLoad["status"], { label: string; chip: string; bar: string }> = {
  comfortable: { label: "Fits", chip: "bg-steady/15 text-steady", bar: "bg-steady" },
  tight: { label: "Tight", chip: "bg-strained/15 text-strained", bar: "bg-strained" },
  over: { label: "Short", chip: "bg-danger-soft text-danger", bar: "bg-danger" },
};

export function RunwayCard({
  report,
  formatDate,
}: {
  report: RunwayReport;
  /** YYYY-MM-DD -> a human date, formatted in the student's timezone. */
  formatDate: (key: string) => string;
}) {
  const { worst, loads } = report;

  // Stay silent when the week is comfortable — see note above.
  if (!report.hasData || !worst || worst.status === "comfortable") return null;

  const pressured = loads.filter((l) => l.status !== "comfortable").slice(0, 4);

  return (
    <Card
      className={cn(
        "mb-4",
        worst.status === "over" ? "border-danger/40 bg-danger-soft/30" : "border-strained/40",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="font-medium">
          {worst.status === "over" ? "This does not fit" : "This is tight"}
        </p>
        <Chip className={STATUS[worst.status].chip}>{STATUS[worst.status].label}</Chip>
      </div>
      <Hint className="mt-1">{report.headline}</Hint>

      <ul className="mt-4 space-y-3">
        {pressured.map((l) => {
          const style = STATUS[l.status];
          const pct = Math.min(100, l.utilisation * 100);
          return (
            <li key={l.deadlineKey}>
              <div className="mb-1 flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium">{formatDate(l.deadlineKey)}</span>
                <span className="text-subtle">
                  {l.taskCount} {l.taskCount === 1 ? "task" : "tasks"} due by then
                </span>
                <span className="ml-auto tabular-nums text-muted">
                  {formatDuration(l.committedMin)} owed / {formatDuration(l.capacityMin)} free
                </span>
                <Chip className={style.chip}>{style.label}</Chip>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
                <div className={cn("h-full rounded-full", style.bar)} style={{ width: `${pct}%` }} />
              </div>
              {l.shortfallMin > 0 && (
                <p className="mt-1 text-xs text-danger">
                  {formatDuration(l.shortfallMin)} more than there is room for.
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {/*
        Concrete options rather than "work harder". A planner's job at this
        point is to make the trade-off explicit, not to imply the student
        should find hours that do not exist.
      */}
      <div className="mt-4 rounded-app bg-surface p-3">
        <p className="text-sm font-medium">What actually helps</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-muted">
          <li>Cut scope on the lowest-weight task due by then.</li>
          <li>Move a deadline you control — ask early, not the night before.</li>
          <li>Reclaim a break day if one falls before the deadline.</li>
          <li>Sleep is not the answer here, and the scheduler will not take it.</li>
        </ul>
      </div>
    </Card>
  );
}
