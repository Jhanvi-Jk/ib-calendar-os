import { createServiceClient } from "@/lib/supabase/server";
import {
  GoogleApiError,
  SyncTokenExpiredError,
  deleteEvent,
  insertEvent,
  listEvents,
  patchEvent,
} from "./api";
import { GoogleAuthError, refreshAccessToken } from "./oauth";
import {
  contentHash,
  isCancelled,
  toGoogleEvent,
  toLocalEvent,
  type GoogleEvent,
} from "./mapping";

/**
 * Two-way Google Calendar sync.
 *
 * Server-only: uses the service-role client because it runs from webhooks and
 * background jobs where there is no user session. Every query is therefore
 * explicitly constrained by user_id — RLS is not doing that work here.
 */

const SYNC_WINDOW_DAYS = 120;

export interface SyncOutcome {
  imported: number;
  updated: number;
  deleted: number;
  echoesSuppressed: number;
  fullResync: boolean;
}

/** Returns a valid access token, refreshing and persisting it if needed. */
export async function getAccessToken(userId: string): Promise<string> {
  const supabase = createServiceClient();
  const { data: account } = await supabase
    .from("integration_accounts")
    .select("access_token, refresh_token, token_expires_at, needs_reauth")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  if (!account) throw new GoogleAuthError("Google is not connected.", true);
  if (account.needs_reauth) {
    throw new GoogleAuthError("Google access was revoked. Reconnect to continue.", true);
  }

  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;
  if (account.access_token && expiresAt && expiresAt > new Date()) {
    return account.access_token;
  }

  if (!account.refresh_token) {
    throw new GoogleAuthError("No refresh token stored. Reconnect Google.", true);
  }

  try {
    const tokens = await refreshAccessToken(account.refresh_token);
    await supabase
      .from("integration_accounts")
      .update({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt.toISOString(),
        needs_reauth: false,
        last_error: null,
      })
      .eq("user_id", userId)
      .eq("provider", "google");
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof GoogleAuthError && error.needsReauth) {
      // Flag it once so the UI can prompt a reconnect rather than retrying
      // a grant that will never succeed again.
      await supabase
        .from("integration_accounts")
        .update({ needs_reauth: true, last_error: error.message })
        .eq("user_id", userId)
        .eq("provider", "google");
    }
    throw error;
  }
}

/**
 * Pulls remote changes into our events table.
 *
 * Incremental when we hold a sync token, full otherwise. A 410 from Google
 * means the token is dead: we clear it and immediately retry as a full sync
 * rather than leaving the calendars silently diverging.
 */
export async function pullCalendar(
  userId: string,
  calendarRowId: string,
  options: { forceFull?: boolean } = {},
): Promise<SyncOutcome> {
  const supabase = createServiceClient();

  const { data: calendar } = await supabase
    .from("calendars")
    .select("id, provider_calendar_id")
    .eq("id", calendarRowId)
    .eq("user_id", userId)
    .single();

  if (!calendar?.provider_calendar_id) {
    throw new Error("Calendar is not linked to a Google calendar.");
  }

  const { data: state } = await supabase
    .from("sync_state")
    .select("sync_token")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  const accessToken = await getAccessToken(userId);
  let syncToken = options.forceFull ? null : (state?.sync_token ?? null);
  let fullResync = !syncToken;

  const outcome: SyncOutcome = {
    imported: 0,
    updated: 0,
    deleted: 0,
    echoesSuppressed: 0,
    fullResync,
  };

  const now = new Date();
  const timeMin = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + SYNC_WINDOW_DAYS * 86_400_000).toISOString();

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let guard = 0;

  while (guard++ < 50) {
    let page;
    try {
      page = await listEvents(accessToken, calendar.provider_calendar_id, {
        syncToken,
        pageToken,
        timeMin,
        timeMax,
      });
    } catch (error) {
      if (error instanceof SyncTokenExpiredError && syncToken) {
        // Restart the whole loop as a full sync exactly once.
        syncToken = null;
        pageToken = undefined;
        fullResync = true;
        outcome.fullResync = true;
        await supabase
          .from("sync_state")
          .update({ sync_token: null })
          .eq("user_id", userId)
          .eq("provider", "google");
        continue;
      }
      throw error;
    }

    for (const event of page.items ?? []) {
      await applyRemoteEvent(userId, calendar.id, event, outcome);
    }

    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  await supabase.from("sync_state").upsert(
    {
      user_id: userId,
      provider: "google",
      sync_token: nextSyncToken ?? null,
      last_full_sync_at: fullResync ? now.toISOString() : undefined,
      consecutive_failures: 0,
      last_error: null,
      updated_at: now.toISOString(),
    },
    { onConflict: "user_id,provider" },
  );

  return outcome;
}

