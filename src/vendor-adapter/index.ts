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

export type { VendorAdapter } from './types.js';
