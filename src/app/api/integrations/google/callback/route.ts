import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { exchangeCode } from "@/lib/integrations/google/oauth";
import { createCalendar, listCalendars } from "@/lib/integrations/google/api";

const APP_CALENDAR_NAME = "IB Calendar OS";

export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
  const fail = (reason: string) =>
    NextResponse.redirect(`${appUrl}/settings?google_error=${encodeURIComponent(reason)}`);

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) return fail("missing_code");

  const jar = await cookies();
  const expected = jar.get("google_oauth_state")?.value;
  if (!expected || expected !== state) return fail("state_mismatch");
  jar.delete("google_oauth_state");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("not_signed_in");

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch {
    return fail("token_exchange_failed");
  }

  // Service role: integration_accounts is deliberately unreachable under RLS.
  const service = createServiceClient();
  await service.from("integration_accounts").upsert(
    {
      user_id: user.id,
      provider: "google",
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt.toISOString(),
      scopes: tokens.scopes,
      needs_reauth: false,
      last_error: null,
    },
    { onConflict: "user_id,provider" },
  );

  // Find or create the one calendar we are allowed to write to. Everything
  // else the user has connected stays read-only.
  try {
    const { items } = await listCalendars(tokens.accessToken);
    let target = items?.find((c) => c.summary === APP_CALENDAR_NAME);
    if (!target) {
      const made = await createCalendar(tokens.accessToken, APP_CALENDAR_NAME);
      target = { id: made.id, summary: made.summary, accessRole: "owner" };
    }

    await service
      .from("calendars")
      .update({
        provider: "google",
        provider_calendar_id: target.id,
        is_writable: true,
      })
      .eq("user_id", user.id)
      .eq("is_app_managed", true);
  } catch {
    return fail("calendar_setup_failed");
  }

  return NextResponse.redirect(`${appUrl}/settings?google=connected`);
}
