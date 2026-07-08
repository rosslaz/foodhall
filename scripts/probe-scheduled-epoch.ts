// PROBE: confirm Zach's two claims (2026-07-08 reply):
//   (a) the real field is `scheduledDate` taking UNIX EPOCH SECONDS (docs say
//       ISO — wrong, he'll fix them), and
//   (b) a VALID schedule + openTab:true throws an explicit hard error
//       ("Open tabs cannot be scheduled") — open tabs and scheduled orders
//       are mutually exclusive.
//
// Reconciliation this tests: we previously sent `scheduled` as an ISO string
// and saw SILENT ASAP coercion, not an error — consistent with Zach iff our
// value was never parsed as valid (wrong name and/or format). So:
//   EXPECTED SUCCESS OF THIS PROBE = an explicit rejection on attempt A.
//   (A rejection strands NO tab.)
// If attempt A is silently ACCEPTED instead, the field name is still wrong —
// attempt B tries `scheduled` with epoch seconds. Any acceptance is checked
// ~3s later for isAsap/scheduled to see whether it actually took (which would
// contradict the mutual-exclusivity rule — report loudly).
//
// Run:  npx tsx --env-file=.env scripts/probe-scheduled-epoch.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const SPOT = 'spt_Xfg6nOcE0yL2EmwTDzpRmac6'; // Pickup Counter (asapOnly:false zone)
const ITEM1 = 'prd_o1ypp85ndHldLmCbgjoQZIA2';

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOrder(orderId: string) {
  const d = await client.graph<{ location: { ordersList: Array<Record<string, unknown>> | null } | null }>(
    `query ($loc: String!) {
      location(locationUuid: $loc) {
        ordersList(condition: { orderId: "${orderId}" }) { orderId status isAsap scheduled sent }
      }
    }`,
    { loc: KONJO_LOC },
  );
  return d.location?.ordersList?.[0] ?? null;
}

async function attempt(fieldName: 'scheduledDate' | 'scheduled') {
  const epochSeconds = Math.floor(Date.now() / 1000) + 3 * 60; // T+3min
  const body: Record<string, unknown> = {
    openTab: true,
    spotUuid: SPOT,
    name: `EpochProbe ${fieldName} ${new Date().toISOString().slice(11, 19)}`,
    items: [{ product: { productUuid: ITEM1 }, quantity: 1 }],
    [fieldName]: epochSeconds,
  };
  console.log(`\nAttempt: ${fieldName} = ${epochSeconds} (epoch seconds, T+3min) with openTab:true`);
  try {
    const resp = await client.locPost<{ data?: { tabUuid?: string; orders?: Array<{ orderId?: string | number }> } }>(
      KONJO_LOC,
      'tabs',
      body,
    );
    const orderId = String(resp.data?.orders?.[0]?.orderId ?? '');
    console.log(`  ACCEPTED (no error). orderId=${orderId} tabUuid=${resp.data?.tabUuid} (stranded — settle later)`);
    if (orderId) {
      await sleep(3000);
      const row = await fetchOrder(orderId);
      console.log(`  3s later: ${JSON.stringify(row)}`);
      if (row?.isAsap === false) {
        console.log('  !! isAsap:false — the schedule TOOK on an OPEN tab, contradicting the');
        console.log('     mutual-exclusivity rule. Report this to Zach verbatim.');
        return 'TOOK';
      }
      console.log('  isAsap:true — accepted but IGNORED (field/format still not parsed as valid).');
      return 'IGNORED';
    }
    return 'IGNORED';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  REJECTED: ${msg}`);
    if (/open tab.*schedul|schedul.*open tab/i.test(msg)) {
      console.log('  ^ THE EXPECTED ERROR — field+format parsed as VALID, mutual-exclusivity confirmed.');
      return 'CONFIRMED';
    }
    console.log('  ^ Rejected for a DIFFERENT reason — read the message; may be format/validation.');
    return 'OTHER_ERROR';
  }
}

async function main() {
  const a = await attempt('scheduledDate');
  // Run B unconditionally (2026-07-08): A returned a 500, so B now separates
  // FIELD from FORMAT as the trigger — and repeating A checks whether the 500
  // is deterministic or transient.
  const b = await attempt('scheduled');

  console.log('\n─── SUMMARY (for the Zach reply) ───');
  console.log(`scheduledDate + epoch + openTab:true -> ${a}`);
  console.log(`scheduled     + epoch + openTab:true -> ${b}`);
  console.log('CONFIRMED = his hard rule reproduced. OTHER_ERROR(500) = the rule (or the');
  console.log('epoch parse) surfaces as an unmapped internal error — give Zach the exact');
  console.log('UTC timestamps above so he can find the stack trace in their logs.');
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
