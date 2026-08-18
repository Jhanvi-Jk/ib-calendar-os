"use client";

import { useState, useTransition } from "react";
import { importSyllabus } from "./import-actions";
import { applyProposal } from "@/lib/ai/applier";
import { Button, Card, Chip, Hint, Input, Label, Textarea } from "@/components/ui";
import { formatDuration } from "@/lib/time";

interface Extracted {
  title: string;
  estimateMin: number;
  cognitiveLoad: number;
  deadlineIso: string | null;
  sourceQuote: string | null;
}

export function SyllabusImport() {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    proposalId: string;
    tasks: Extracted[];
    suspectedInjection: boolean;
    injectionQuote: string | null;
  } | null>(null);

  function parse() {
    setError("");
    startTransition(async () => {
      const res = await importSyllabus({ text, label: label || "pasted text" });
      if (!res.ok) setError(res.error);
      else
        setResult({
          proposalId: res.proposalId,
          tasks: res.tasks,
          suspectedInjection: res.suspectedInjection,
          injectionQuote: res.injectionQuote,
        });
    });
  }

  function confirm() {
    if (!result) return;
    setError("");
    startTransition(async () => {
      // The proposal is approved and applied in two distinct steps — the
      // applier refuses to write anything still awaiting confirmation.
      const { setProposalStatus } = await import("@/lib/ai/applier");
      await setProposalStatus(result.proposalId, "approved");
      const res = await applyProposal(result.proposalId);
      if (!res.ok) setError(res.error);
      else {
        setResult(null);
        setText("");
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>Import from syllabus</Button>
    );
  }

  return (
    <Card className="mt-4">
      {!result ? (
        <>
          <Label htmlFor="label">Where is this from?</Label>
          <Input
            id="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Physics HL syllabus, Term 2"
          />
          <Label htmlFor="doc" className="mt-4">
            Paste the syllabus or assignment sheet
          </Label>
          <Textarea
            id="doc"
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the text here…"
          />
          <Hint className="mt-2">
            Nothing is saved until you review what was found. Text inside the
            document is treated as data, never as instructions.
          </Hint>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={parse} disabled={pending}>
              {pending ? "Reading…" : "Find tasks"}
            </Button>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          {result.suspectedInjection && (
            <div className="mb-4 rounded-app border border-danger/40 bg-danger-soft p-3">
              <p className="text-sm font-medium text-danger">
                This document contains text addressed at an AI
              </p>
              <Hint className="mt-1">
                It was treated as data and not acted on. Check the source before
                importing.
              </Hint>
              {result.injectionQuote && (
                <p className="mt-2 rounded bg-surface p-2 font-mono text-xs">
                  {result.injectionQuote}
                </p>
              )}
            </div>
          )}

          <p className="font-medium">
            Found {result.tasks.length} {result.tasks.length === 1 ? "task" : "tasks"}
          </p>
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
            {result.tasks.map((task, i) => (
              <li key={i} className="rounded-app bg-surface-sunken p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium">{task.title}</span>
                  <Chip className="bg-surface">{formatDuration(task.estimateMin)}</Chip>
                  {task.deadlineIso && (
                    <Chip className="bg-surface">
                      due {task.deadlineIso.slice(0, 10)}
                    </Chip>
                  )}
                </div>
                {task.sourceQuote && (
                  <p className="mt-1 text-xs italic text-subtle">
                    &ldquo;{task.sourceQuote}&rdquo;
                  </p>
                )}
              </li>
            ))}
          </ul>

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <div className="mt-4 flex gap-2">
            <Button variant="primary" onClick={confirm} disabled={pending}>
              {pending ? "Adding…" : `Add ${result.tasks.length} tasks`}
            </Button>
            <Button onClick={() => setResult(null)}>Back</Button>
          </div>
        </>
      )}
      {error && !result && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Card>
  );
}
