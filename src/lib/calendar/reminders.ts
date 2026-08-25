/**
 * Which upcoming blocks deserve a notification, and when.
 *
 * Kept pure so the awkward parts — a tab opened three minutes before a
 * session, a block that already started, a timer set for tomorrow — are
 * decided by something with tests rather than by arithmetic scattered through
 * a useEffect.
 *
 * The bar for interrupting someone is high. A notification for work that has
 * already begun is nagging, not help, so those are dropped rather than fired
 * late.
 */

export interface RemindableBlock {
  id: string;
  title: string;
  /** Epoch minutes. */
  startsAt: number;
}

export interface Reminder {
  blockId: string;
  title: string;
  startsAt: number;
  /** Epoch minute the notification should appear. Never in the past. */
  fireAt: number;
  /** Whole minutes between firing and the session starting. */
  leadMin: number;
}

export function dueReminders(
  blocks: RemindableBlock[],
  options: {
    nowMin: number;
    leadMin: number;
    /** How far ahead to arm timers. Beyond this the page will have re-rendered. */
    horizonMin?: number;
    /** Blocks already notified this session — never notify twice. */
    alreadySent?: ReadonlySet<string>;
  },
): Reminder[] {
  const { nowMin, leadMin, horizonMin = 12 * 60, alreadySent } = options;

  return blocks
    .filter((b) => !alreadySent?.has(b.id))
    // Already under way. Telling someone their session "starts in 10 minutes"
    // when they are twenty minutes into it is worse than saying nothing.
    .filter((b) => b.startsAt > nowMin)
    .filter((b) => b.startsAt - leadMin <= nowMin + horizonMin)
    .map((b) => {
      // A tab opened inside the lead window still gets its reminder, now,
      // rather than having missed it.
      const fireAt = Math.max(nowMin, b.startsAt - leadMin);
      return {
        blockId: b.id,
        title: b.title,
        startsAt: b.startsAt,
        fireAt,
        leadMin: b.startsAt - fireAt,
      };
    })
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** "in 10 minutes" / "now" — the body of the notification. */
export function reminderBody(reminder: Reminder): string {
  if (reminder.leadMin <= 0) return "Starting now.";
  if (reminder.leadMin === 1) return "Starts in a minute.";
  return `Starts in ${reminder.leadMin} minutes.`;
}
