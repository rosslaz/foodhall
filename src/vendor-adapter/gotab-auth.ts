import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// GoTab OAuth token manager (Client Credentials flow).
//
// VERIFIED against the sandbox (project doc "Auth — OAuth, CONFIRMED working"):
//   - NOT the OAuth-standard form-encoded grant_type=client_credentials body.
//     GoTab wants a JSON body POST with api_access_id + api_access_secret.
//   - Response: { tokenType: "Bearer", token, refreshToken, expiresIn: 86400,
//     user_id, ... }. Token is a plain Bearer (not base64), 24h TTL.
//   - Error contract: 401 = expired/revoked (retry after refresh); 403 =
//     invalid (do NOT retry without changing the request).
//
// This manager caches the token in memory and refreshes before expiry. A single
// long-lived process (API + worker) shares one instance via getGoTabAuth().

interface TokenResponse {
  tokenType: string;
  token: string;
  refreshToken: string;
  expiresIn: number; // seconds; observed 86400 (24h)
  user_id: number;
}

// Refresh this many ms BEFORE the stated expiry, so an in-flight request never
// races the boundary. 5 min against a 24h TTL is comfortably safe.
const EXPIRY_SKEW_MS = 5 * 60_000;

export interface GoTabCredentials {
  apiAccessId: string;
  apiAccessSecret: string;
  oauthUrl: string;
}

// Resolve credentials from config, preferring the real ACCESS_* field names and
// falling back to the legacy KEY/SECRET placeholders. Throws if neither is set.
// `||` (not `??`) on purpose: config now coerces blank env values to undefined,
// but || also treats a stray '' as absent — belt and braces against the
// empty-string-shadows-populated-legacy-name bug (review finding #1).
export function resolveGoTabCredentials(): GoTabCredentials {
  const apiAccessId = config.GOTAB_API_ACCESS_ID || config.GOTAB_API_KEY;
  const apiAccessSecret = config.GOTAB_API_ACCESS_SECRET || config.GOTAB_API_SECRET;
  if (!apiAccessId || !apiAccessSecret) {
    throw new AppError(
      500,
      'CONFIG',
      'GoTab adapter selected but GOTAB_API_ACCESS_ID/SECRET (or legacy GOTAB_API_KEY/SECRET) are missing',
    );
  }
  return { apiAccessId, apiAccessSecret, oauthUrl: config.GOTAB_OAUTH_URL };
}

export class GoTabAuth {
  private token: string | null = null;
  private userId: number | null = null;
  private expiresAt = 0; // epoch ms
  private inFlight: Promise<string> | null = null;

  constructor(private readonly creds: GoTabCredentials) {}

  // Returns a valid Bearer token, minting or refreshing as needed. Concurrent
  // callers during a refresh share one in-flight request (no thundering herd).
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - EXPIRY_SKEW_MS) {
      return this.token;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.mint().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  // The user_id from the most recent token response. Needed for the GraphQL
  // locationsList query (userByUserId). Null until the first successful mint.
  getUserId(): number | null {
    return this.userId;
  }

  // Force a refresh on the next getToken() — call after a 401 so the retry uses
  // a freshly minted token rather than the cached (now-revoked) one.
  invalidate(): void {
    this.token = null;
    this.expiresAt = 0;
  }

  private async mint(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(this.creds.oauthUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_access_id: this.creds.apiAccessId,
          api_access_secret: this.creds.apiAccessSecret,
        }),
      });
    } catch (err) {
      throw new AppError(502, 'GOTAB_AUTH', `GoTab token request failed: ${String(err)}`);
    }
    if (!res.ok) {
      // 401/403 here mean the credentials themselves are wrong — not something a
      // retry fixes. Surface loudly.
      const body = await res.text().catch(() => '');
      throw new AppError(
        502,
        'GOTAB_AUTH',
        `GoTab token endpoint returned ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as TokenResponse;
    if (!data.token || !data.expiresIn) {
      throw new AppError(502, 'GOTAB_AUTH', 'GoTab token response missing token/expiresIn');
    }
    this.token = data.token;
    this.userId = data.user_id;
    this.expiresAt = Date.now() + data.expiresIn * 1000;
    logger.info(
      { userId: data.user_id, expiresInSec: data.expiresIn },
      'minted GoTab OAuth token',
    );
    return this.token;
  }
}

let instance: GoTabAuth | null = null;

// Process-wide singleton, lazily constructed so importing this module never
// forces credential resolution (tests / mock mode don't need it).
export function getGoTabAuth(): GoTabAuth {
  if (!instance) instance = new GoTabAuth(resolveGoTabCredentials());
  return instance;
}
