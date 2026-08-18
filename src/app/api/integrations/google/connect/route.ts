import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { buildAuthUrl } from "@/lib/integrations/google/oauth";

/** Starts the OAuth dance. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL));

  // CSRF: a random state echoed back by Google and checked against a
  // httpOnly cookie, so a forged callback cannot attach someone else's
  // Google account to this session.
  const state = crypto.randomUUID();
  const jar = await cookies();
  jar.set("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(buildAuthUrl(state));
}
