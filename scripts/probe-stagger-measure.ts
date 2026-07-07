// MEASUREMENT: the first end-to-end stagger, on GoTab's clock (2026-07-07).
// Our side scheduled Motor at 17:15:37.598Z and Konjo at 17:20:37.598Z —
// a 300.000s offset. This reads GoTab's OWN `sent` timestamps for both
// orders and prints the delta the kitchens actually experienced.
// (LAW: GoTab timestamps compared to GoTab timestamps only — ~1s clock skew
// vs local was observed 2026-07-07.)
//
// Run:  npx tsx --env-file=.env scripts/probe-stagger-measure.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';
import { parseGoTabTimestamp } from '../src/vendor-adapter/gotab.js';

// The first end-to-end run (group b2033d0e, 2026-07-07 17:15Z):
const ORDERS = [
  { label: 'Motor (8min prep, offset 0)', loc: 'oSVMdw0wbSMqE~pOv7cUdkMd', orderId: '133492158', ourScheduledFor: '2026-07-07T17:15:37.598Z' },
  { label: 'Konjo (3min prep, offset +300s)', loc: 'ZQFbjpg06x4rf1w08RTuOhGa', orderId: '133492491', ourScheduledFor: '2026-07-07T17:20:37.598Z' },
];

const client = new GoTabClient(getGoTabAuth());

async function fetchOrder(loc: string, orderId: string) {
  const d = await client.graph<{
    location: { ordersList: Array<Record<string, unknown>> | null } | null;
  }>(
    `query ($loc: String!) {
      location(locationUuid: $loc) {
        ordersList(condition: { orderId: "${orderId}" }) {
          orderId status created placed sent prepared isAsap
        }
      }
    }`,
    { loc },
  );
  return d.location?.ordersList?.[0] ?? null;
}

async function main() {
  const sents: Array<{ label: string; sent: Date; ourFor: Date }> = [];
  for (const o of ORDERS) {
    const row = await fetchOrder(o.loc, o.orderId);
    if (!row) { console.log(`${o.label}: NOT FOUND (order ${o.orderId})`); continue; }
    console.log(`${o.label}:`);
    console.log(`  ${JSON.stringify(row)}`);
    const sent = parseGoTabTimestamp(row.sent as string);
    const created = parseGoTabTimestamp(row.created as string);
    if (sent && created) {
      console.log(`  submit->sent pipeline: ${((sent.getTime() - created.getTime()) / 1000).toFixed(2)}s`);
    }
    if (sent) sents.push({ label: o.label, sent, ourFor: new Date(o.ourScheduledFor) });
  }

  if (sents.length === 2) {
    const [a, b] = sents as [typeof sents[0], typeof sents[0]];
    const actualMs = b.sent.getTime() - a.sent.getTime();
    const intendedMs = b.ourFor.getTime() - a.ourFor.getTime();
    console.log('\n─── THE NUMBER ───');
    console.log(`intended stagger (our timers): ${(intendedMs / 1000).toFixed(3)}s`);
    console.log(`actual stagger (GoTab sent):   ${(actualMs / 1000).toFixed(3)}s`);
    console.log(`error:                         ${((actualMs - intendedMs) / 1000).toFixed(3)}s`);
    console.log('\nThat error is the end-to-end stagger fidelity of we-hold-timers mode:');
    console.log('BullMQ delay jitter + pacing + HTTP + GoTab pipeline, both orders.');
  }
}

main().catch((err) => {
  console.error('Measurement failed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
