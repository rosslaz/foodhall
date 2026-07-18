// PROBE: parent-tab multi-vendor creation (Zach reply #5, 2026-07-15).
// Creates ONE tab at the PARENT location carrying one Konjo item and one
// Motor item via per-item productLocationId — Zach's exact payload shape,
// against the new real parent spot. Answers, empirically:
//   1. Is the parent-tab sandbox config LIVE?
//   2. Does GoTab represent this as ONE order or one order PER child location?
//      (determines our ticket<->order mapping in any parent-tab architecture)
//   3. Do the items route to each child's KDS? (WATCH BOTH SCREENS: PC
//      GoTops = Konjo, iPhone GoTops = Motor — the two-kitchens-one-tab
//      moment, if it works)
//   4. Do they fire ASAP (sent set immediately), matching open-tab behavior?
//
// Cost: strands one PARENT tab (Konjo $10 + Motor item) on the settle pile.
//
// Run:  npx tsx --env-file=.env scripts/probe-parent-tab.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';
import { parseGoTabTimestamp } from '../src/vendor-adapter/gotab.js';

const PARENT_LOC = 'EL7tpX4xTFNCq~SnMrY_0EcZ'; // Detroit Shipping Sandbox (parent)
const PARENT_SPOT = 'spt_WuYe_~57oErz~XrFizbJ9bdb'; // from Zach 07-15 (real, post-config)
const KONJO = { uuid: 'ZQFbjpg06x4rf1w08RTuOhGa', productLocationId: 21091, product: 'prd_o1ypp85ndHldLmCbgjoQZIA2' };
const MOTOR = { uuid: 'oSVMdw0wbSMqE~pOv7cUdkMd', productLocationId: 21092, product: 'prd_iJtCwBBrkOV7yRzlkP6FmSqf' };

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The create-response shape for PARENT tabs is unknown territory (single-
// location tabs return one numeric orderId, data-wrapped). Scan defensively:
// collect every numeric-looking value under any key matching /orderid/i.
function collectOrderIds(node: unknown, found: Set<string>) {
  if (Array.isArray(node)) { for (const v of node) collectOrderIds(v, found); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (/orderid/i.test(k) && (typeof v === 'string' || typeof v === 'number') && /^\d+$/.test(String(v))) {
        found.add(String(v));
      }
      collectOrderIds(v, found);
    }
  }
}

async function lookupOrder(orderId: string) {
  const d = await client.graph<{ order: Record<string, unknown> | null }>(
    `query ($id: BigInt!) {
      order(orderId: $id) {
        orderId status name created placed sent prepared isAsap locationUuid tabId
      }
    }`,
    { id: orderId },
  );
  return d.order ?? null;
}

async function main() {
  const externalId = `parent-probe-${Date.now()}`;
  const payload = {
    openTab: true,
    externalId,
    name: `Parent Probe ${new Date().toISOString().slice(11, 19)}`,
    phoneNumber: '+13135550100',
    spotUuid: PARENT_SPOT,
    items: [
      { productUuid: KONJO.product, quantity: 1, externalId: `${externalId}-konjo`, productLocationId: KONJO.productLocationId },
      { productUuid: MOTOR.product, quantity: 1, externalId: `${externalId}-motor`, productLocationId: MOTOR.productLocationId },
    ],
  };

  console.log(`Creating PARENT tab at ${PARENT_LOC} (spot ${PARENT_SPOT})...`);
  let created: unknown;
  try {
    created = await client.locPost(PARENT_LOC, 'tabs', payload);
  } catch (err) {
    console.log('\n─── CREATE FAILED ───');
    console.log(err instanceof Error ? err.message : String(err));
    console.log('\nMost likely reading: the parent-tab config is NOT live yet');
    console.log('(or the spot/productLocationId shape differs). Send Zach the');
    console.log('exact error above — it is useful data for his weekend testing.');
    process.exit(0);
  }

  console.log('\n─── RAW CREATE RESPONSE ───');
  console.log(JSON.stringify(created, null, 2));

  const ids = new Set<string>();
  collectOrderIds(created, ids);
  console.log(`\n─── ORDER IDS DISCOVERED: ${ids.size} ───`);
  console.log([...ids].join(', ') || '(none — inspect the raw response above)');
  if (ids.size === 1) console.log('=> ONE order spanning both vendors (single-ticket shape)');
  if (ids.size > 1) console.log('=> MULTIPLE orders (per-location split — maps to our per-vendor tickets!)');

  if (ids.size === 0) return;

  console.log('\nWaiting 4s for the pipeline, then looking up each order...');
  await sleep(4_000);
  for (const id of ids) {
    const row = await lookupOrder(id);
    if (!row) { console.log(`order ${id}: NOT FOUND via top-level lookup`); continue; }
    const locNote =
      row.locationUuid === KONJO.uuid ? 'KONJO child' :
      row.locationUuid === MOTOR.uuid ? 'MOTOR child' :
      row.locationUuid === PARENT_LOC ? 'PARENT itself' : 'UNKNOWN location';
    console.log(`\norder ${id} → ${locNote}`);
    console.log(`  ${JSON.stringify(row)}`);
    const sent = parseGoTabTimestamp(row.sent as string | null);
    const createdTs = parseGoTabTimestamp(row.created as string | null);
    if (sent && createdTs) {
      console.log(`  fired ASAP: yes (pipeline ${((sent.getTime() - createdTs.getTime()) / 1000).toFixed(2)}s)`);
    } else {
      console.log(`  fired ASAP: NO (sent not set — held? scheduled? poll again)`);
    }
  }

  console.log('\n─── NOW CHECK THE KITCHENS ───');
  console.log('PC GoTops (Konjo) and iPhone GoTops (Motor): did each get its item?');
  console.log('One tab, two kitchens — if both screens show a ticket, the');
  console.log('parent-tab architecture routes. Settle pile +1 (parent tab).');
}

main().catch((err) => {
  console.error('Probe failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
