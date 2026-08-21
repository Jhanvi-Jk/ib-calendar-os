"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { undoWriteOff, writeOffDay } from "@/app/(app)/actions";
import { Button, Select } from "@/components/ui";

const REASONS = [
  { value: "illness", label: "I was ill" },
  { value: "family", label: "Family" },
  { value: "travel", label: "Travel" },
  { value: "burnout", label: "I needed a break" },
  { value: "other", label: "Something else" },
] as const;

/**
 * "Today didn't happen."
 *
 * Phrased as a fact rather than a confession, and it never asks for detail
 * beyond a category. A student who has been ill should be able to clear the
 * day in one click, not fill in a form justifying it.
 */
export function WriteOffDay({
  todayKey,
  isWrittenOff,
}: {
  todayKey: string;
  isWrittenOff: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number]["value"]>("illness");
  const router = useRouter();

  if (isWrittenOff) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted">
        Today is written off — it won&apos;t count against you.
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await undoWriteOff(todayKey);
              router.refresh();
            })
          }
        >
          Undo
        </Button>
      </span>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Write off today
      </Button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Reason"
        className="w-44"
        value={reason}
        onChange={(e) => setReason(e.target.value as typeof reason)}
      >
        {REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await writeOffDay({ day: todayKey, reason });
            setOpen(false);
            router.refresh();
          })
        }
      >
        {pending ? "Clearing…" : "Clear the day"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  );
}
