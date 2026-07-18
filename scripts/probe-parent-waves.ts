// PROBE #2: parent-tab WAVES (the stagger mechanism, 2026-07-17).
// Probe #1 proved: parent tab + per-item productLocationId → one order PER
// child location, both KDSs light up, creation-time items fire ASAP.
// This probe answers the remaining fire-side question: can we APPEND items
// to the parent tab LATER (a "wave"), and does the wave create a fresh
// per-location order that fires and chimes the right kitchen?
//   YES → the complete stagger architecture on one tab: thin-ish tab at
//         lock, waves released per vendor on OUR timers. Fire side: solved.
//   NO  → the exact failure/introspection output below IS the question for
//         Zach.
//
// UNKNOWN TERRITORY: the append endpoint shape is undocumented to us. The
// probe tries plausible REST shapes in order; if all fail, it introspects
// the GraphQL mutation root for tab/item mutations and prints their args so
// the next attempt (or the Zach email) is precise, not guessed.
//
// Timeline: create tab with ONLY Motor's item (Motor KDS should chime at
// T+0) → wait 60s → append Konjo's item (Konjo KDS should chime at T+60s if
// waves work). Watch both screens.
//
// Cost: strands one parent tab ($15) on the settle pile.
//
// Run:  npx tsx --env-file=.env scripts/probe-parent-waves.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';
import { parseGoTabTimestamp } from '../src/vendor-adapter/gotab.js';

