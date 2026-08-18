import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { FocusSession } from "@/components/focus/FocusSession";
import { getActiveRun, getUserContext } from "@/lib/data/queries";
import { getRunningTimer } from "@/lib/data/analytics";
import { createClient } from "@/lib/supabase/server";
import { toEpochMinute } from "@/lib/time";

/**
 * Focus mode — one block, nothing else.
 *
 * Shows whatever the schedule says is happening now, with its linked context
 * one click away. Navigation is deliberately absent: this page is meant to be
 * the only thing on screen.
 */
export default async function FocusPage() {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const [run, timer] = await Promise.all([getActiveRun(), getRunningTimer()]);
  const nowMin = toEpochMinute(new Date());

  const current =
    run?.blocks.find((b) => b.startsAt <= nowMin && b.endsAt > nowMin) ??
    run?.blocks.find((b) => b.startsAt > nowMin);

  if (!current) {
    return (
      <div className="mx-auto max-w-xl py-16">
        <EmptyState title="Nothing scheduled right now">
          <Link href="/calendar" className="underline">
            Generate a plan
          </Link>{" "}
          to get started.
        </EmptyState>
      </div>
    );
  }

  const supabase = await createClient();
  const { data: task } = await supabase
    .from("tasks")
    .select("id, title, notes, context_uri, context_label, remaining_min")
    .eq("id", current.taskId)
    .single();

  return (
    <FocusSession
      taskId={current.taskId}
      title={task?.title ?? current.taskTitle}
      notes={task?.notes ?? null}
      contextUri={task?.context_uri ?? null}
      contextLabel={task?.context_label ?? null}
      remainingMin={task?.remaining_min ?? 0}
      startsAt={current.startsAt}
      endsAt={current.endsAt}
      timezone={ctx.timezone}
      isRunning={timer?.taskId === current.taskId}
      startsInFuture={current.startsAt > nowMin}
    />
  );
}
