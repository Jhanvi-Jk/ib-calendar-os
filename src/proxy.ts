import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  const supabase = createServerClient(
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

  // Must be getUser(), not getSession(): only getUser() revalidates the JWT
  // against the auth server. getSession() trusts a cookie the client controls.
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
