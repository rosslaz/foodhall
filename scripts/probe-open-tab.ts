// PROBE v2: scheduled open-tab order — retry with a SCHEDULING-ENABLED spot.
//
// WHAT v1 ESTABLISHED (2026-07-07, order 133476673):
//   - openTab:true + no payments[] + top-level `scheduled` = CORRECT shape
//     (docs.gotab.io/docs/create-a-new-tab documents `scheduled` top-level).
//   - BUT the SPOT gates scheduling: "If the spot allows scheduling ...
//     Otherwise the delivery time will be set to ASAP." Konjo's dine-in spot
//     coerced our order to ASAP (isAsap:true, scheduled=placed, fired 200ms
//     after create). Fix = spot config in the manager dashboard, not code.
//   - Success criteria (THE FIX for v1's verdict bug): GoTab's `scheduled`
//     must ECHO ours and isAsap must be FALSE. Only then does sent-vs-
//     scheduled measure fire tolerance.
//   - ordersList(condition:{orderId}) is the proven fast lookup; bare
//     ordersList times out. GraphQL is limited to 4rps (429 on excess).
//   - Timestamps: mixed formats (some +00:00, some tz-less UTC) — parser
//     appends Z to tz-less.
//
// BEFORE RUNNING: set SPOT below to a scheduling-enabled spot (enable it on
// the existing spot in the dashboard, or create a takeout/pickup-type spot
// and paste its spt_ uuid). Also confirm the location has an ordering
// schedule window covering now+SCHEDULED_OFFSET_MIN.
//
// Run:  npx tsx --env-file=.env scripts/probe-open-tab.ts
// Hygiene: each run strands one open tab (settle via "Pay with Tender Types").

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

// ── Knobs ────────────────────────────────────────────────────────────────────
const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const SPOT = 'spt_Xfg6nOcE0yL2EmwTDzpRmac6';   // Pickup Counter (Pickup zone, asapOnly:false)
const PRODUCT_ITEM1 = 'prd_o1ypp85ndHldLmCbgjoQZIA2';
const SCHEDULED_OFFSET_MIN = 3;
const POLL_INTERVAL_MS = 12_000;               // well under the 4rps ceiling
const TIMEOUT_MIN = 8;
// ─────────────────────────────────────────────────────────────────────────────

