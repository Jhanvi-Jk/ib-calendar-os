import { Chip, EmptyState, Hint } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { QuotaReport, QuotaWeekResult } from "@/lib/scheduling/quotas";

/**
 * Did the recurring hours actually happen?
 *
 * Grouped by quota rather than by week, because the useful pattern is "SAT
 * Maths keeps slipping", not "week 3 was bad". A single miss is noise; the
 * same target missed three weeks running means the number is wrong.
 */

const STATUS: Record<QuotaWeekResult["status"], { label: string; chip: string }> = {
  hit: { label: "Hit", chip: "bg-thriving/15 text-thriving" },
  close: { label: "Close", chip: "bg-strained/15 text-strained" },
  missed: { label: "Missed", chip: "bg-danger-soft text-danger" },
  // Neutral by design: the week is still running, so this is a statement of
  // fact, not a verdict.
  in_progress: { label: "This week", chip: "bg-surface-sunken text-muted" },
};

export function QuotaAttainment({ report }: { report: QuotaReport }) {
  if (!report.hasData) {
    return <EmptyState title="No weekly targets yet">{report.headline}</EmptyState>;
  }

  const byQuota = new Map<string, QuotaWeekResult[]>();
  for (const w of report.weeks) {
    const list = byQuota.get(w.quotaId) ?? [];
    list.push(w);
    byQuota.set(w.quotaId, list);
  }

  return (
    <div>
      <Hint className="mb-4">{report.headline}</Hint>
      <ul className="space-y-4">
        {[...byQuota.values()].map((weeks) => {
          const sorted = [...weeks].sort((a, b) => (a.weekMonday < b.weekMonday ? 1 : -1));
          return (
            <li key={sorted[0].quotaId}>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-medium">{sorted[0].label}</span>
                <span className="text-subtle">
                  target {formatDuration(sorted[0].targetMin)}/wk
                </span>
              </div>
              <ul className="flex flex-wrap gap-2">
                {sorted.map((w) => (
                  <li
                    key={w.weekMonday}
                    className="rounded-app border border-border px-2 py-1 text-xs"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-subtle">w/c {w.weekMonday.slice(5)}</span>
                      {/* Status carries a label, never colour alone. */}
                      <Chip className={cn("text-[10px]", STATUS[w.status].chip)}>
                        {STATUS[w.status].label}
                      </Chip>
                    </div>
                    <div className="mt-0.5 tabular-nums text-muted">
                      {formatDuration(w.doneMin)} of {formatDuration(w.targetMin)}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
