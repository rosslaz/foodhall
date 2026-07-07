import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { GoTabAuth } from './gotab-auth.js';

// Thin authenticated HTTP client for GoTab. Handles the confirmed auth error
// contract and the URL-encoding gotcha for location/product UUIDs.
//
// UUID CAUTION (project doc "CAUTION: the parent and Motor UUIDs contain a
// literal ~"): some GoTab UUIDs contain a literal (sometimes doubled) `~`.
// They must be URL-encoded when placed in a REST path segment. They are safe
// as-is inside GraphQL JSON variable values (that's request body, not a path).
export function encodeLocationSegment(locationUuid: string): string {
  return encodeURIComponent(locationUuid);
}

// ── Process-wide request pacing ───────────────────────────────────────
// GoTab enforces 4 requests/second (429 "exceeded the threshold of 4rps",
// observed 2026-07-07 during introspection bursts). This gate is MODULE-level,
// deliberately shared across every GoTabClient instance in the process
// (adapter + import adapter), and reserves send slots synchronously — safe in
// single-threaded JS — spacing request STARTS ≥280ms apart (≈3.5 rps).
const MIN_REQUEST_SPACING_MS = 280;
let nextSlotAt = 0;
function paceRequest(): Promise<void> {
  const slot = Math.max(Date.now(), nextSlotAt);
  nextSlotAt = slot + MIN_REQUEST_SPACING_MS;
  const wait = slot - Date.now();
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

export class GoTabClient {
  constructor(private readonly auth: GoTabAuth) {}

  // POST a location-scoped REST route: /api/loc/{locationUuid}/{path}.
  // Retries ONCE on 401 (expired/revoked token) after forcing a token refresh,
  // per the error contract (401 = retry after refresh; 403 = do not retry).
  async locPost<T = unknown>(
    locationUuid: string,
    path: string,
    body: unknown,
  ): Promise<T> {
    const base = config.GOTAB_API_BASE ?? 'https://gotab.io';
    const url = `${base}/api/loc/${encodeLocationSegment(locationUuid)}/${path}`;
    return this.postJson<T>(url, body);
  }

  // POST the GraphQL endpoint. UUIDs travel in `variables` (body), so no
  // path-encoding concern here.
  async graph<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.postJson<{ data?: T; errors?: unknown }>(
      config.GOTAB_GRAPH_URL,
      { query, variables },
    );
    if (res.errors) {
      throw new AppError(
        502,
        'GOTAB_GRAPH',
        `GoTab GraphQL errors: ${JSON.stringify(res.errors).slice(0, 300)}`,
      );
    }
    return res.data as T;
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    retried: { auth?: boolean; rate?: boolean } = {},
  ): Promise<T> {
    await paceRequest();
    const token = await this.auth.getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AppError(502, 'GOTAB_HTTP', `GoTab request to ${url} failed: ${String(err)}`);
    }

    if (res.status === 401 && !retried.auth) {
      // Expired/revoked — refresh once and retry exactly one time.
      logger.warn({ url }, 'GoTab 401 — refreshing token and retrying once');
      this.auth.invalidate();
      return this.postJson<T>(url, body, { ...retried, auth: true });
    }
    if (res.status === 429 && !retried.rate) {
      // Rate limited (4rps ceiling). Retryable by contract — back off past a
      // full pacing window and retry exactly once; a second 429 surfaces.
      logger.warn({ url }, 'GoTab 429 — backing off 1.2s and retrying once');
      await new Promise((r) => setTimeout(r, 1200));
      return this.postJson<T>(url, body, { ...retried, rate: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 403 = invalid request (don't retry); anything else surfaces too.
      throw new AppError(
        502,
        'GOTAB_HTTP',
        `GoTab ${res.status} from ${url}: ${text.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }
}
