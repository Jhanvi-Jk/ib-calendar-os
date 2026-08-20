"use client";

import { useState, useTransition } from "react";
import { saveRetrospective } from "@/app/(app)/actions";
import { Button, Card, Chip, Hint, Label, Textarea } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { WeeklyReview as Review } from "@/lib/analytics/weekly";

const REASON: Record<string, { label: string; chip: string }> = {
  overdue: { label: "Overdue", chip: "bg-danger-soft text-danger" },
  partial: { label: "Half done", chip: "bg-strained/15 text-strained" },
  untouched: { label: "Not started", chip: "bg-surface-sunken text-subtle" },
};

/**
 * The weekly sit-down.
 *
 * Two questions only. A long form gets abandoned, and an abandoned review is
 * worth less than a short one that actually gets filled in — the value is in
 * doing it every week, not in doing it thoroughly once.
 */
export function WeeklyReview({ review, todayKey }: { review: Review; todayKey: string }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(review.isDue);
  const [wins, setWins] = useState("");
  const [friction, setFriction] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  function save() {
    setError("");
    startTransition(async () => {
      const res = await saveRetrospective({
        day: todayKey,
        // One per line, so the stored shape stays a list rather than a blob.
        wins: wins.split("\n").map((w) => w.trim()).filter(Boolean),
        friction: friction.split("\n").map((f) => f.trim()).filter(Boolean),
        energyRating: null,
        note: "",
      });
      if (!res.ok) setError(res.error);
      else {
        setSaved(true);
        setOpen(false);
      }
    });
  }

  if (saved) {
    return (
      <Card>
        <p className="font-medium">Review saved</p>
        <Hint className="mt-1">
          Next one lands on Sunday. Carry forward less than feels comfortable.
        </Hint>
      </Card>
    );
  }

  return (
    <Card className={cn(review.isDue && "border-primary/40")}>
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="font-medium">Weekly review</p>
        {review.isDue && <Chip className="bg-primary-soft text-primary">Due now</Chip>}
        {review.daysSinceLast !== null && (
          <span className="text-sm text-subtle">
            last done {review.daysSinceLast === 0 ? "today" : `${review.daysSinceLast}d ago`}
          </span>
        )}
      </div>

      <Hint className="mt-1">{review.headline}</Hint>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Planned"
          value={formatDuration(review.plannedMin)}
        />
        <Stat
          label="Actually done"
          value={formatDuration(review.completedMin)}
        />
        <Stat
          label="Owed next 7 days"
          value={formatDuration(review.nextWeekCommittedMin)}
        />
      </div>

      {review.slipped.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium">What slipped</p>
          <ul className="mt-2 space-y-1">
            {review.slipped.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Chip className={REASON[s.reason].chip}>{REASON[s.reason].label}</Chip>
                <span className="truncate">{s.title}</span>
                <span className="ml-auto tabular-nums text-muted">
                  {formatDuration(s.remainingMin)} left
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open ? (
        <div className="mt-5 space-y-3">
          <div>
            <Label htmlFor="wins">What went well? One per line.</Label>
            <Textarea
              id="wins"
              rows={2}
              value={wins}
              onChange={(e) => setWins(e.target.value)}
              placeholder="Finished the Physics analysis&#10;Actually stopped at 11pm"
            />
          </div>
          <div>
            <Label htmlFor="friction">What got in the way?</Label>
            <Textarea
              id="friction"
              rows={2}
              value={friction}
              onChange={(e) => setFriction(e.target.value)}
              placeholder="Underestimated the maths problem set&#10;Kept switching subjects"
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save review"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        <Button className="mt-4" onClick={() => setOpen(true)}>
          {review.isDue ? "Do this week's review" : "Write a review"}
        </Button>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-app bg-surface-sunken p-3">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
