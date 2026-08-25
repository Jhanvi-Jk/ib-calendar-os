/**
 * Reminder preferences live in localStorage, not the database.
 *
 * Deliberate: notification permission is granted per browser, so a setting
 * synced across devices would promise reminders on a laptop that had never
 * been asked. The preference belongs where the permission does.
 */
export const REMINDER_STORAGE = "ibcal.reminders";

export interface ReminderPrefs {
  enabled: boolean;
  leadMin: number;
}

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = { enabled: false, leadMin: 10 };

/**
 * Pure so the awkward inputs have tests: absent, corrupt, hand-edited, or
 * carrying a lead time that would arm a timer for next week.
 */
export function parseReminderPrefs(raw: string | null): ReminderPrefs {
  if (!raw) return DEFAULT_REMINDER_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<ReminderPrefs>;
    // `Number(x) || 10` would turn a legitimate 0 into 10, silently overriding
    // "At the start" — which is an option the UI actually offers.
    const lead = Number(parsed.leadMin);
    return {
      enabled: Boolean(parsed.enabled),
      // Clamp: a corrupted or hand-edited value must not arm a timer days out.
      leadMin: Number.isFinite(lead) ? Math.min(120, Math.max(0, lead)) : 10,
    };
  } catch {
    return DEFAULT_REMINDER_PREFS;
  }
}

export function readReminderPrefs(): ReminderPrefs {
  if (typeof window === "undefined") return DEFAULT_REMINDER_PREFS;
  return parseReminderPrefs(window.localStorage.getItem(REMINDER_STORAGE));
}

export function writeReminderPrefs(prefs: ReminderPrefs): void {
  window.localStorage.setItem(REMINDER_STORAGE, JSON.stringify(prefs));
}

// ---------------------------------------------------------------------------
// External store
//
// localStorage is mutable state living outside React, which is exactly what
// useSyncExternalStore is for. Reading it in an effect and calling setState
// works but tears on hydration and trips react-hooks/set-state-in-effect.
//
// getSnapshot MUST return a stable reference while the underlying string is
// unchanged, or React re-renders forever. Hence the cache on the raw value.
// ---------------------------------------------------------------------------

let cachedRaw: string | null | undefined;
let cachedPrefs: ReminderPrefs = DEFAULT_REMINDER_PREFS;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribeReminderPrefs(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function reminderPrefsSnapshot(): ReminderPrefs {
  const raw = window.localStorage.getItem(REMINDER_STORAGE);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefs = readReminderPrefs();
  }
  return cachedPrefs;
}

/** The server has no localStorage; reminders are off until proven otherwise. */
export function reminderPrefsServerSnapshot(): ReminderPrefs {
  return DEFAULT_REMINDER_PREFS;
}

export function saveReminderPrefs(prefs: ReminderPrefs): void {
  writeReminderPrefs(prefs);
  emit();
}

// ---------------------------------------------------------------------------
// Notification permission, also as a store.
//
// It must NOT be `useState(() => Notification.permission)`: the server has no
// Notification object, so it renders "unsupported" while the client renders a
// button, and React throws a hydration mismatch. useSyncExternalStore is built
// for values that legitimately differ between server and client — it renders
// the server snapshot during hydration and swaps afterwards without
// complaining.
//
// The snapshot is a primitive string, so no caching is needed for stability.
// ---------------------------------------------------------------------------

const permissionListeners = new Set<() => void>();

export function subscribeNotificationPermission(onChange: () => void): () => void {
  permissionListeners.add(onChange);
  return () => permissionListeners.delete(onChange);
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

/** Nothing to report before hydration; the real value arrives immediately after. */
export function notificationPermissionServerSnapshot(): NotificationPermission | "unsupported" {
  return "default";
}

/** Call after requestPermission() — the browser fires no event of its own. */
export function refreshNotificationPermission(): void {
  for (const l of permissionListeners) l();
}
