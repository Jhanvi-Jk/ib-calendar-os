"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  dueReminders,
  reminderBody,
  type RemindableBlock,
} from "@/lib/calendar/reminders";
import {
  reminderPrefsServerSnapshot,
  reminderPrefsSnapshot,
  subscribeReminderPrefs,
} from "@/lib/calendar/reminder-prefs";

/**
 * Fires desktop notifications for upcoming study blocks.
 *
 * Renders nothing. Mounted in the app layout so a reminder arrives whichever
 * page is open, not only the calendar.
 *
 * Honest limitation: this is the Notifications API, not Web Push, so it only
 * fires while the app is open in a tab. Reminders that survive the browser
 * being closed need a service worker and a deployed origin — see the note in
 * ReminderSettings.
 */
export function ReminderScheduler({ blocks }: { blocks: RemindableBlock[] }) {
  const sent = useRef<Set<string>>(new Set());
  const prefs = useSyncExternalStore(
    subscribeReminderPrefs,
    reminderPrefsSnapshot,
    reminderPrefsServerSnapshot,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (!prefs.enabled || Notification.permission !== "granted") return;

    const nowMin = Math.floor(Date.now() / 60_000);
    const due = dueReminders(blocks, {
      nowMin,
      leadMin: prefs.leadMin,
      alreadySent: sent.current,
    });

    const timers = due.map((r) => {
      // setTimeout takes milliseconds from now, and the reminder is expressed
      // as an absolute minute — convert rather than assuming they align.
      const delayMs = Math.max(0, r.fireAt * 60_000 - Date.now());
      return window.setTimeout(() => {
        sent.current.add(r.blockId);
        new Notification(r.title, {
          body: reminderBody(r),
          // Tagging by block means a re-render cannot stack duplicates for the
          // same session — the OS replaces rather than adds.
          tag: `block:${r.blockId}`,
        });
      }, delayMs);
    });

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [blocks, prefs]);

  return null;
}
