"use client";

import { useState, useTransition } from "react";
import { createSubject, createTask, deleteTask, setTaskStatus } from "./actions";
import { startTimer, stopTimer } from "@/app/(app)/actions";
import { SyllabusImport } from "./SyllabusImport";
import { Button, Card, Chip, EmptyState, Input, Label, Select } from "@/components/ui";
import { cn, COGNITIVE_LOAD_LABELS } from "@/lib/utils";
import { formatDuration } from "@/lib/time";
import type { SchedulableTask, Subject } from "@/lib/domain/types";

export function TaskManager({
  tasks,
  subjects,
  timezone,
  runningTaskId,
  nowMin,
  aiEnabled,
}: {
  tasks: SchedulableTask[];
  subjects: Subject[];
  timezone: string;
  runningTaskId: string | null;
  /** Supplied by the server: reading the clock during render is impure. */
  nowMin: number;
  /** False when no API key is configured — the feature is hidden, not broken. */
  aiEnabled: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [addingSubject, setAddingSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [newSubjectLevel, setNewSubjectLevel] = useState<"HL" | "SL" | "CORE">("HL");

  function addSubject() {
    const name = newSubjectName.trim();
    if (!name) return;
    setError("");
    startTransition(async () => {
      const res = await createSubject({
        name,
        level: newSubjectLevel,
        ibGroup: newSubjectLevel === "CORE" ? null : 1,
      });
      if (!res.ok) setError(res.error);
      else {
        setNewSubjectName("");
        setAddingSubject(false);
      }
    });
  }

  const [title, setTitle] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [estimateMin, setEstimateMin] = useState(60);
  const [deadlineAt, setDeadlineAt] = useState("");
  const [cognitiveLoad, setCognitiveLoad] = useState(3);

  const subjectName = (id: string | null) =>
    subjects.find((s) => s.id === id)?.name ?? null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const res = await createTask({
        title,
        subjectId: subjectId || null,
        estimateMin,
        deadlineAt: deadlineAt || undefined,
        cognitiveLoad,
        splittable: true,
      });
      if (!res.ok) setError(res.error);
      else {
        setTitle("");
        setDeadlineAt("");
        setOpen(false);
      }
    });
  }

  const dateFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
  });

  return (
    <div>
      <div className="mb-4 flex items-center">
        <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
        <div className="ml-auto flex gap-2">
          {aiEnabled && <SyllabusImport />}
          <Button variant="primary" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "New task"}
          </Button>
        </div>
      </div>

      {open && (
        <Card className="mb-5">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="title">What needs doing?</Label>
              <Input
                id="title"
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Physics IA — analysis section"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="subject">Subject</Label>
                  <button
                    type="button"
                    className="mb-1.5 text-xs text-muted underline hover:text-text"
                    onClick={() => setAddingSubject((v) => !v)}
                  >
                    {addingSubject ? "Cancel" : "+ Add subject"}
                  </button>
                </div>
                {addingSubject ? (
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={newSubjectName}
                      placeholder="Physics"
                      onChange={(e) => setNewSubjectName(e.target.value)}
                      // Enter would otherwise submit the surrounding task form.
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addSubject();
                        }
                      }}
                    />
                    <Select
                      className="w-24"
                      value={newSubjectLevel}
                      onChange={(e) =>
                        setNewSubjectLevel(e.target.value as "HL" | "SL" | "CORE")
                      }
                    >
                      <option value="HL">HL</option>
                      <option value="SL">SL</option>
                      <option value="CORE">Core</option>
                    </Select>
                    <Button type="button" size="sm" onClick={addSubject} disabled={pending}>
                      Save
                    </Button>
                  </div>
                ) : (
                  <Select
                    id="subject"
                    value={subjectId}
                    onChange={(e) => setSubjectId(e.target.value)}
                  >
                    <option value="">None</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.level !== "CORE" ? `(${s.level})` : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              <div>
                <Label htmlFor="deadline">Deadline</Label>
                <Input
                  id="deadline"
                  type="datetime-local"
                  value={deadlineAt}
                  onChange={(e) => setDeadlineAt(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="estimate">Estimate</Label>
                <Select
                  id="estimate"
                  value={estimateMin}
                  onChange={(e) => setEstimateMin(Number(e.target.value))}
                >
                  {[15, 30, 45, 60, 90, 120, 180, 240, 360, 480].map((m) => (
                    <option key={m} value={m}>
                      {formatDuration(m)}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="load">Mental effort</Label>
                <Select
                  id="load"
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
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Adding…" : "Add task"}
            </Button>
          </form>
        </Card>
      )}

      {tasks.length === 0 ? (
        <EmptyState title="No open tasks">
          Add what you owe, with honest estimates. The scheduler handles when.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 rounded-app border border-border bg-surface px-4 py-3"
            >
              <input
                type="checkbox"
                aria-label={`Mark ${t.title} done`}
                className="h-4 w-4 accent-[var(--primary)]"
                onChange={(e) =>
                  startTransition(async () => {
                    await setTaskStatus(t.id, e.target.checked);
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {subjectName(t.subjectId) && <span>{subjectName(t.subjectId)}</span>}
                  <span>{formatDuration(t.remainingMin)} left</span>
                  <span>{COGNITIVE_LOAD_LABELS[t.cognitiveLoad]}</span>
                  {t.deadlineAt && (
                    <Chip
                      className={cn(
                        "bg-surface-sunken",
                        t.deadlineAt < nowMin && "bg-danger-soft text-danger",
                      )}
                    >
                      due {dateFmt.format(new Date(t.deadlineAt * 60_000))}
                    </Chip>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant={runningTaskId === t.id ? "primary" : "secondary"}
                onClick={() =>
                  startTransition(async () => {
                    if (runningTaskId === t.id) await stopTimer();
                    else await startTimer(t.id);
                  })
                }
              >
                {runningTaskId === t.id ? "Stop" : "Start"}
              </Button>
              {/*
                Two-step delete. A deadline tool should not lose work to a
                single stray click, and there is no undo for a deleted task.
              */}
              {confirmingDelete === t.id ? (
                <span className="flex items-center gap-1">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() =>
                      startTransition(async () => {
                        await deleteTask(t.id);
                        setConfirmingDelete(null);
                      })
                    }
                  >
                    Delete for good
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingDelete(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(t.id)}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