const ORDER_FIELDS =
  'orderId orderUuid tabId status name created placed scheduled sent prepared fulfilled statusChanged dispatched recalled isAsap orderPrepTimeMs';

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseGoTabTs(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(withZone);
  return isNaN(d.getTime()) ? null : d;
}
const fmtDelta = (ms: number) => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`;

function collectValues(obj: unknown, keyRe: RegExp, out = new Set<string>()): Set<string> {
  if (Array.isArray(obj)) for (const v of obj) collectValues(v, keyRe, out);
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (keyRe.test(k) && (typeof v === 'string' || typeof v === 'number')) out.add(String(v));
      collectValues(v, keyRe, out);
    }
  }
  return out;
}

async function fetchOrder(orderId: string): Promise<Record<string, unknown> | null> {
  const d = await client.graph<{ location: { ordersList: Array<Record<string, unknown>> | null } | null }>(
    `query ($loc: String!) {
      location(locationUuid: $loc) {
        ordersList(condition: { orderId: "${orderId}" }) { ${ORDER_FIELDS} }
      }
    }`,
    { loc: KONJO_LOC },
  );
  return d.location?.ordersList?.[0] ?? null;
}

async function main() {
  const scheduledFor = new Date(Date.now() + SCHEDULED_OFFSET_MIN * 60_000);
  const scheduledIso = scheduledFor.toISOString();

  const body = {
    openTab: true,
    spotUuid: SPOT,
    name: `Probe2 ${new Date().toISOString().slice(11, 19)}`,
    scheduled: scheduledIso,
    items: [{ product: { productUuid: PRODUCT_ITEM1 }, quantity: 1 }],
  };

  console.log(`Creating scheduled open tab on Konjo. scheduled = ${scheduledIso} (T+${SCHEDULED_OFFSET_MIN}min)`);
  console.log(`Spot: ${SPOT}`);
  let resp: unknown;
  try {
    resp = await client.locPost(KONJO_LOC, 'tabs', body);
  } catch (err) {
    console.error('\n*** CREATE FAILED ***');
    console.error(err instanceof Error ? err.message : err);
    console.error('(A rejection here vs v1\'s silent coercion is itself signal — e.g. "outside');
    console.error('schedule window" would confirm the schedule-window requirement.)');
    process.exit(1);
  }
  console.log('\nCREATE SUCCEEDED. Full response:');
  console.log(JSON.stringify(resp, null, 2));

  const tabUuids = [...collectValues(resp, /^tabUuid$/i)];
  const orderIds = [...collectValues(resp, /^orderId$/i)];
  console.log(`\ntabUuid: ${tabUuids.join(', ')}  |  orderId: ${orderIds.join(', ')}`);
  if (!orderIds.length) { console.log('No orderId in response — inspect above.'); process.exit(1); }
  const orderId = orderIds[0];

  // ── THE VERDICT CHECK, first and up front (v1's bug fixed): did the
  //    schedule TAKE? isAsap must be false and GoTab.scheduled must echo ours.
  await sleep(2_000);
  const first = await fetchOrder(orderId);
  if (!first) { console.log('Order not found via ordersList(condition) — unexpected.'); process.exit(1); }
  console.log('\nFirst snapshot:', JSON.stringify(first, null, 2));

  const gtScheduled = parseGoTabTs(first.scheduled as string);
  const echoed = gtScheduled && Math.abs(gtScheduled.getTime() - scheduledFor.getTime()) < 30_000;
  if (first.isAsap === true || !echoed) {
    console.log('\n*** SCHEDULE DID NOT TAKE ***');
    console.log(`isAsap: ${first.isAsap}, GoTab.scheduled: ${first.scheduled} (ours: ${scheduledIso})`);
    console.log('The spot still does not allow scheduling (or the time falls outside the');
    console.log('location\'s ordering schedule). Fix the spot/schedule config and re-run.');
    console.log(`Stranded tab to settle: ${tabUuids.join(', ')}`);
    process.exit(1);
  }
  console.log('\n*** SCHEDULE TOOK: isAsap=false, GoTab echoed our timestamp. ***');
  console.log('Now the only question is WHEN it fires. Polling...\n');

  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let snap: Record<string, unknown> | null;
    try { snap = await fetchOrder(orderId); } catch (err) {
      console.log(`(poll error: ${err instanceof Error ? err.message.slice(0, 120) : err})`); continue;
    }
    if (!snap) continue;
    const line = JSON.stringify(snap);
    if (line === last) { process.stdout.write('.'); continue; }
    last = line;
    const now = new Date();
    console.log(`\n[${now.toISOString().slice(11, 19)}Z] status=${snap.status} sent=${snap.sent ?? '—'} prepared=${snap.prepared ?? '—'}`);
    const sent = parseGoTabTs(snap.sent as string);
    if (sent) {
      console.log('\n─── Q1: FIRE TOLERANCE (the holdsSchedule answer) ───');
      console.log(`scheduled (GoTab): ${snap.scheduled}`);
      console.log(`sent:              ${snap.sent}`);
      console.log(`sent − scheduled = ${fmtDelta(sent.getTime() - (gtScheduled as Date).getTime())}`);
      console.log(`poll-observed lag  = ${fmtDelta(now.getTime() - sent.getTime())}   <- Q4`);
      console.log('\nGoTab HELD a real scheduled order and released it — holdsSchedule=true is real.');
      console.log('If a KDS/web display exists by now, bump it to exercise `prepared`; else done.');
      if (!snap.prepared) console.log('Polling a bit longer for prepared...');
      else { console.log(`prepared: ${snap.prepared} — full lifecycle.`); break; }
    }
    if (snap.prepared) break;
  }
  console.log(`\n─── SUMMARY ─── ours=${scheduledIso}; tab=${tabUuids.join(',')}; record in project doc.`);
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
