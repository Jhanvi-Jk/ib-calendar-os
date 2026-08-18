import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pullCalendar } from "@/lib/integrations/google/sync";

/**
 * Google push notification receiver.
 *
 * Google sends an empty POST with everything in headers. The body carries no
 * data at all — the notification only says "something changed", so we always
 * respond by pulling.
 *
 * This endpoint is public by necessity (Google cannot authenticate as a
 * user), so it must authenticate the CALLER, not a session:
 *   1. X-Goog-Channel-Token must match the secret we supplied at watch time.
 *   2. The channel id must exist in sync_state.
 * Anything else is treated as noise and acknowledged without doing work.
 */
export async function POST(request: NextRequest) {
  const channelId = request.headers.get("x-goog-channel-id");
  const resourceState = request.headers.get("x-goog-resource-state");
  const token = request.headers.get("x-goog-channel-token");

  // Google sends this immediately after watch() is set up. It means nothing
  // changed yet — acknowledging without syncing avoids a pointless full pull.
  if (resourceState === "sync") return new NextResponse(null, { status: 200 });

  if (!channelId || token !== process.env.GOOGLE_WEBHOOK_TOKEN) {
    // 200 rather than 401 on purpose: a non-2xx makes Google retry with
    // backoff and eventually drop the channel. Silently ignoring a forged
    // notification is the safer failure mode.
    return new NextResponse(null, { status: 200 });
  }

  const supabase = createServiceClient();
  const { data: state } = await supabase
    .from("sync_state")
    .select("user_id")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (!state) return new NextResponse(null, { status: 200 });

  const { data: calendar } = await supabase
    .from("calendars")
    .select("id")
    .eq("user_id", state.user_id)
    .eq("is_app_managed", true)
    .maybeSingle();

  if (!calendar) return new NextResponse(null, { status: 200 });

  try {
    await pullCalendar(state.user_id, calendar.id);
  } catch (error) {
    await supabase
      .from("sync_state")
      .update({
        last_error: error instanceof Error ? error.message : String(error),
      })
      .eq("user_id", state.user_id)
      .eq("provider", "google");
  }

  return new NextResponse(null, { status: 200 });
}
