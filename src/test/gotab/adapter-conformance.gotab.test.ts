import { describe, it, expect, beforeAll } from 'vitest';

// GoTab ADAPTER CONFORMANCE — the real GoTabAdapter vs the LIVE sandbox
// (roadmap 2.7; grown from scripts/probe-adapter-submit.ts). This is the
// regression net for every future adapter change, including the eventual
// cancelTicket implementation and any 2.3-driven payment work.
//
// Creds-gated: self-skips without GOTAB_API_ACCESS_ID/SECRET (CI shows
// skipped, never red). Cost per run: one stranded $10 open tab at Konjo
// (settle pile — "Pay with Tender Types"), ~15–30s wall time (live HTTP +
// 280ms pacing).
//
// What it deliberately does NOT cover (and why):
//   - SCHEDULED observation: we-hold-timers mode submits ASAP orders; GoTab
//     scheduling is structurally excluded for this integration (open tabs ⊕
//     scheduled — project doc, Zach 2026-07-08).
//   - `prepared`/READY: requires a human KDS bump; unautomatable.
//   - The config-gated route guards (VENDOR_ADAPTER==='gotab' branches):
//     app+DB territory, noted as this suite's future growth if it ever boots
//     the server against live GoTab.

// Sandbox fixtures (project doc "SANDBOX FACTS"):
const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const KONJO_ITEM1 = 'prd_o1ypp85ndHldLmCbgjoQZIA2'; // Konjo Me Test Item 1, $10

const hasCreds = Boolean(
  (process.env.GOTAB_API_ACCESS_ID ?? process.env.GOTAB_API_KEY) &&
    (process.env.GOTAB_API_ACCESS_SECRET ?? process.env.GOTAB_API_SECRET),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasCreds)('GoTab adapter conformance (LIVE sandbox)', () => {
  // Import lazily inside the gated describe: constructing the adapter (and
  // resolving auth) without creds throws — must not happen on skip.
  let adapter: import('../../vendor-adapter/gotab.js').GoTabAdapter;
  let ticketId: string;
  let externalOrderId: string;
  let ctxStatus: string;

  beforeAll(async () => {
    const { GoTabAdapter } = await import('../../vendor-adapter/gotab.js');
    adapter = new GoTabAdapter();
    ticketId = `conf_${Date.now()}`;
  });

  it('lists Konjo products (catalog read; the known fixture item is present)', async () => {
    const catalog = await adapter.listProducts(KONJO_LOC);
    expect(catalog.products.length).toBeGreaterThan(0);
    const item1 = catalog.products.find((p) => p.gotabProductUuid === KONJO_ITEM1);
    expect(item1).toBeTruthy();
    expect(item1!.priceCents).toBe(1000); // cents-not-dollars, live-verified stays verified
  });

  it('submits an open-tab ticket and gets a numeric order id back', async () => {
    const now = new Date();
    const result = await adapter.submitTicket({
      ticketId,
      vendorLocationId: KONJO_LOC,
      scheduledFor: now,
      targetReadyAt: new Date(now.getTime() + 5 * 60_000),
      items: [
        { name: 'Konjo Me Test Item 1', qty: 1, priceCents: 1000, gotabProductUuid: KONJO_ITEM1 },
      ],
    });
    expect(result.externalOrderId).toMatch(/^\d+$/); // numeric orderId, per adapter law §6
    externalOrderId = result.externalOrderId;
  });

  it('resubmitting the same ticketId is idempotent (same external id, no second order)', async () => {
    const now = new Date();
    const again = await adapter.submitTicket({
      ticketId,
      vendorLocationId: KONJO_LOC,
      scheduledFor: now,
      targetReadyAt: new Date(now.getTime() + 5 * 60_000),
      items: [
        { name: 'Konjo Me Test Item 1', qty: 1, priceCents: 1000, gotabProductUuid: KONJO_ITEM1 },
      ],
    });
    expect(again.externalOrderId).toBe(externalOrderId);
  });

  it('reads status via the ctx path (proven targeted lookup) → IN_PROGRESS', async () => {
    // Tolerate the known create→sent sampling race (~200ms pipeline, observed
    // 2026-07-07): an early read can legitimately see SCHEDULED. Retry a few
    // times before judging.
    let status = '';
    for (let i = 0; i < 4; i++) {
      status = await adapter.getTicketStatus(externalOrderId, {
        vendorLocationId: KONJO_LOC,
      });
      if (status === 'IN_PROGRESS') break;
      await sleep(2_500);
    }
    expect(status).toBe('IN_PROGRESS'); // ASAP order sits at SENT (no KDS bump)
    ctxStatus = status;
  });

  it('the no-ctx fallback (top-level order lookup) agrees with the ctx path', async () => {
    const status = await adapter.getTicketStatus(externalOrderId);
    expect(status).toBe(ctxStatus);
  });

  it('cancelTicket is 501 — LOCKS the current contract (this failing = it got implemented; grow the suite)', async () => {
    await expect(adapter.cancelTicket(externalOrderId)).rejects.toMatchObject({
      statusCode: 501,
    });
  });
});