async function applyRemoteEvent(
  userId: string,
  calendarId: string,
  event: GoogleEvent,
  outcome: SyncOutcome,
): Promise<void> {
  const supabase = createServiceClient();

  const { data: mapping } = await supabase
    .from("sync_mappings")
    .select("id, local_id, content_hash, deleted_locally")
    .eq("user_id", userId)
    .eq("provider", "google")
    .eq("remote_id", event.id)
    .maybeSingle();

  if (isCancelled(event)) {
    if (mapping) {
      await supabase.from("events").delete().eq("id", mapping.local_id);
      await supabase.from("sync_mappings").delete().eq("id", mapping.id);
      outcome.deleted++;
    }
    return;
  }

  const draft = toLocalEvent(event);
  if (!draft) return;
  const hash = contentHash(draft);

  // Echo suppression. This event is byte-identical to what we last wrote, so
  // it is our own change coming back. Without this check the two systems
  // would keep "updating" each other indefinitely.
  if (mapping && mapping.content_hash === hash) {
    outcome.echoesSuppressed++;
    return;
  }

  if (mapping) {
    // A locally deleted event that reappears was deleted on our side and not
    // yet pushed; do not resurrect it.
    if (mapping.deleted_locally) return;

    await supabase
      .from("events")
      .update({
        title: draft.title,
        description: draft.description,
        location: draft.location,
        starts_at: draft.startsAt,
        ends_at: draft.endsAt,
        all_day: draft.allDay,
        rrule: draft.rrule,
      })
      .eq("id", mapping.local_id);

    await supabase
      .from("sync_mappings")
      .update({
        content_hash: hash,
        remote_etag: event.etag ?? null,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", mapping.id);

    outcome.updated++;
    return;
  }

  const { data: inserted, error } = await supabase
    .from("events")
    .insert({
      user_id: userId,
      calendar_id: calendarId,
      title: draft.title,
      description: draft.description,
      location: draft.location,
      starts_at: draft.startsAt,
      ends_at: draft.endsAt,
      all_day: draft.allDay,
      tier: draft.tier,
      kind: draft.kind,
      rrule: draft.rrule,
      source: "google",
    })
    .select("id")
    .single();

  // A Tier 1 collision (two overlapping immutable events) is rejected by the
  // database. That is correct — but it must not abort the whole sync run, so
  // record it and move on.
  if (error || !inserted) {
    await supabase
      .from("sync_state")
      .update({ last_error: `Skipped "${draft.title}": ${error?.message}` })
      .eq("user_id", userId)
      .eq("provider", "google");
    return;
  }

  await supabase.from("sync_mappings").insert({
    user_id: userId,
    provider: "google",
    local_table: "events",
    local_id: inserted.id,
    remote_id: event.id,
    remote_etag: event.etag ?? null,
    content_hash: hash,
  });

  outcome.imported++;
}

/**
 * Pushes our scheduled study blocks to Google.
 *
 * Writes are confined to the single app-managed calendar. We never create,
 * modify or delete an event on any other calendar the user has connected —
 * their shared family calendar is not ours to edit.
 */
export async function pushScheduledBlocks(userId: string): Promise<{
  created: number;
  updated: number;
  removed: number;
}> {
  const supabase = createServiceClient();
  const accessToken = await getAccessToken(userId);

  const { data: calendar } = await supabase
    .from("calendars")
    .select("id, provider_calendar_id")
    .eq("user_id", userId)
    .eq("is_app_managed", true)
    .maybeSingle();

  if (!calendar?.provider_calendar_id) {
    throw new Error("No app-managed Google calendar is linked.");
  }
  const remoteCalendarId = calendar.provider_calendar_id;

  const { data: run } = await supabase
    .from("schedule_runs")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();

  const { data: blocks } = run
    ? await supabase
        .from("scheduled_blocks")
        .select("id, starts_at, ends_at, tasks(title)")
        .eq("run_id", run.id)
    : { data: [] };

  const { data: mappings } = await supabase
    .from("sync_mappings")
    .select("id, local_id, remote_id, remote_etag, content_hash")
    .eq("user_id", userId)
    .eq("provider", "google")
    .eq("local_table", "scheduled_blocks");

  const existing = new Map((mappings ?? []).map((m) => [m.local_id, m]));
  const seen = new Set<string>();
  let created = 0;
  let updated = 0;
  let removed = 0;

  for (const block of blocks ?? []) {
    seen.add(block.id);
    const title = block.tasks?.title ?? "Study";
    const draft = {
      title,
      description: "Scheduled by IB Calendar OS",
      location: null,
      startsAt: new Date(block.starts_at).toISOString(),
      endsAt: new Date(block.ends_at).toISOString(),
      allDay: false,
      tier: 3 as const,
      kind: "general" as const,
      rrule: null,
    };
    const hash = contentHash(draft);
    const mapping = existing.get(block.id);

    if (mapping && mapping.content_hash === hash) continue;

    try {
      if (mapping) {
        const result = await patchEvent(
          accessToken,
          remoteCalendarId,
          mapping.remote_id,
          toGoogleEvent(draft),
          mapping.remote_etag,
        );
        await supabase
          .from("sync_mappings")
          .update({
            content_hash: hash,
            remote_etag: result.etag ?? null,
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", mapping.id);
        updated++;
      } else {
        const result = await insertEvent(
          accessToken,
          remoteCalendarId,
          toGoogleEvent(draft),
        );
        await supabase.from("sync_mappings").insert({
          user_id: userId,
          provider: "google",
          local_table: "scheduled_blocks",
          local_id: block.id,
          remote_id: result.id,
          remote_etag: result.etag ?? null,
          content_hash: hash,
        });
        created++;
      }
    } catch (error) {
      // 412 means someone edited the event on another device since we read it.
      // Leave theirs alone; the next pull reconciles.
      if (error instanceof GoogleApiError && error.status === 412) continue;
      throw error;
    }
  }

  // Blocks from superseded runs no longer exist locally, so retire them
  // remotely too — otherwise last week's abandoned plan lingers forever.
  for (const [localId, mapping] of existing) {
    if (seen.has(localId)) continue;
    try {
      await deleteEvent(accessToken, remoteCalendarId, mapping.remote_id);
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.status !== 404) throw error;
    }
    await supabase.from("sync_mappings").delete().eq("id", mapping.id);
    removed++;
  }

  return { created, updated, removed };
}
