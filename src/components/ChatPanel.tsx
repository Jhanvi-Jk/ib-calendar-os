"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyChatIntent } from "@/app/(app)/calendar/chat-actions";
import { parseChatCommand, type ChatIntent } from "@/lib/commands/chat";
import type { CommandEntry } from "@/lib/commands/timetable-commands";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Tell the planner what happened, in words.
 *
 * Not a chatbot. Every sentence goes through a tested parser over a closed
 * grammar, so there is no API key, nothing that can invent a date, and the
 * rule that the model never writes to the database stays true because there
 * is no model.
 *
 * Nothing is applied on the strength of the parse alone. The panel says back
 * what it understood — real times, a real date, the real lesson name — and
 * waits. A misreading is then caught before it moves an evening, not after.
 */

interface Turn {
  from: "you" | "app";
  text: string;
}

const EXAMPLES = [
  "block 7 to 9 tonight for family",
  "cancel Thursday teaching",
  "finished physics early",
  "i'm sick today",
];

export function ChatPanel({
  entries,
  todayKey,
}: {
  entries: CommandEntry[];
  todayKey: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pendingIntent, setPendingIntent] = useState<ChatIntent | null>(null);
  const [busy, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const say = (from: Turn["from"], text: string) =>
    setTurns((prev) => [...prev, { from, text }]);

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    say("you", trimmed);
    setDraft("");
    setPendingIntent(null);

    const result = parseChatCommand(trimmed, { entries, todayKey });
    if (!result.ok) {
      say("app", result.reason);
      return;
    }
    // Confirm before writing. This is the difference between a planner you can
    // trust with your evening and one you have to check afterwards.
    say("app", result.summary);
    setPendingIntent(result.intent);
  }

  function confirm() {
    const intent = pendingIntent;
    if (!intent) return;
    setPendingIntent(null);
    startTransition(async () => {
      const res = await applyChatIntent(intent);
      say("app", res.ok ? res.message : `That didn't work: ${res.error}`);
      if (res.ok) router.refresh();
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className="fixed bottom-5 right-5 z-40 flex h-12 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm font-medium shadow-lg hover:bg-surface-sunken"
      >
        Tell the planner
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex max-h-[70vh] w-[min(24rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-app border border-border bg-surface shadow-lg">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold">Tell the planner</span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {turns.length === 0 && (
          <div className="space-y-2 text-muted">
            <p>Say what changed and the plan moves around it. For example:</p>
            <ul className="space-y-1">
              {EXAMPLES.map((e) => (
                <li key={e}>
                  <button
                    type="button"
                    onClick={() => submit(e)}
                    className="rounded-app px-1.5 py-0.5 text-left text-subtle underline-offset-2 hover:bg-surface-sunken hover:underline"
                  >
                    {e}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {turns.map((t, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[90%] rounded-app px-3 py-2",
              t.from === "you"
                ? "ml-auto bg-primary-soft text-text"
                : "bg-surface-sunken text-text",
            )}
          >
            {t.text}
          </div>
        ))}

        {pendingIntent && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={confirm}>
              {busy ? "Doing it…" : "Do it"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPendingIntent(null);
                say("app", "Left it alone.");
              }}
            >
              No
            </Button>
          </div>
        )}
      </div>

      <form
        className="border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="block 7 to 9 tonight for family"
          aria-label="Tell the planner what changed"
          className="h-10 w-full rounded-app border border-border bg-surface px-3 text-sm outline-none placeholder:text-subtle"
        />
      </form>
    </div>
  );
}
