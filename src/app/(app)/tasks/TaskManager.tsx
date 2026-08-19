"use client";

import { useState, useTransition } from "react";
import {
  createSubject,
  createTask,
  deleteTask,
  setTaskStatus,
  updateTask,
} from "./actions";
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
  /** Informational, not a failure — kept separate so it is not styled as one. */
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [addingSubject, setAddingSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [newSubjectLevel, setNewSubjectLevel] = useState<"HL" | "SL" | "CORE">("HL");

  /** Leaves the add-subject form, discarding any error it produced. */
  function closeAddSubject() {
    setAddingSubject(false);
    setNewSubjectName("");
    setError("");
    setNotice("");
  }

  function addSubject() {
    const name = newSubjectName.trim();
    if (!name) return;
    setError("");
    setNotice("");

    // Catch the collision here rather than after a round-trip, and select the
    // existing subject instead of leaving the user stuck on an error.
    const existing = subjects.find(
      (s) => s.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      setSubjectId(existing.id);
      setNotice(`"${existing.name}" already exists — selected it for you.`);
      setAddingSubject(false);
      setNewSubjectName("");
      return;
    }

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
  /** Non-null when the form is editing an existing task rather than creating. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Most recently completed task, offered for undo until dismissed. */
  const [justCompleted, setJustCompleted] = useState<{ id: string; title: string } | null>(
    null,
  );

  const subjectName = (id: string | null) =>
    subjects.find((s) => s.id === id)?.name ?? null;

  /**
   * A deadline already in the past is almost always a typo or the wrong year.
   * The solver rejects it later with "deadline has already passed"; saying so
   * at the point of entry is far more useful than at the point of planning.
   */
  const deadlineIsPast =
    deadlineAt !== "" && new Date(deadlineAt).getTime() < Date.now();

  function resetForm() {
    setTitle("");
    setSubjectId("");
    setEstimateMin(60);
    setDeadlineAt("");
    setCognitiveLoad(3);
    setEditingId(null);
    setError("");
    setNotice("");
    setAddingSubject(false);
  }

  function beginEdit(task: SchedulableTask) {
    setEditingId(task.id);
    setTitle(task.title);
    setSubjectId(task.subjectId ?? "");
    setEstimateMin(task.estimateMin);
    setCognitiveLoad(task.cognitiveLoad);
    // datetime-local wants local wall-clock with no zone suffix.
    setDeadlineAt(
      task.deadlineAt ? toDatetimeLocal(task.deadlineAt, timezone) : "",
    );
    setError("");
    setNotice("");
    setOpen(true);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    startTransition(async () => {
      const res = editingId
        ? await updateTask({
            id: editingId,
            title,
            subjectId: subjectId || null,
            estimateMin,
            deadlineAt: deadlineAt || null,
            cognitiveLoad,
          })
        : await createTask({
            title,
            subjectId: subjectId || null,
            estimateMin,
            deadlineAt: deadlineAt || undefined,
            cognitiveLoad,
            splittable: true,
          });
      if (!res.ok) setError(res.error);
      else {
        resetForm();
        setOpen(false);
      }
    });
  }

  function complete(task: SchedulableTask) {
    startTransition(async () => {
      const res = await setTaskStatus(task.id, true);
      if (!res.ok) setError(res.error);
      // Completion removes the task from this list, so the only route back is
      // an explicit undo. Without it a mis-click is unrecoverable from the UI.
      else setJustCompleted({ id: task.id, title: task.title });
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
          <Button
            variant="primary"
            onClick={() => {
              if (open) resetForm();
              setOpen((v) => !v);
            }}
          >
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
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="subject">Subject</Label>
                  {!addingSubject && (
                    <button
                      type="button"
                      className="mb-1.5 shrink-0 text-xs text-muted underline hover:text-text"
                      onClick={() => setAddingSubject(true)}
                    >
                      + Add subject
                    </button>
                  )}
                </div>
                <Select
                  id="subject"
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                >
                  <option value="">None</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.level !== "CORE" ? ` (${s.level})` : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="deadline">Deadline</Label>
                <Input
                  id="deadline"
                  type="datetime-local"
                  value={deadlineAt}
                  onChange={(e) => setDeadlineAt(e.target.value)}
                  aria-describedby={deadlineIsPast ? "deadline-warning" : undefined}
                />
                {deadlineIsPast && (
                  <p id="deadline-warning" className="mt-1 text-xs text-warning">
                    That date has already passed. You can still save it, but the
                    scheduler won&apos;t be able to find time for it.
                  </p>
                )}
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
            {/*
              Full-width row of its own. Nested inside the Subject grid cell it
              overflowed and collided with the Deadline label beside it.
            */}
            {addingSubject && (
              <div className="rounded-app border border-border bg-surface-sunken p-3">
                <Label htmlFor="new-subject">New subject</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="new-subject"
                    autoFocus
                    className="min-w-40 flex-1"
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
                    className="w-28"
                    aria-label="Level"
                    value={newSubjectLevel}
                    onChange={(e) =>
                      setNewSubjectLevel(e.target.value as "HL" | "SL" | "CORE")
                    }
                  >
                    <option value="HL">HL</option>
                    <option value="SL">SL</option>
                    <option value="CORE">Core</option>
                  </Select>
                  <Button type="button" onClick={addSubject} disabled={pending}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={closeAddSubject}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {notice && <p className="text-sm text-muted">{notice}</p>}
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" variant="primary" disabled={pending}>
              {pending
                ? "Saving…"
                : editingId
                  ? "Save changes"
                  : "Add task"}
            </Button>
          </form>
        </Card>
      )}

      {/*
        Completion drops the task out of this list entirely, so an accidental
        tick is otherwise unrecoverable without going to the database.
      */}
      {justCompleted && (
        <div className="mb-3 flex items-center gap-3 rounded-app border border-border bg-surface-sunken px-4 py-2 text-sm">
          <span className="truncate">
            Completed <strong>{justCompleted.title}</strong>
          </span>
          <Button
            size="sm"
            className="ml-auto"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await setTaskStatus(justCompleted.id, false);
                setJustCompleted(null);
              })
            }
          >
            Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => setJustCompleted(null)}
          >
            Dismiss
          </Button>
        </div>
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
                checked={false}
                onChange={() => complete(t)}
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
              <Button variant="ghost" size="sm" onClick={() => beginEdit(t)}>
                Edit
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

/**
 * Epoch minutes -> the "YYYY-MM-DDTHH:mm" that <input type="datetime-local">
 * requires, rendered in the user's zone rather than the browser's.
 */
function toDatetimeLocal(epochMin: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(epochMin * 60_000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
