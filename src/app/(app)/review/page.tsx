import { Card, Chip, EmptyState, Hint } from "@/components/ui";
import { Heatmap } from "@/components/review/Heatmap";
import { SubjectBalance } from "@/components/review/SubjectBalance";
import { getUserContext } from "@/lib/data/queries";
import { getReviewData, getSubjectBalance } from "@/lib/data/analytics";
import { MOMENTUM_COPY, recoveryPlanFor } from "@/lib/analytics/momentum";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

const STATE_CLASS = {
  thriving: "bg-thriving/15 text-thriving",
  steady: "bg-steady/15 text-steady",
  strained: "bg-strained/15 text-strained",
  recovering: "bg-recovering/15 text-recovering",
} as const;

export default async function ReviewPage() {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const [{ momentum, history, accuracy, trackedMinToday }, balance] = await Promise.all([
    getReviewData(ctx.timezone),
    getSubjectBalance(),
  ]);
  const copy = MOMENTUM_COPY[momentum.state];
  const recovery = recoveryPlanFor(momentum.state);
  const hasData = history.some((d) => d.completedMin > 0);

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold tracking-tight">Review</h1>

      {/*
        Momentum, not streaks. There is no counter here that can reset to zero,
        and nothing that frames a rest day as a failure.
      */}
      <Card>
        {/*
          No planned work in the window means there is nothing to score. Showing
          a ratio here would invent a number — a new user with an empty week is
          not "Thriving at 100%".
        */}
        {!momentum.hasData ? (
          <>
            <p className="font-medium">Not enough to go on yet</p>
            <Hint className="mt-1">
              Momentum compares what you planned against what you did. Generate a
              plan for the week and track some work, and this starts reporting.
            </Hint>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <Chip className={cn("text-sm", STATE_CLASS[momentum.state])}>
                {copy.label}
              </Chip>
              <span className="text-2xl font-semibold tabular-nums">
                {Math.round(momentum.ratio * 100)}%
              </span>
              <span className="text-sm text-muted">of your plan, last 7 days</span>
            </div>
            <Hint className="mt-2">{copy.detail}</Hint>

            <Hint className="mt-1">
              {formatDuration(momentum.completedMin)} tracked against{" "}
              {formatDuration(momentum.plannedMin)} planned.
            </Hint>

            {momentum.restDays > 0 && (
              <Hint className="mt-1">
                {momentum.restDays} rest {momentum.restDays === 1 ? "day" : "days"} in
                that window — not counted against you.
              </Hint>
            )}

            {recovery && (
              <div className="mt-4 rounded-app bg-surface-sunken p-3">
                <p className="text-sm font-medium">Recovery protocol active</p>
                <Hint className="mt-1">{recovery.message}</Hint>
              </div>
            )}
          </>
        )}
      </Card>

      <Card>
        <p className="font-medium">Work tracked</p>
        <Hint className="mb-4 mt-0.5">
          {trackedMinToday > 0
            ? `${formatDuration(trackedMinToday)} today.`
            : "Nothing tracked yet today."}
        </Hint>
        {hasData ? (
          <Heatmap history={history} />
        ) : (
          <EmptyState title="No tracked work yet">
            Start a timer on a task and this fills in.
          </EmptyState>
        )}
      </Card>

      {/*
        Momentum says whether the plan was followed. This says whether the plan
        was pointed at the right subjects — the thing a student is least able
        to see about their own week.
      */}
      <Card>
        <p className="font-medium">Where your time went</p>
        <Hint className="mb-4 mt-0.5">Last 14 days, weighted by subject level.</Hint>
        <SubjectBalance report={balance} />
      </Card>

      <Card>
        <p className="font-medium">Estimate accuracy</p>
        <Hint className="mt-0.5">{accuracy.headline}</Hint>

        {/*
          The breakdown is only shown alongside a conclusion once there is
          enough to draw one from — otherwise "1 Finished early" reads as a
          verdict on the user's estimating rather than a single data point.
        */}
        {accuracy.hasEnoughData && (
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <Stat label="On target" value={accuracy.onTarget} />
            <Stat label="Took longer" value={accuracy.underestimated} />
            <Stat label="Finished early" value={accuracy.overestimated} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-app bg-surface-sunken p-3">
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
