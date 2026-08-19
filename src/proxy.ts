import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/types/database";

/**
 * Session refresh + route protection.
 *
 * NOTE ON NAMING: in Next.js 16 the `middleware` file convention was renamed
 * to `proxy`. Most Supabase SSR examples still say `middleware.ts` — that file
 * is simply not read by this version. See
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
 */
const PUBLIC_PATHS = ["/", "/login", "/auth"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Refreshed tokens must land on BOTH the onward request and the
          // outgoing response, or the Server Component below this sees the
          // stale session and the browser never receives the new one.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  /*
   * getClaims(), not getSession() and not getUser().
   *
   * getSession() is unsafe here: it trusts a cookie the client fully controls.
   *
   * getUser() is safe but costs a round-trip to the auth server (~250ms) on
   * EVERY navigation, including each RSC fetch. That latency was the whole
   * bug behind "week navigation needs two clicks": the click was working, it
   * just had nothing to show for most of a second.
   *
   * getClaims() verifies the JWT signature and expiry locally against the
   * project's public JWKS (this project signs with ES256), so it needs no
   * network call after the key set is cached.
   *
   * The trade-off is explicit: a session revoked server-side stays accepted
   * here until the access token expires. That is acceptable because this is
   * only a ROUTING gate — it decides whether to show the login page. Actual
   * data access is still authorised by RLS, where PostgREST validates the
   * token on every query. Nothing here grants access to a row.
   */
  const { data: claims } = await supabase.auth.getClaims();
  const user = claims?.claims?.sub ? claims.claims : null;

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Without a matcher this runs on every asset request, which would put an
  // auth round-trip in front of every CSS and image fetch.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
