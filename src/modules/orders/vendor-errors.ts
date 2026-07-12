// Pure classification of vendor-submit errors: TERMINAL (retrying cannot
// succeed — mark the ticket FAILED, cancel the group visibly) vs RETRYABLE
// (transient — let BullMQ/backoff and the sweep do their jobs). No config or
// prisma imports (unit-test rule; precedent: gotab-status.ts).
//
// TERMINAL (review H1/M1, 2026-07-08):
//   - Any AppError with a 4xx statusCode: these are config/validation
//     failures the adapter raised deliberately (GOTAB_UNMAPPED_ITEMS,
//     GOTAB_NO_SPOT, GOTAB_BAD_ORDER_ID) or GoTab rejected structurally.
//     Retrying reproduces them forever while diners watch a countdown.
//   - GOTAB_NO_ORDER_ID specifically (a 502): GoTab likely ACCEPTED the tab
//     but we couldn't read the order id — retrying risks creating a DUPLICATE
//     kitchen order (review M1). Terminal-investigate: the log carries the
//     tab context.
//
// RETRYABLE (everything else): network failures, 5xx, rate-limit exhaustion
// (the client wraps a persisted 429 as a 502 GOTAB_HTTP), unknown errors.
// Note: persistent credential failure (401→401) also lands here as a 502 and
// will retry — acceptable: creds breakage is ops-loud and self-heals on fix.

import { AppError } from '../../lib/errors.js';

export function isTerminalVendorError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.code === 'GOTAB_NO_ORDER_ID') return true;
  return err.statusCode >= 400 && err.statusCode < 500;
}
