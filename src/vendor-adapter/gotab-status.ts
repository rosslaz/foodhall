import type { VendorTicketStatus } from './types.js';

// Pure GoTab-status -> VendorTicketStatus mapping. Deliberately in its own
// module with NO config/auth/client imports, so unit tests can exercise it
// without loading the app config (which process.exit()s when DB/Redis/JWT env
// vars are absent, e.g. the non-integration test runner).
//
// Precedence: a set `prepared` timestamp means the kitchen finished, regardless
// of the status string; otherwise map the status enum.
//
// NOTE: the GoTab status strings are from support correspondence + docs and must
// be re-verified against the live schema once a real order can be queried
// (blocked today by the tab-creation/settlement issue — see gotab.ts header).
export function mapGoTabStatus(
  status: string | null,
  prepared: string | null,
): VendorTicketStatus {
  if (prepared) return 'READY';
  switch ((status ?? '').toUpperCase()) {
    case 'PENDING':
    case 'SCHEDULED':
      return 'SCHEDULED';
    case 'SENT':
    case 'IN_TRANSIT':
      return 'IN_PROGRESS';
    case 'DELIVERED':
      return 'READY';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    default:
      // Unknown/missing status on an order that exists but isn't prepared:
      // treat as SCHEDULED (accepted, not yet fired) rather than guessing further.
      return 'SCHEDULED';
  }
}
