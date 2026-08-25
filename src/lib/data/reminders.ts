import { cache } from "react";
import { getActiveRun } from "@/lib/data/queries";
import { toEpochMinute } from "@/lib/time";
import type { RemindableBlock } from "@/lib/calendar/reminders";

/**
 * Blocks close enough to be worth arming a notification for.
 *
 * Bounded to the next 12 hours: the layout re-renders on every navigation, so
 * there is no need to hold timers for tomorrow, and holding them would mean a
 * tab left open overnight firing reminders for a plan that has since changed.
 */
export const getUpcomingBlocks = cache(async (): Promise<RemindableBlock[]> => {
  const run = await getActiveRun();
  if (!run) return [];

  const nowMin = toEpochMinute(new Date());
  const horizon = nowMin + 12 * 60;

  return run.blocks
    .filter((b) => b.startsAt > nowMin && b.startsAt <= horizon)
    .map((b) => ({ id: b.id, title: b.taskTitle, startsAt: b.startsAt }))
    .sort((a, b) => a.startsAt - b.startsAt);
});
