import { Chip, EmptyState, Hint } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BalanceReport, SubjectShare } from "@/lib/analytics/balance";

/**
 * Where the hours went, weighted by how much each subject is worth.
 *
 * Deliberately not a pie chart: the question is not "what proportion" but
 * "which subject is short of where it should be", which a bar against a
 * marked target answers directly and a pie does not.
 */

const STATUS: Record<SubjectShare["status"], { label: string; bar: string; chip: string }> = {
  neglected: { label: "Neglected", bar: "bg-strained", chip: "bg-strained/15 text-strained" },
  light: { label: "Light", bar: "bg-recovering", chip: "bg-recovering/15 text-recovering" },
  balanced: { label: "On track", bar: "bg-steady", chip: "bg-steady/15 text-steady" },
  heavy: { label: "Heavy", bar: "bg-thriving", chip: "bg-thriving/15 text-thriving" },
};

export function SubjectBalance({ report }: { report: BalanceReport }) {
  if (!report.hasEnoughData) {
    return (
      <EmptyState title="Not enough tracked time to judge balance">
        {report.headline}
      </EmptyState>
    );
  }

  const widest = Math.max(...report.subjects.map((s) => s.share), 0.01);

  return (
    <div>
      <Hint className="mb-4">{report.headline}</Hint>

      <ul className="space-y-3">
        {report.subjects.map((s) => {
          const style = STATUS[s.status];
          return (
            <li key={s.subjectId}>
              <div className="mb-1 flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="text-subtle">
                  {s.level !== "CORE" ? s.level : "Core"}
                </span>
                <span className="ml-auto tabular-nums text-muted">
                  {formatDuration(s.minutes)}
                </span>
                {/* Status is never carried by colour alone — the chip is labelled. */}
                <Chip className={style.chip}>{style.label}</Chip>
              </div>

              <div className="relative h-2 overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={cn("h-full rounded-full", style.bar)}
                  style={{ width: `${(s.share / widest) * 100}%` }}
                />
                {/* Target marker: where this subject's weight says it should sit. */}
                <div
                  className="absolute inset-y-0 w-px bg-border-strong"
                  style={{ left: `${Math.min(100, (s.expectedShare / widest) * 100)}%` }}
                  aria-hidden
                />
              </div>
              <span className="sr-only">
                {Math.round(s.share * 100)} percent of tracked time, target{" "}
                {Math.round(s.expectedShare * 100)} percent
              </span>
            </li>
          );
        })}
      </ul>

      <Hint className="mt-4">
        The thin line marks where each subject would sit if time followed its
        weight — HL subjects are expected to take more than SL, so an even split
        is not a balanced one.
      </Hint>
    </div>
  );
}
