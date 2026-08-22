"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { flagWeakTopic } from "@/app/(app)/actions";
import { Button, Input, Select } from "@/components/ui";
import type { Subject } from "@/lib/domain/types";

const CONFIDENCE = [
  { value: 1, label: "No idea what happened" },
  { value: 2, label: "Shaky" },
  { value: 3, label: "Half of it stuck" },
  { value: 4, label: "Mostly fine, one gap" },
];

/**
 * The after-a-bad-test button.
 *
 * One topic, one confidence rating, done. Asking for more at the moment
 * someone has just had a bad test is how a feature goes unused — the value is
 * that it takes ten seconds while the sting is still fresh.
 */
export function FlagWeakTopic({ subjects }: { subjects: Subject[] }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [subjectId, setSubjectId] = useState("");
  const [label, setLabel] = useState("");
  const [confidence, setConfidence] = useState(2);
  const [msg, setMsg] = useState("");
  const router = useRouter();

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Struggled with something
      </Button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select
        aria-label="Subject"
        className="w-40"
        value={subjectId}
        onChange={(e) => setSubjectId(e.target.value)}
      >
        <option value="">Subject…</option>
        {subjects.map((s) => (
          <option key={s.id} value={s.id}>{s.name}</option>
        ))}
      </Select>
      <Input
        className="w-52"
        autoFocus
        placeholder="Which topic?"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Select
        aria-label="How did it go"
        className="w-52"
        value={confidence}
        onChange={(e) => setConfidence(Number(e.target.value))}
      >
        {CONFIDENCE.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        disabled={pending || !label.trim()}
        onClick={() =>
          startTransition(async () => {
            const res = await flagWeakTopic({
              subjectId: subjectId || null,
              label,
              confidence,
            });
            if (!res.ok) setMsg(res.error);
            else {
              setMsg(`Scheduled ${res.passes} revision passes.`);
              setLabel("");
              setOpen(false);
              router.refresh();
            }
          })
        }
      >
        {pending ? "Scheduling…" : "Schedule revision"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setMsg(""); }}>
        Cancel
      </Button>
      {msg && <span className="text-sm text-muted">{msg}</span>}
    </span>
  );
}
