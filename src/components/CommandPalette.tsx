"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { generatePlan, undoLastPlan } from "@/app/(app)/calendar/actions";
import { stopTimer } from "@/app/(app)/actions";
import { setOccurrenceCancelled } from "@/app/(app)/settings/timetable-actions";
import {
  looksLikeTimetableCommand,
  parseTimetableCommand,
  type CommandEntry,
} from "@/lib/commands/timetable-commands";
import { cn } from "@/lib/utils";

/**
 * Global command palette (Ctrl/Cmd + Space).
 *
 * The action registry is a typed list rather than free-text dispatch. That
 * matters beyond tidiness: the AI layer's `reschedule_intent` proposals
 * resolve to these same ids, so a model can only ever select an action that
 * already exists here — it cannot invent one.
 */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void | Promise<unknown>;
}

export function CommandPalette({
  timetableEntries = [],
  todayKey,
}: {
  /** Used to resolve "cancel Thursday 27th teaching" against real lessons. */
  timetableEntries?: CommandEntry[];
  /** Injected rather than read from the clock, so the parse is deterministic. */
  todayKey: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = useMemo(
    () => [
      {
        id: "plan.generate",
        label: "Generate plan",
        hint: "Re-solve the schedule",
        run: () => generatePlan(),
      },
      {
        id: "plan.undo",
        label: "Undo last plan",
        hint: "Go back to the previous schedule",
        run: () => undoLastPlan(),
      },
      {
        id: "timer.stop",
        label: "Stop timer",
        hint: "Close the running time entry",
        run: () => stopTimer(),
      },
      {
        id: "nav.calendar",
        label: "Go to calendar",
        run: () => router.push("/calendar"),
      },
      { id: "nav.tasks", label: "Go to tasks", run: () => router.push("/tasks") },
      { id: "nav.review", label: "Go to review", run: () => router.push("/review") },
    ],
    [router],
  );

  /**
   * Free text is parsed, not sent anywhere.
   *
   * "Cancel Thursday 27th teaching session" is a closed grammar — a verb, a
   * date, and the name of something already in the timetable — so it is a
   * deterministic parse rather than a language-model call. No API key, nothing
   * to hallucinate a date, and the rule that the model never writes to the
   * database stays true because there is no model.
   */
  const parsed = useMemo(() => {
    const q = query.trim();
    if (q.length < 3 || !looksLikeTimetableCommand(q)) return null;
    return parseTimetableCommand(q, { entries: timetableEntries, todayKey });
  }, [query, timetableEntries, todayKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    const parsedCommand: Command[] =
      parsed?.ok
        ? [
            {
              id: `timetable.${parsed.command.kind}`,
              // Echo the resolved date back. The student typed "Thursday 27th";
              // showing the date it landed on is what makes a wrong parse
              // visible BEFORE it is applied rather than after.
              label:
                parsed.command.kind === "cancel"
                  ? `Cancel ${parsed.command.label} on ${formatDay(parsed.command.dateKey)}`
                  : `Restore ${parsed.command.label} on ${formatDay(parsed.command.dateKey)}`,
              hint: "one occurrence only",
              run: () =>
                setOccurrenceCancelled({
                  entryId: parsed.command.entryId,
                  dateKey: parsed.command.dateKey,
                  kind: parsed.command.kind,
                }),
            },
          ]
        : [];

    if (!q) return commands;
    return [
      ...parsedCommand,
      ...commands.filter((c) =>
        `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q),
      ),
    ];
  }, [commands, query, parsed]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const run = useCallback(
    async (command: Command) => {
      setBusy(command.id);
      try {
        await command.run();
        router.refresh();
      } finally {
        setBusy(null);
        close();
      }
    },
    [close, router],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;

      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => Math.min(i + 1, filtered.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter" && filtered[active]) {
        event.preventDefault();
        void run(filtered[active]);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, filtered, active, close, run]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]"
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-app border border-border bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Type a command, or “cancel Thursday 27th teaching”…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-subtle"
          aria-label="Command"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted">
              {/* A parse failure explains itself; a plain miss just says so. */}
              {parsed && !parsed.ok ? parsed.reason : "No matching command"}
            </li>
          )}
          {filtered.map((command, i) => (
            <li key={command.id}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => void run(command)}
                disabled={busy !== null}
                className={cn(
                  "flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm",
                  i === active ? "bg-surface-sunken" : "",
                )}
              >
                <span className="font-medium">{command.label}</span>
                {command.hint && (
                  <span className="text-xs text-subtle">{command.hint}</span>
                )}
                {busy === command.id && (
                  <span className="ml-auto text-xs text-muted">Running…</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** "2026-08-27" -> "Thu 27 Aug". Fixed locale so the echo never surprises. */
function formatDay(dateKey: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}
