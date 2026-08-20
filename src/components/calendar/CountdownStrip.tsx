import Link from "next/link";
import { Chip } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Countdown, CountdownBoard } from "@/lib/analytics/countdown";

/**
 * The year's landmarks, always in view.
 *
 * The anchor gets a number large enough to read at a glance because that is
 * the point — the whole value is turning a vague "sometime in May" into a
 * figure the student can plan against.
 */

const KIND_LABEL: Record<Countdown["kind"], string> = {
  exam_session: "Exams",
  mock_exams: "Mocks",
  term_start: "Term starts",
  term_end: "Term ends",
  half_term: "Half term",
  holiday: "Holiday",
  coursework_deadline: "Coursework",
};

const KIND_TONE: Record<Countdown["kind"], string> = {
  exam_session: "bg-tier-1-soft text-tier-1",
  mock_exams: "bg-tier-2-soft text-tier-2",
  term_start: "bg-surface-sunken text-muted",
  term_end: "bg-surface-sunken text-muted",
  half_term: "bg-tier-4-soft text-tier-4",
  holiday: "bg-tier-4-soft text-tier-4",
  coursework_deadline: "bg-tier-2-soft text-tier-2",
};

export function CountdownStrip({ board }: { board: CountdownBoard }) {
  const { primary, upcoming } = board;

  if (!primary && upcoming.length === 0) {
    return (
      <div className="mb-4 rounded-app border border-dashed border-border-strong px-4 py-3 text-sm text-muted">
        No term dates yet.{" "}
        <Link href="/settings" className="underline hover:text-text">
          Add your exam session and term dates
        </Link>{" "}
        to see how long you actually have.
      </div>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-stretch gap-3">
      {primary && (
        <div
          className={cn(
            "flex min-w-56 flex-1 items-center gap-4 rounded-app border px-4 py-3",
            primary.isActive
              ? "border-tier-1/40 bg-tier-1-soft"
              : "border-border bg-surface",
          )}
        >
          <div>
            <div className="text-3xl font-semibold tabular-nums leading-none">
              {primary.isActive && primary.daysUntilEnd !== null
                ? primary.daysUntilEnd
                : Math.max(0, primary.daysUntilStart)}
            </div>
            <div className="mt-1 text-xs uppercase tracking-wide text-subtle">
              {primary.isActive ? "days left" : "days to go"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">{primary.label}</div>
            <div className="text-sm text-muted">{primary.phrase}</div>
          </div>
        </div>
      )}

      {upcoming.length > 0 && (
        <ul className="flex flex-1 flex-wrap items-center gap-2">
          {upcoming.map((c) => (
            <li
              key={c.id}
              className="rounded-app border border-border bg-surface px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <Chip className={KIND_TONE[c.kind]}>{KIND_LABEL[c.kind]}</Chip>
                <span className="text-sm font-medium">{c.label}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted">{c.phrase}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
