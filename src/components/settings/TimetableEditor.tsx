"use client";

import { useState, useTransition } from "react";
import {
  createLesson,
  deleteLesson,
  setTimetableAnchor,
} from "@/app/(app)/settings/timetable-actions";
import { Button, Card, Chip, Hint, Input, Label, Select } from "@/components/ui";
import { formatClock, formatDuration } from "@/lib/time";
import { weeklyContactMinutes, type TimetableEntry } from "@/lib/scheduling/timetable";
import type { Subject } from "@/lib/domain/types";

const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

/**
 * The school timetable.
 *
 * Grouped by day rather than shown as a flat list, because that is how a
 * student holds their week in their head and how they will read it off a
 * printed timetable when copying it in.
 */
export function TimetableEditor({
  entries,
  subjects,
  anchorMonday,
}: {
  entries: TimetableEntry[];
  subjects: Subject[];
  anchorMonday: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [subjectId, setSubjectId] = useState("");
  const [label, setLabel] = useState("");
  const [room, setRoom] = useState("");
  const [startsAt, setStartsAt] = useState("09:00");
  const [endsAt, setEndsAt] = useState("10:00");
  const [parity, setParity] = useState<"every" | "A" | "B">("every");

  const usesFortnight = anchorMonday !== null;

  function add(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // Default the label from the chosen subject so the common case is one field.
    const chosen = subjects.find((s) => s.id === subjectId);
    const finalLabel = label.trim() || chosen?.name || "";
    if (!finalLabel) {
      setError("Give the lesson a name, or pick a subject.");
      return;
    }
    startTransition(async () => {
      const res = await createLesson({
        label: finalLabel,
        subjectId: subjectId || null,
        room,
        dayOfWeek,
        startsAt,
        endsAt,
        parity: usesFortnight ? parity : "every",
      });
      if (!res.ok) setError(res.error);
      else {
        setLabel("");
        setRoom("");
      }
    });
  }

  const contactMin = weeklyContactMinutes(entries);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="font-medium">Class timetable</p>
        {entries.length > 0 && (
          <span className="text-sm text-subtle">
            {formatDuration(Math.round(contactMin))} of lessons a week
          </span>
        )}
      </div>
      <Hint className="mb-4 mt-0.5">
        Your lessons are immutable — nothing gets scheduled on top of them. This
        is what lets the planner put revision in the gaps rather than guessing.
      </Hint>

      {/* --- fortnight toggle ------------------------------------------- */}
      <div className="mb-5 rounded-app bg-surface-sunken p-3">
        <Label htmlFor="anchor">Two-week timetable?</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="anchor"
            type="date"
            className="w-48"
            value={anchorMonday ?? ""}
            onChange={(e) =>
              startTransition(async () => {
                const res = await setTimetableAnchor({
                  anchorMonday: e.target.value || null,
                });
                if (!res.ok) setError(res.error);
                else setError("");
              })
            }
          />
          {anchorMonday ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                startTransition(async () => {
                  await setTimetableAnchor({ anchorMonday: null });
                })
              }
            >
              Use a single-week timetable
            </Button>
          ) : (
            <span className="text-sm text-muted">
              Leave blank if every week is the same.
            </span>
          )}
        </div>
        <Hint className="mt-1">
          If your school runs Week A / Week B, give the Monday of a week you know
          is Week A. Weeks are counted from there.
        </Hint>
      </div>

      {/* --- existing lessons, by day ------------------------------------ */}
      {entries.length > 0 && (
        <div className="mb-5 space-y-3">
          {DAYS.filter((d) => entries.some((e) => e.dayOfWeek === d.value)).map((d) => (
            <div key={d.value}>
              <p className="text-sm font-medium">{d.label}</p>
              <ul className="mt-1 space-y-1">
                {entries
                  .filter((e) => e.dayOfWeek === d.value)
                  .sort((a, b) => a.startsMin - b.startsMin)
                  .map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-center gap-2 rounded-app border border-border px-3 py-1.5 text-sm"
                    >
                      <span className="tabular-nums text-muted">
                        {formatClock(e.startsMin)}–{formatClock(e.endsMin)}
                      </span>
                      <span className="font-medium">{e.label}</span>
                      {e.room && <span className="text-subtle">{e.room}</span>}
                      {e.parity !== "every" && (
                        <Chip className="bg-tier-2-soft text-tier-2">Week {e.parity}</Chip>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() =>
                          startTransition(async () => {
                            await deleteLesson(e.id);
                          })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* --- add a lesson ------------------------------------------------- */}
      <form onSubmit={add} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="tt-day">Day</Label>
            <Select
              id="tt-day"
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(Number(e.target.value))}
            >
              {DAYS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tt-subject">Subject</Label>
            <Select
              id="tt-subject"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
            >
              <option value="">Not a subject (registration, games…)</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.level !== "CORE" ? ` (${s.level})` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tt-start">Starts</Label>
            <Input
              id="tt-start"
              type="time"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tt-end">Ends</Label>
            <Input
              id="tt-end"
              type="time"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tt-label">Name</Label>
            <Input
              id="tt-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={
                subjects.find((s) => s.id === subjectId)?.name ?? "Physics HL"
              }
            />
          </div>
          <div>
            <Label htmlFor="tt-room">Room</Label>
            <Input
              id="tt-room"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="Optional"
            />
          </div>
          {usesFortnight && (
            <div>
              <Label htmlFor="tt-parity">Which week?</Label>
              <Select
                id="tt-parity"
                value={parity}
                onChange={(e) => setParity(e.target.value as typeof parity)}
              >
                <option value="every">Every week</option>
                <option value="A">Week A only</option>
                <option value="B">Week B only</option>
              </Select>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : "Add lesson"}
        </Button>
      </form>
    </Card>
  );
}
