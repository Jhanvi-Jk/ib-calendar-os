import type { GoogleEvent } from "./mapping";

const BASE = "https://www.googleapis.com/calendar/v3";

/**
 * Raised when Google invalidates our incremental sync token. The only correct
 * response is to discard the token and perform a full resync — retrying with
 * the dead token loops forever, and ignoring it silently drifts the calendars
 * apart. This is the single most common way two-way sync rots.
 */
export class SyncTokenExpiredError extends Error {
  constructor() {
    super("Google sync token expired (HTTP 410); a full resync is required.");
    this.name = "SyncTokenExpiredError";
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

async function request<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 410) throw new SyncTokenExpiredError();
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    throw new GoogleApiError(response.status, await response.text());
  }
  return (await response.json()) as T;
}

export interface EventListPage {
  items: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export async function listEvents(
  accessToken: string,
  calendarId: string,
  params: {
    syncToken?: string | null;
    pageToken?: string;
    timeMin?: string;
    timeMax?: string;
  },
): Promise<EventListPage> {
  const query = new URLSearchParams({ maxResults: "250", singleEvents: "true" });

  if (params.syncToken) {
    // Google rejects a request that mixes syncToken with time filters, so the
    // incremental and full-sync paths must stay strictly separate.
    query.set("syncToken", params.syncToken);
  } else {
    if (params.timeMin) query.set("timeMin", params.timeMin);
    if (params.timeMax) query.set("timeMax", params.timeMax);
    query.set("showDeleted", "false");
  }
  if (params.pageToken) query.set("pageToken", params.pageToken);

  return request<EventListPage>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
  );
}

export async function insertEvent(
  accessToken: string,
  calendarId: string,
  body: Record<string, unknown>,
): Promise<GoogleEvent> {
  return request<GoogleEvent>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: Record<string, unknown>,
  etag?: string | null,
): Promise<GoogleEvent> {
  return request<GoogleEvent>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      // Optimistic concurrency: fail rather than clobber a change made on the
      // user's phone between our read and our write.
      headers: etag ? { "If-Match": etag } : {},
    },
  );
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  await request<void>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}

export async function listCalendars(accessToken: string) {
  return request<{ items: Array<{ id: string; summary: string; accessRole: string }> }>(
    accessToken,
    "/users/me/calendarList",
  );
}

export async function createCalendar(accessToken: string, summary: string) {
  return request<{ id: string; summary: string }>(accessToken, "/calendars", {
    method: "POST",
    body: JSON.stringify({ summary }),
  });
}

export interface WatchChannel {
  id: string;
  resourceId: string;
  expiration?: string;
}

/** Subscribes to push notifications for a calendar. */
export async function watchCalendar(
  accessToken: string,
  calendarId: string,
  channelId: string,
  webhookUrl: string,
  token: string,
): Promise<WatchChannel> {
  return request<WatchChannel>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: "POST",
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        // Echoed back in X-Goog-Channel-Token so the webhook can verify the
        // notification is ours before acting on it.
        token,
      }),
    },
  );
}

export async function stopChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  await request<void>(accessToken, "/channels/stop", {
    method: "POST",
    body: JSON.stringify({ id: channelId, resourceId }),
  });
}
