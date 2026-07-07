// CONFORMANCE SMOKE: exercise the REAL GoTabAdapter methods against live
// Konjo — the first run of the actual adapter code path (not raw probes).
//
// What it verifies:
//   1. submitTicket: spot discovery -> open-tab create -> numeric orderId back.
//   2. Idempotency: a second submitTicket with the same ticketId returns the
//      SAME externalOrderId without creating a second tab.
//   3. getTicketStatus via the ctx path (proven ordersList condition lookup)
//      AND via the no-ctx fallback (top-level order(orderId) — first exercise).
//   4. Expected status: IN_PROGRESS almost immediately (ASAP fire -> SENT).
//      READY is NOT reachable in the sandbox (no KDS to bump) — IN_PROGRESS
//      is the pass state.
//
// Hygiene: strands ONE open tab (settle via "Pay with Tender Types").
//
// Run:  npx tsx --env-file=.env scripts/probe-adapter-submit.ts

import { GoTabAdapter } from '../src/vendor-adapter/gotab.js';

const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const ITEM1 = 'prd_o1ypp85ndHldLmCbgjoQZIA2'; // Konjo Me Test Item 1, $10

async function main() {
  const adapter = new GoTabAdapter();
  const now = new Date();
  const req = {
    ticketId: `smoke_${Date.now()}`,
    vendorLocationId: KONJO_LOC,
    scheduledFor: now, // we-hold-timers mode: fire NOW
    targetReadyAt: new Date(now.getTime() + 5 * 60_000),
    items: [
      {
        name: 'Konjo Me Test Item 1',
        qty: 1,
        priceCents: 1000,
        gotabProductUuid: ITEM1,
      },
    ],
  };

  console.log(`1) submitTicket (ticketId=${req.ticketId})...`);
  const result = await adapter.submitTicket(req);
  console.log('   result:', JSON.stringify(result));

  console.log('2) idempotency: submitTicket again with the same request...');
  const again = await adapter.submitTicket(req);
  const idem = again.externalOrderId === result.externalOrderId;
  console.log(`   same externalOrderId: ${idem ? 'YES (pass)' : 'NO (FAIL — duplicate order created!)'}`);

  console.log('3) getTicketStatus via ctx (proven location-scoped lookup)...');
  const sCtx = await adapter.getTicketStatus(result.externalOrderId, {
    vendorLocationId: KONJO_LOC,
  });
  console.log(`   status: ${sCtx}`);

  console.log('4) getTicketStatus WITHOUT ctx (top-level order() fallback — first exercise)...');
  try {
    const sTop = await adapter.getTicketStatus(result.externalOrderId);
    console.log(`   status: ${sTop} ${sTop === sCtx ? '(matches ctx path)' : '(MISMATCH vs ctx path!)'}`);
  } catch (err) {
    console.log(`   fallback FAILED (record this — reconcile always passes ctx, so not fatal):`);
    console.log(`   ${err instanceof Error ? err.message : err}`);
  }

  console.log('\n─── VERDICT ───');
  console.log(`submit: OK (order ${result.externalOrderId})`);
  console.log(`idempotent: ${idem ? 'OK' : 'FAIL'}`);
  console.log(`status(ctx): ${sCtx} ${sCtx === 'IN_PROGRESS' ? '(expected — ASAP fired, no KDS to bump)' : sCtx === 'SCHEDULED' ? '(unexpected in ASAP mode — investigate)' : ''}`);
  console.log('Stranded tab: settle via "Pay with Tender Types" in the dashboard when convenient.');
}

main().catch((err) => {
  console.error('Smoke failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