const PARENT_LOC = 'EL7tpX4xTFNCq~SnMrY_0EcZ';
const PARENT_SPOT = 'spt_WuYe_~57oErz~XrFizbJ9bdb';
const KONJO = { uuid: 'ZQFbjpg06x4rf1w08RTuOhGa', productLocationId: 21091, product: 'prd_o1ypp85ndHldLmCbgjoQZIA2' };
const MOTOR = { uuid: 'oSVMdw0wbSMqE~pOv7cUdkMd', productLocationId: 21092, product: 'prd_iJtCwBBrkOV7yRzlkP6FmSqf' };
const WAVE_DELAY_MS = 60_000;

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      order(orderId: $id) { orderId status created sent prepared isAsap locationUuid tabId }
    }`,
    { id: orderId },
  );
  return d.order ?? null;
}

async function introspectTabMutations() {
  const d = await client.graph<{
    __schema: { mutationType: { fields: Array<{ name: string; args: Array<{ name: string; type: unknown }> }> } | null };
  }>(
    `query {
      __schema { mutationType { fields {
        name
        args { name type { kind name ofType { kind name ofType { kind name } } } }
      } } }
    }`,
    {},
  );
  const fields = d.__schema.mutationType?.fields ?? [];
  return fields.filter((f) => /tab|item|order/i.test(f.name));
}

async function main() {
  const externalId = `wave-probe-${Date.now()}`;

  // ── WAVE 0: create the tab with ONLY Motor's item ──
  console.log('WAVE 0: creating parent tab with ONLY the Motor item...');
  console.log('        (Motor iPhone KDS should chime NOW)');
  const created = (await client.locPost(PARENT_LOC, 'tabs', {
    openTab: true,
    externalId,
    name: `Wave Probe ${new Date().toISOString().slice(11, 19)}`,
    phoneNumber: '+13135550100',
    spotUuid: PARENT_SPOT,
    items: [
      { productUuid: MOTOR.product, quantity: 1, externalId: `${externalId}-motor`, productLocationId: MOTOR.productLocationId },
    ],
  })) as { data?: { tabUuid?: string } };

  const tabUuid = created?.data?.tabUuid;
  const wave0Ids = new Set<string>();
  collectOrderIds(created, wave0Ids);
  console.log(`  tabUuid: ${tabUuid ?? '(missing?! raw below)'}`);
  console.log(`  wave-0 order ids: ${[...wave0Ids].join(', ') || '(none)'}`);
  if (!tabUuid) { console.log(JSON.stringify(created, null, 2)); process.exit(1); }

  // ── the stagger gap ──
  console.log(`\nWaiting ${WAVE_DELAY_MS / 1000}s (the stagger gap our timers would hold)...`);
  await sleep(WAVE_DELAY_MS);

  // ── WAVE 1: append Konjo's item to the SAME tab ──
  console.log("WAVE 1: appending Konjo's item to the same tab...");
  const konjoItems = [
    { productUuid: KONJO.product, quantity: 1, externalId: `${externalId}-konjo`, productLocationId: KONJO.productLocationId },
  ];
  const attempts: Array<{ label: string; path: string; body: unknown }> = [
    // Run 1 (2026-07-17): bare { items } → 400 "Spot not found." — the
    // endpoint EXISTS and parses; it wants a spot in the body. Iterating:
    { label: 'REST A1: POST tabs/{tabUuid}/items + spotUuid', path: `tabs/${tabUuid}/items`, body: { spotUuid: PARENT_SPOT, items: konjoItems } },
    { label: 'REST A2: + phoneNumber too', path: `tabs/${tabUuid}/items`, body: { spotUuid: PARENT_SPOT, phoneNumber: '+13135550100', items: konjoItems } },
    // True 404 on run 1 — kept last as a canary in case routes change:
    { label: 'REST B: POST tabs/{tabUuid}/orders', path: `tabs/${tabUuid}/orders`, body: { spotUuid: PARENT_SPOT, items: konjoItems } },
  ];

  let appended: unknown = null;
  for (const a of attempts) {
    try {
      console.log(`  trying ${a.label}...`);
      appended = await client.locPost(PARENT_LOC, a.path, a.body);
      console.log(`  ✓ ${a.label} SUCCEEDED`);
      break;
    } catch (err) {
      console.log(`  ✗ ${a.label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!appended) {
    console.log('\n─── ALL REST SHAPES FAILED — INTROSPECTING MUTATIONS ───');
    const muts = await introspectTabMutations();
    for (const m of muts) {
      console.log(`\nmutation ${m.name}`);
      for (const arg of m.args) console.log(`  arg ${arg.name}: ${JSON.stringify(arg.type)}`);
    }
    console.log('\nSend the failures + the mutation list above to Zach —');
    console.log('"what is the append-items shape for a parent tab?" is now precise.');
    console.log('(Wave-0 Motor order still fired; tab joins the settle pile.)');
    return;
  }

  console.log('\n─── RAW APPEND RESPONSE ───');
  console.log(JSON.stringify(appended, null, 2));

  const allIds = new Set<string>();
  collectOrderIds(appended, allIds);
  const newIds = [...allIds].filter((id) => !wave0Ids.has(id));
  console.log(`\nnew order ids from wave 1: ${newIds.join(', ') || '(none — inspect raw response)'}`);

  await sleep(4_000);
  for (const id of newIds) {
    const row = await lookupOrder(id);
    if (!row) { console.log(`order ${id}: not found via top-level lookup`); continue; }
    const locNote =
      row.locationUuid === KONJO.uuid ? 'KONJO child ✓ (routed!)' :
      row.locationUuid === MOTOR.uuid ? 'MOTOR child (?!)' :
      row.locationUuid === PARENT_LOC ? 'PARENT itself (?)' : 'UNKNOWN';
    console.log(`\norder ${id} → ${locNote}`);
    console.log(`  ${JSON.stringify(row)}`);
    const sent = parseGoTabTimestamp(row.sent as string | null);
    const createdTs = parseGoTabTimestamp(row.created as string | null);
    if (sent && createdTs) {
      console.log(`  wave fired ASAP: yes (pipeline ${((sent.getTime() - createdTs.getTime()) / 1000).toFixed(2)}s)`);
    } else {
      console.log('  wave fired ASAP: NO (sent unset — held? poll again)');
    }
  }

  console.log('\n─── VERDICT CHECKLIST ───');
  console.log('1. Did the Konjo PC KDS chime ~60s after Motor? (the stagger, witnessed)');
  console.log('2. New per-location order for the wave? (see lookups above)');
  console.log('3. If both yes: the FIRE SIDE of the parent-tab architecture is');
  console.log('   COMPLETELY PROVEN — one tab, waves on our timers, per-vendor');
  console.log('   orders. Only payment mechanics remain (Zach\u2019s weekend).');
  console.log('Settle pile +1 parent tab.');
}

main().catch((err) => {
  console.error('Probe failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
