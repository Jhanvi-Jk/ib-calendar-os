import { heatLevel, type DayRecord } from "@/lib/analytics/momentum";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Contribution heatmap.
 *
 * Shows work done, never work missed. There is no "you broke your streak"
 * state and no red — an empty square is simply empty, which is what a rest
 * day should look like.
 */
const LEVEL_CLASS = [
  "bg-surface-sunken",
  "bg-primary/20",
  "bg-primary/40",
  "bg-primary/65",
  "bg-primary",
] as const;

export function Heatmap({ history }: { history: DayRecord[] }) {
  // Pad the start so the first column begins on a Sunday.
  const first = history[0];
  const leadingBlanks = first ? new Date(`${first.date}T00:00:00Z`).getUTCDay() : 0;

  const weeks: Array<Array<DayRecord | null>> = [];
  let current: Array<DayRecord | null> = Array(leadingBlanks).fill(null);

  for (const record of history) {
    current.push(record);
    if (current.length === 7) {
      weeks.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    weeks.push([...current, ...Array(7 - current.length).fill(null)]);
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-1">
            {week.map((record, di) => (
              <div
                key={di}
                className={cn(
                  "h-3 w-3 rounded-[3px]",
                  record ? LEVEL_CLASS[heatLevel(record)] : "opacity-0",
                )}
                title={
                  record
                    ? `${record.date} — ${formatDuration(record.completedMin)} tracked`
                    : undefined
                }
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 text-xs text-subtle">
        <span>Less</span>
        {LEVEL_CLASS.map((cls, i) => (
          <div key={i} className={cn("h-3 w-3 rounded-[3px]", cls)} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
