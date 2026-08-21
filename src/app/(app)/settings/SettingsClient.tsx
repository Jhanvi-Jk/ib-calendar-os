"use client";

import { useState, useTransition } from "react";
import {
  createAcademicDate,
  deleteAcademicDate,
  setSubjectWeight,
} from "./actions";
import { Button, Card, Chip, Hint, Input, Label, Select } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Countdown } from "@/lib/analytics/countdown";
import type { Subject } from "@/lib/domain/types";
import type { StudyQuota } from "@/lib/scheduling/quotas";
import { QuotaManager } from "@/components/settings/QuotaManager";

const KINDS = [
  { value: "exam_session", label: "Exam session" },
  { value: "mock_exams", label: "Mock exams" },
  { value: "term_start", label: "Term starts" },
  { value: "term_end", label: "Term ends" },
  { value: "half_term", label: "Half term" },
  { value: "holiday", label: "Holiday" },
  { value: "coursework_deadline", label: "Coursework deadline" },
] as const;

const WEIGHTS = [
  { value: 0.5, label: "Coasting — already where I need it" },
  { value: 1, label: "Normal" },
  { value: 1.5, label: "Pushing — needs a grade jump" },
  { value: 2, label: "Decides my offer" },
];

export function SettingsClient({
  dates,
  subjects,
  quotas,
}: {
  dates: Countdown[];
  subjects: Subject[];
  quotas: StudyQuota[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("exam_session");
  const [label, setLabel] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);

  const isRange = kind === "half_term" || kind === "holiday" || kind === "exam_session" || kind === "mock_exams";

  function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const res = await createAcademicDate({
        kind,
        label,
        startsOn,
        endsOn: isRange ? endsOn : "",
        isPrimary,
      });
      if (!res.ok) setError(res.error);
      else {
        setLabel("");
        setStartsOn("");
        setEndsOn("");
        setIsPrimary(false);
      }
    });
  }

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>

      <Card>
        <p className="font-medium">Term dates and exams</p>
        <Hint className="mb-4 mt-0.5">
          Mark one as the anchor — usually your IB session. That is the countdown
          that gets top billing on the calendar.
        </Hint>

        {dates.length > 0 && (
          <ul className="mb-5 space-y-2">
            {dates.map((d) => (
              <li
                key={d.id}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-app border border-border px-3 py-2",
                  d.isPast && "opacity-60",
                )}
              >
                {d.isPrimary && <Chip className="bg-tier-1-soft text-tier-1">Anchor</Chip>}
                <span className="font-medium">{d.label}</span>
                <span className="text-sm text-subtle">
                  {d.startsOn}
                  {d.endsOn ? ` – ${d.endsOn}` : ""}
                </span>
                <span className="text-sm text-muted">{d.phrase}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() =>
                    startTransition(async () => {
                      await deleteAcademicDate(d.id);
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="kind">What is it?</Label>
              <Select
                id="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="label">Name</Label>
              <Input
                id="label"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="IB May 2027"
              />
            </div>
            <div>
              <Label htmlFor="startsOn">{isRange ? "Starts" : "Date"}</Label>
              <Input
                id="startsOn"
                type="date"
                required
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </div>
            {isRange && (
              <div>
                <Label htmlFor="endsOn">Ends</Label>
                <Input
                  id="endsOn"
                  type="date"
                  value={endsOn}
                  onChange={(e) => setEndsOn(e.target.value)}
                />
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-6 w-6 accent-[var(--primary)]"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            Make this the anchor countdown
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Add date"}
          </Button>
        </form>
      </Card>

      <QuotaManager quotas={quotas} subjects={subjects} />

      <Card>
        <p className="font-medium">Subject weighting</p>
        <Hint className="mb-4 mt-0.5">
          This is not how much you like a subject — it is how much a grade
          change there is worth to you. The scheduler gives weighted subjects
          more of your best hours, so marking everything &ldquo;decides my
          offer&rdquo; is the same as marking nothing.
        </Hint>

        <ul className="space-y-2">
          {subjects.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-3 rounded-app border border-border px-3 py-2"
            >
              <span className="font-medium">{s.name}</span>
              <span className="text-sm text-subtle">
                {s.level !== "CORE" ? s.level : "Core"}
              </span>
              <Select
                aria-label={`Weight for ${s.name}`}
                className="ml-auto w-64"
                value={String(s.gradeWeight)}
                onChange={(e) =>
                  startTransition(async () => {
                    const res = await setSubjectWeight({
                      subjectId: s.id,
                      gradeWeight: Number(e.target.value),
                    });
                    if (!res.ok) setError(res.error);
                  })
                }
              >
                {WEIGHTS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
        <Hint className="mt-3">
          Changing a weight makes the current plan stale — hit Re-plan on the
          calendar to apply it.
        </Hint>
      </Card>
    </div>
  );
}
