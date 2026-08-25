"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import {
  notificationPermission,
  notificationPermissionServerSnapshot,
  refreshNotificationPermission,
  subscribeNotificationPermission,
  reminderPrefsServerSnapshot,
  reminderPrefsSnapshot,
  saveReminderPrefs,
  subscribeReminderPrefs,
  type ReminderPrefs,
} from "@/lib/calendar/reminder-prefs";

const LEAD_OPTIONS = [0, 5, 10, 15, 30];

export function ReminderSettings() {
  const prefs = useSyncExternalStore(
    subscribeReminderPrefs,
    reminderPrefsSnapshot,
    reminderPrefsServerSnapshot,
  );

  // A store, not useState: the server has no Notification object, so reading
  // it directly renders different markup on each side and React throws a
  // hydration mismatch.
  const permission = useSyncExternalStore(
    subscribeNotificationPermission,
    notificationPermission,
    notificationPermissionServerSnapshot,
  );

  const save = useCallback((next: ReminderPrefs) => saveReminderPrefs(next), []);

  async function enable() {
    // Browsers only honour a permission prompt raised from a real click, which
    // is why this is a button and not something that happens on page load.
    const result = await Notification.requestPermission();
    refreshNotificationPermission();
    if (result === "granted") save({ ...prefs, enabled: true });
  }

  return (
    <section className="rounded-app border border-border bg-surface p-5">
      <h2 className="text-base font-semibold tracking-tight">Reminders</h2>
      <p className="mt-1 text-sm text-muted">
        A desktop notification shortly before a study block starts.
      </p>

      {permission === "unsupported" ? (
        <p className="mt-4 text-sm text-muted">This browser cannot show notifications.</p>
      ) : permission === "denied" ? (
        <p className="mt-4 text-sm text-danger">
          Notifications are blocked for this site. Allow them in your browser&apos;s
          site settings, then reload this page.
        </p>
      ) : permission !== "granted" ? (
        <Button className="mt-4" variant="primary" onClick={enable}>
          Turn on reminders
        </Button>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => save({ ...prefs, enabled: e.target.checked })}
              className="h-5 w-5 rounded border-border"
            />
            Remind me before a block starts
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="lead" className="text-sm text-muted">
              How much warning
            </label>
            <select
              id="lead"
              value={prefs.leadMin}
              disabled={!prefs.enabled}
              onChange={(e) => save({ ...prefs, leadMin: Number(e.target.value) })}
              className="h-10 rounded-app border border-border bg-surface px-2 text-sm"
            >
              {LEAD_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "At the start" : `${m} minutes before`}
                </option>
              ))}
            </select>

            <Button
              size="sm"
              onClick={() =>
                new Notification("Physics HL study", {
                  body: `Starts in ${prefs.leadMin} minutes.`,
                  tag: "ibcal:test",
                })
              }
            >
              Send a test
            </Button>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-subtle">
        These only arrive while IB Calendar OS is open in a tab, and the setting
        is per browser — notification permission is granted per device, so a
        synced setting would promise reminders on a laptop that had never been
        asked. Reminders that survive the browser being closed need the app
        deployed with push notifications.
      </p>
    </section>
  );
}
