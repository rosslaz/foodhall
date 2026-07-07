import { describe, expect, it } from 'vitest';
import { classifyGoTabProduct } from './gotab-availability.js';
import { chooseSubmitSpot } from './gotab-spot.js';
import { mapGoTabStatus } from './gotab-status.js';

// Pure mapping tests — no network. Locks the GoTab-status -> VendorTicketStatus
// contract. NOTE: the GoTab status strings here are from support correspondence
// + docs and must be re-verified against the live schema once a real order can
// be queried (blocked today by the tab-creation/settlement issue — see gotab.ts).
describe('mapGoTabStatus', () => {
  it('a set `prepared` timestamp means READY regardless of status', () => {
    expect(mapGoTabStatus('SENT', '2026-06-27T18:00:00Z')).toBe('READY');
    expect(mapGoTabStatus('PENDING', '2026-06-27T18:00:00Z')).toBe('READY');
    expect(mapGoTabStatus(null, '2026-06-27T18:00:00Z')).toBe('READY');
  });

  it('PENDING and SCHEDULED map to SCHEDULED (accepted, not at kitchen)', () => {
    expect(mapGoTabStatus('PENDING', null)).toBe('SCHEDULED');
    expect(mapGoTabStatus('SCHEDULED', null)).toBe('SCHEDULED');
  });

  it('SENT maps to IN_PROGRESS (fired, cooking)', () => {
    expect(mapGoTabStatus('SENT', null)).toBe('IN_PROGRESS');
  });

  it('DELIVERED maps to READY', () => {
    expect(mapGoTabStatus('DELIVERED', null)).toBe('READY');
  });

  it('cancelled variants map to CANCELLED', () => {
    expect(mapGoTabStatus('CANCELLED', null)).toBe('CANCELLED');
    expect(mapGoTabStatus('CANCELED', null)).toBe('CANCELLED');
  });

  it('is case-insensitive on the status string', () => {
    expect(mapGoTabStatus('sent', null)).toBe('IN_PROGRESS');
    expect(mapGoTabStatus('scheduled', null)).toBe('SCHEDULED');
  });

  it('unknown/missing status on an unprepared order defaults to SCHEDULED', () => {
    expect(mapGoTabStatus(null, null)).toBe('SCHEDULED');
    expect(mapGoTabStatus('SOME_FUTURE_STATE', null)).toBe('SCHEDULED');
  });
});

// Locks the EMPIRICALLY VERIFIED dashboard tri-state mapping (project doc
// "GoTab product availability mapping — VERIFIED", 2026-07-02). If GoTab ever
// changes these semantics, re-run scripts/probe-gotab-availability.ts before
// touching these expectations.
describe('classifyGoTabProduct', () => {
  it('enabled products are AVAILABLE', () => {
    expect(
      classifyGoTabProduct({ productType: 'DEFAULT', orderEnabled: true, available: true, enableTimestamp: null }),
    ).toBe('AVAILABLE');
  });

  it('disabled with enableTimestamp set = UNAVAILABLE (auto-expiring 86)', () => {
    expect(
      classifyGoTabProduct({ productType: 'DEFAULT', orderEnabled: false, available: false, enableTimestamp: '2026-07-03T06:59:59.999' }),
    ).toBe('UNAVAILABLE');
  });

  it('disabled with null enableTimestamp = HIDDEN', () => {
    expect(
      classifyGoTabProduct({ productType: 'DEFAULT', orderEnabled: false, available: false, enableTimestamp: null }),
    ).toBe('HIDDEN');
  });

  it('CUSTOM productType is CUSTOM regardless of flags (back-office instruments)', () => {
    expect(
      classifyGoTabProduct({ productType: 'CUSTOM', orderEnabled: false, available: false, enableTimestamp: null }),
    ).toBe('CUSTOM');
    expect(
      classifyGoTabProduct({ productType: 'custom', orderEnabled: true, available: true, enableTimestamp: null }),
    ).toBe('CUSTOM');
  });

  it('null/missing booleans are NOT disabled — only explicit false is', () => {
    expect(
      classifyGoTabProduct({ productType: 'DEFAULT', orderEnabled: null, available: null, enableTimestamp: null }),
    ).toBe('AVAILABLE');
  });

  it('either boolean explicitly false disables (lockstep observed, but defend each)', () => {
    expect(
      classifyGoTabProduct({ productType: 'DEFAULT', orderEnabled: false, available: true, enableTimestamp: null }),
    ).toBe('HIDDEN');
    expect(
      classifyGoTabProduct({ productType: 'DEFAULT', orderEnabled: true, available: false, enableTimestamp: '2026-07-03T06:59:59.999' }),
    ).toBe('UNAVAILABLE');
  });
});

// Spot selection for ticket submission (gotab-spot.ts). Fixture mirrors the
// real Konjo sandbox topology observed 2026-07-07: an E-Commerce spot in an
// asapOnly zone and a Pickup Counter spot in an asapOnly:false zone.
describe('chooseSubmitSpot', () => {
  const ecomZone = { zoneId: '48710', name: 'E-Commerce', asapOnly: true, hidden: false, available: true };
  const pickupZone = { zoneId: '49184', name: 'Pickup', asapOnly: false, hidden: false, available: true };
  const zones = [ecomZone, pickupZone];
  const ecomSpot = { spotId: '254417', spotUuid: 'spt_ecom', name: 'E-Commerce', zoneId: '48710', hidden: false };
  const pickupSpot = { spotId: '255214', spotUuid: 'spt_pickup', name: 'Pickup Counter', zoneId: '49184', hidden: false };

  it('prefers a spot whose zone has asapOnly:false (Konjo topology)', () => {
    expect(chooseSubmitSpot([ecomSpot, pickupSpot], zones)?.spotUuid).toBe('spt_pickup');
  });

  it('falls back to an asapOnly zone spot when nothing better exists', () => {
    expect(chooseSubmitSpot([ecomSpot], zones)?.spotUuid).toBe('spt_ecom');
  });

  it('excludes hidden/archived spots and hidden/unavailable zones', () => {
    const hiddenSpot = { ...pickupSpot, hidden: true };
    expect(chooseSubmitSpot([hiddenSpot, ecomSpot], zones)?.spotUuid).toBe('spt_ecom');
    const deadZone = [{ ...pickupZone, available: false }, ecomZone];
    expect(chooseSubmitSpot([pickupSpot, ecomSpot], deadZone)?.spotUuid).toBe('spt_ecom');
    expect(chooseSubmitSpot([{ ...ecomSpot, archived: true }], zones)).toBeNull();
  });

  it('keeps spots with unknown zones and tiebreaks by ascending spotId', () => {
    const orphan = { spotId: '100', spotUuid: 'spt_orphan', name: 'Orphan', zoneId: '99999', hidden: false };
    // Orphan zone unknown -> kept, ranked with the asapOnly-true tier; pickup
    // (asapOnly:false tier) still wins.
    expect(chooseSubmitSpot([orphan, pickupSpot], zones)?.spotUuid).toBe('spt_pickup');
    // Within the same tier, lowest numeric spotId wins deterministically.
    expect(chooseSubmitSpot([orphan, ecomSpot], zones)?.spotUuid).toBe('spt_orphan');
  });

  it('returns null when no spots exist', () => {
    expect(chooseSubmitSpot([], zones)).toBeNull();
  });
});
