import { config } from '../config/index.js';
import { GoTabAdapter } from './gotab.js';
import { MockGoTabAdapter } from './mock-gotab.js';
import type { VendorAdapter } from './types.js';

let instance: VendorAdapter | null = null;

// Returns the configured adapter. The rest of the app calls only this — it never
// imports a concrete adapter class, so the implementation is fully swappable.
export function getVendorAdapter(): VendorAdapter {
  if (instance) return instance;
  instance = config.VENDOR_ADAPTER === 'gotab' ? new GoTabAdapter() : new MockGoTabAdapter();
  return instance;
}

let importInstance: VendorAdapter | null = null;

// Returns an adapter for the GoTab menu-IMPORT path specifically. Import is a
// pure catalog read (listProducts) and is UNBLOCKED even while the fire path is
// blocked — so it always talks to REAL GoTab when credentials are present,
// regardless of VENDOR_ADAPTER. This lets the app run the mock fire path (the
// scheduled-order flow is still blocked on settlement) while still importing
// real menus from the sandbox vendors.
//
// Falls back to the mock adapter ONLY when no GoTab credentials are configured,
// so a dev with no .env secrets can still exercise the import UI end-to-end.
export function getImportAdapter(): VendorAdapter {
  if (importInstance) return importInstance;
  // `||` (not `??`): config coerces blank env values to undefined, and || also
  // treats a stray '' as absent — previously a blank ACCESS_* line made
  // hasCreds falsy and this SILENTLY fell back to the mock while looking
  // configured (review finding #1).
  const hasCreds =
    (config.GOTAB_API_ACCESS_ID || config.GOTAB_API_KEY) &&
    (config.GOTAB_API_ACCESS_SECRET || config.GOTAB_API_SECRET);
  importInstance = hasCreds ? new GoTabAdapter() : new MockGoTabAdapter();
  return importInstance;
}

export type { VendorAdapter } from './types.js';
