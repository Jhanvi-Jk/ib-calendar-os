import { createServiceClient } from "@/lib/supabase/server";
import { fnv1a, canonicalize } from "@/lib/scheduling/hash";
import { scanForInjection } from "@/lib/ai/extract";
import {
  inferPropertyMap,
  toTaskDraft,
  type NotionPage,
  type NotionTaskDraft,
} from "./mapping";

/**
 * Notion → tasks, one-way.
 *
 * Deliberately one-way. Notion is a place students keep their own notes; the
 * scheduler owns timing, and writing our scheduling decisions back into
 * someone's personal Notion database is not ours to do.
 */

const NOTION_VERSION = "2022-06-28";
const BASE = "https://api.notion.com/v1";
/** Notion's documented ceiling is ~3 requests/second. */
const MIN_REQUEST_GAP_MS = 350;

let lastRequestAt = 0;

async function notionFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return notionFetch<T>(token, path, init);
  }
  if (!response.ok) {
    throw new Error(`Notion ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export interface NotionSyncResult {
  imported: number;
  updated: number;
  skipped: number;
  suspiciousPages: Array<{ title: string; quote: string }>;
}

export async function syncNotionDatabase(
  userId: string,
  databaseId: string,
): Promise<NotionSyncResult> {
  const supabase = createServiceClient();

  const { data: account } = await supabase
    .from("integration_accounts")
    .select("access_token")
    .eq("user_id", userId)
    .eq("provider", "notion")
    .maybeSingle();

  if (!account?.access_token) throw new Error("Notion is not connected.");
  const token = account.access_token;

  const database = await notionFetch<{
    properties: Record<string, { type: string }>;
  }>(token, `/databases/${databaseId}`);

  const map = inferPropertyMap(database.properties);
  if (!map) throw new Error("That Notion database has no title property.");

  const result: NotionSyncResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    suspiciousPages: [],
  };

  let cursor: string | undefined;
  let guard = 0;

  while (guard++ < 50) {
    const page = await notionFetch<{
      results: NotionPage[];
      next_cursor: string | null;
      has_more: boolean;
    }>(token, `/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
    });

    for (const row of page.results) {
      if (row.archived) continue;
      const draft = toTaskDraft(row, map);
      if (!draft) {
        result.skipped++;
        continue;
      }
      await applyDraft(userId, draft, result);
    }

    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  await supabase.from("sync_state").upsert(
    {
      user_id: userId,
      provider: "notion",
      cursor: databaseId,
      last_full_sync_at: new Date().toISOString(),
      consecutive_failures: 0,
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );

  return result;
}

async function applyDraft(
  userId: string,
  draft: NotionTaskDraft,
  result: NotionSyncResult,
): Promise<void> {
  const supabase = createServiceClient();

  // A shared Notion database is something other people can write to, so page
  // titles are untrusted input just like a syllabus PDF.
  const findings = scanForInjection(draft.title);
  if (findings.length > 0) {
    result.suspiciousPages.push({ title: draft.title, quote: findings[0].quote });
    result.skipped++;
    return;
  }

  const hash = fnv1a(
    canonicalize({
      title: draft.title,
      deadlineIso: draft.deadlineIso,
      estimateMin: draft.estimateMin,
      isDone: draft.isDone,
    }),
  );

  const { data: mapping } = await supabase
    .from("sync_mappings")
    .select("id, local_id, content_hash")
    .eq("user_id", userId)
    .eq("provider", "notion")
    .eq("remote_id", draft.remoteId)
    .maybeSingle();

  if (mapping?.content_hash === hash) return;

  const patch = {
    title: draft.title,
    deadline_at: draft.deadlineIso,
    ...(draft.estimateMin ? { estimate_min: draft.estimateMin } : {}),
    ...(draft.isDone ? { status: "done" as const } : {}),
  };

  if (mapping) {
    await supabase.from("tasks").update(patch).eq("id", mapping.local_id);
    await supabase
      .from("sync_mappings")
      .update({ content_hash: hash, last_synced_at: new Date().toISOString() })
      .eq("id", mapping.id);
    result.updated++;
    return;
  }

  // Never import work that is already finished — it would land as a task the
  // student has to dismiss for no reason.
  if (draft.isDone) {
    result.skipped++;
    return;
  }

  const { data: inserted, error } = await supabase
    .from("tasks")
    .insert({
      user_id: userId,
      title: draft.title,
      deadline_at: draft.deadlineIso,
      estimate_min: draft.estimateMin ?? 60,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    result.skipped++;
    return;
  }

  await supabase.from("sync_mappings").insert({
    user_id: userId,
    provider: "notion",
    local_table: "tasks",
    local_id: inserted.id,
    remote_id: draft.remoteId,
    content_hash: hash,
  });
  result.imported++;
}
