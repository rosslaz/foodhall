// Pure GoTab product-availability classification. Deliberately in its own
// module with NO config/prisma imports so unit tests can exercise it without
// booting the app (same rule and precedent as gotab-status.ts).
//
// EMPIRICALLY VERIFIED mapping (project doc "GoTab product availability
// mapping — VERIFIED", 2026-07-02; probe: scripts/probe-gotab-availability.ts):
// the dashboard's three-state toggle drives orderEnabled and available in
// LOCKSTEP, so neither boolean alone distinguishes "Unavailable" from
// "Hidden". The discriminator is enableTimestamp:
//
//   Available    -> orderEnabled=true,  available=true,  enableTimestamp=null
//   Unavailable  -> orderEnabled=false, available=false, enableTimestamp=SET
//                   (an auto-expiring 86 — GoTab restores the item itself at
//                   that time, observed as early the next service day)
//   Hidden       -> orderEnabled=false, available=false, enableTimestamp=null
//
// CUSTOM productType = back-office payment instruments (Cash Payment,
// Write-Off, ...), never menu items. They also carry the Hidden signature,
// but are classified separately so the caller's intent stays legible.
//
// Recorded caveat: only the dashboard toggle was probed. If some other GoTab
// surface can 86 indefinitely (disabled with NO enableTimestamp), it will
// classify as HIDDEN here — acceptable, since both states mean "do not show
// diners this right now."

export type GoTabProductDisposition =
  | 'AVAILABLE'   // import as orderable
  | 'UNAVAILABLE' // 86'd right now — import, but as available:false locally
  | 'HIDDEN'      // never customer-facing — do not import
  | 'CUSTOM';     // back-office instrument — do not import

export interface GoTabProductAvailabilityFields {
  productType: string | null;
  orderEnabled: boolean | null;
  available: boolean | null;
  enableTimestamp: string | null;
}

export function classifyGoTabProduct(
  p: GoTabProductAvailabilityFields,
): GoTabProductDisposition {
  if ((p.productType ?? '').toUpperCase() === 'CUSTOM') return 'CUSTOM';
  // A missing/null boolean is NOT "disabled" — only an explicit false is.
  const enabled = p.orderEnabled !== false && p.available !== false;
  if (enabled) return 'AVAILABLE';
  return p.enableTimestamp ? 'UNAVAILABLE' : 'HIDDEN';
}
