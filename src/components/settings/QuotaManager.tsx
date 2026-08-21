"use client";

import { useState, useTransition } from "react";
import {
  createStudyQuota,
  deleteStudyQuota,
  setQuotaActive,
} from "@/app/(app)/settings/actions";
import { Button, Card, Chip, Hint, Input, Label, Select } from "@/components/ui";
import { formatDuration } from "@/lib/time";
import { cn, COGNITIVE_LOAD_LABELS } from "@/lib/utils";
import type { StudyQuota } from "@/lib/scheduling/quotas";
import type { Subject } from "@/lib/domain/types";

/**
 * Weekly commitments that never finish.
 *
 * The form asks for hours per week and session shape — not topics. A weak
 * area needs frequency and spacing, so the session length is the lever that
 * matters, and the content is chosen when you sit down.
 */
export function QuotaManager({
  quotas,
  subjects,
}: {
  quotas: StudyQuota[];
  subjects: Subject[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [targetMinWeek, setTargetMinWeek] = useState(180);
  const [minSessionMin, setMinSessionMin] = useState(30);
  const [maxSessionMin, setMaxSessionMin] = useState(60);
  const [cognitiveLoad, setCognitiveLoad] = useState(3);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const res = await createStudyQuota({
        label,
        subjectId: subjectId || null,
        targetMinWeek,
        minSessionMin,
        maxSessionMin,
        cognitiveLoad,
      });
      if (!res.ok) setError(res.error);
      else {
        setLabel("");
        setOpen(false);
      }
    });
  }

  const weeklyTotal = quotas
    .filter((q) => q.isActive)
    .reduce((sum, q) => sum + q.targetMinWeek, 0);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="font-medium">Weekly study targets</p>
        {weeklyTotal > 0 && (
          <Chip className="bg-surface-sunken text-muted">
            {formatDuration(weeklyTotal)} / week committed
          </Chip>
        )}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Cancel" : "Add target"}
        </Button>
      </div>
      <Hint className="mb-4 mt-0.5">
        For the things that never finish — SAT, TOPIK, language drilling. The
        scheduler protects the hours each week; you decide what to work on when
        you sit down.
      </Hint>

      {quotas.length > 0 && (
        <ul className="mb-4 space-y-2">
          {quotas.map((q) => (
            <li
              key={q.id}
              className={cn(
                "flex flex-wrap items-center gap-2 rounded-app border border-border px-3 py-2",
                !q.isActive && "opacity-60",
              )}
            >
              <span className="font-medium">{q.label}</span>
              <Chip className="bg-primary-soft text-primary">
                {formatDuration(q.targetMinWeek)}/wk
              </Chip>
              <span className="text-sm text-subtle">
                {formatDuration(q.minSessionMin)}–{formatDuration(q.maxSessionMin)} sessions
              </span>
              {!q.isActive && <Chip className="bg-surface-sunken text-subtle">Paused</Chip>}

              <div className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await setQuotaActive(q.id, !q.isActive);
                    })
                  }
                >
                  {q.isActive ? "Pause" : "Resume"}
                </Button>

                {/* Deleting takes the tracked hours with it, so it asks. */}
                {confirming === q.id ? (
                  <>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          await deleteStudyQuota(q.id);
                          setConfirming(null);
                        })
                      }
                    >
                      Delete + its history
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(q.id)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form onSubmit={submit} className="space-y-4 rounded-app bg-surface-sunken p-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="q-label">What is it?</Label>
              <Input
                id="q-label"
                required
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="SAT Maths"
              />
            </div>
            <div>
              <Label htmlFor="q-subject">Count towards</Label>
              <Select
                id="q-subject"
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              >
                <option value="">Nothing — it&apos;s its own thing</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="q-target">Hours a week</Label>
              <Select
                id="q-target"
                value={targetMinWeek}
                onChange={(e) => setTargetMinWeek(Number(e.target.value))}
              >
                {[60, 90, 120, 150, 180, 240, 300, 360, 480].map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="q-load">Mental effort</Label>
              <Select
                id="q-load"
                value={cognitiveLoad}
                onChange={(e) => setCognitiveLoad(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} — {COGNITIVE_LOAD_LABELS[n]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="q-min">Shortest useful session</Label>
              <Select
                id="q-min"
                value={minSessionMin}
                onChange={(e) => setMinSessionMin(Number(e.target.value))}
              >
                {[15, 20, 30, 45, 60].map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="q-max">Longest session</Label>
              <Select
                id="q-max"
                value={maxSessionMin}
                onChange={(e) => setMaxSessionMin(Number(e.target.value))}
              >
                {[30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {formatDuration(m)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <Hint>
            Shorter sessions get spread across more days. For something
            you&apos;re weak at, that spacing is worth more than one long block.
          </Hint>

          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Add target"}
          </Button>
        </form>
      )}
    </Card>
  );
}
