import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Request-scoped client. Carries the user's session, so every query runs
 * under RLS as that user. This is the default — reach for it unless you have
 * a specific reason not to.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot set cookies. Session refresh happens in
            // proxy.ts, so this is safe to swallow.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only two callers are legitimate:
 *   1. Integration webhooks (Google/Notion), which arrive with no user session.
 *   2. Background jobs (channel renewal, calibration, momentum rollups).
 *
 * Never call this from a path that a browser can reach with user-supplied
 * filters — you would be hand-rolling the authorization that RLS gives free.
 * Always constrain queries by an explicit user_id.
 */
export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
