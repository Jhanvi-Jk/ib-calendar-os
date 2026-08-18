/**
 * Google OAuth. Server-only — never import from a client component.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Read/write on calendars is unavoidable for two-way sync. We limit the blast
 * radius in code instead: writes only ever target the app-managed calendar
 * (see calendars.is_app_managed).
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    /** True when the grant is dead and only a reconnect will fix it. */
    readonly needsReauth = false,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function config() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleAuthError(
      "Google integration is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI).",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildAuthUrl(state: string): string {
  const { clientId, redirectUri } = config();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // offline + consent is what actually yields a refresh token; without it
    // the integration silently dies an hour after connecting.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export async function exchangeCode(code: string): Promise<TokenSet> {
  const { clientId, clientSecret, redirectUri } = config();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new GoogleAuthError(`Token exchange failed: ${await response.text()}`);
  }
  return parseTokenResponse(await response.json());
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const { clientId, clientSecret } = config();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // invalid_grant means the user revoked access or changed their password.
    // Retrying is pointless; the UI must ask them to reconnect.
    throw new GoogleAuthError(
      `Token refresh failed: ${body}`,
      body.includes("invalid_grant"),
    );
  }

  const tokens = parseTokenResponse(await response.json());
  // Refresh responses omit refresh_token; keep the one we already hold.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

function parseTokenResponse(json: unknown): TokenSet {
  const data = json as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    // 60s of slack so a token cannot expire mid-request.
    expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000),
    scopes: data.scope?.split(" ") ?? [],
  };
}
