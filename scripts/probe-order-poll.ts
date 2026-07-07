// PROBE v2: find order 133476673 via TARGETED lookups and read its timestamps.
//
// v1 FINDING (recorded): unfiltered `location { ordersList }` times out
// server-side ("canceling statement due to statement timeout"). GoTab will
// not return a location's full order history — every status lookup must be
// targeted (by-id Query fields, or ordersList with condition/first). This is
// a standing rule for the adapter and the Phase-G poller.
//
// The schema is PostGraphile-shaped (ordersList / orderByOrderUuid /
// condition), so the expected lookups are `orderByOrderId` and
// `orderByOrderUuid` on the Query root. This probe introspects the Query
// root's order-ish fields + their args, then tries, in order:
//   1. orderByOrderId(orderId: "<id>")      (BigInt serializes as string)
//   2. orderByOrderId(orderId: <id>)        (unquoted, if 1 type-errors)
//   3. location.ordersList(condition: { orderId: "<id>" })
//   4. location.ordersList(first: 25)       (client-side filter, last resort)
// First success wins; then polls and prints the Q1 verdict.
//
// Run:  npx tsx --env-file=.env scripts/probe-order-poll.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

// ── Knobs (defaults = the 2026-07-07 02:23Z probe run) ─────────────────────
const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const TARGET_ORDER_ID = '133490055'; // adapter smoke order, 2026-07-07 16:46Z
const OUR_SCHEDULED_ISO = '2026-07-07T16:46:07.844Z'; // acceptedAt (ASAP — no schedule requested)
const POLL_INTERVAL_MS = 15_000;
const MAX_POLLS = 12;
// ────────────────────────────────────────────────────────────────────────────

// Field list verified by v1 introspection (Order type, scalar/enum only).
const ORDER_FIELDS =
  'orderId orderUuid tabId status name created placed scheduled sent prepared fulfilled statusChanged dispatched recalled isAsap orderPrepTimeMs locationUuid';

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GoTab tz-less timestamps are UTC (verified 2026-07-07) — append Z.
function parseGoTabTs(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(withZone);
  return isNaN(d.getTime()) ? null : d;
}
const fmtDelta = (ms: number) => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)}s`;

type Snap = Record<string, unknown>;

// Introspect Query-root order-ish fields with arg names/types (informational
// + tells us which lookups exist before we try them).
async function introspectQueryLookups(): Promise<Set<string>> {
  const d = await client.graph<{
    __type: { fields: Array<{ name: string; args: Array<{ name: string; type: { kind: string; name: string | null; ofType: { name: string | null } | null } }> }> } | null;
  }>(
    `query { __type(name: "Query") { fields { name args { name type { kind name ofType { name } } } } } }`,
    {},
  );
  const fields = d.__type?.fields ?? [];
  const orderish = fields.filter((f) => /^order/i.test(f.name));
  console.log('Query-root order lookups:');
  for (const f of orderish) {
    const args = f.args
      .map((a) => `${a.name}: ${a.type.name ?? a.type.ofType?.name ?? a.type.kind}`)
      .join(', ');
    console.log(`  ${f.name}(${args})`);
  }
  return new Set(orderish.map((f) => f.name));
}

// The attempt chain. Each returns a snapshot or throws; caller advances.
type Fetcher = { label: string; run: () => Promise<Snap | null> };

function buildFetchers(available: Set<string>): Fetcher[] {
  const fetchers: Fetcher[] = [];
  if (available.has('orderByOrderId')) {
    fetchers.push({
      label: `orderByOrderId(orderId: "${TARGET_ORDER_ID}")`,
      run: async () => {
        const d = await client.graph<{ order: Snap | null }>(
          `query { order: orderByOrderId(orderId: "${TARGET_ORDER_ID}") { ${ORDER_FIELDS} } }`, {},
        );
        return d.order;
      },
    });
    fetchers.push({
      label: `orderByOrderId(orderId: ${TARGET_ORDER_ID}) [unquoted]`,
      run: async () => {
        const d = await client.graph<{ order: Snap | null }>(
          `query { order: orderByOrderId(orderId: ${TARGET_ORDER_ID}) { ${ORDER_FIELDS} } }`, {},
        );
        return d.order;
      },
    });
  }
  fetchers.push({
    label: 'location.ordersList(condition: { orderId })',
    run: async () => {
      const d = await client.graph<{ location: { ordersList: Snap[] | null } | null }>(
        `query ($loc: String!) {
          location(locationUuid: $loc) {
            ordersList(condition: { orderId: "${TARGET_ORDER_ID}" }) { ${ORDER_FIELDS} }
          }
        }`,
        { loc: KONJO_LOC },
      );
      return d.location?.ordersList?.[0] ?? null;
    },
  });
  fetchers.push({
    label: 'location.ordersList(first: 25) [client filter]',
    run: async () => {
      const d = await client.graph<{ location: { ordersList: Snap[] | null } | null }>(
        `query ($loc: String!) {
          location(locationUuid: $loc) { ordersList(first: 25) { ${ORDER_FIELDS} } }
        }`,
        { loc: KONJO_LOC },
      );
      return (d.location?.ordersList ?? []).find((o) => String(o.orderId) === TARGET_ORDER_ID) ?? null;
    },
  });
  return fetchers;
}

async function main() {
  const available = await introspectQueryLookups();
  const fetchers = buildFetchers(available);

  // Find the fetcher that works (a null result = lookup works, order absent —
  // also informative; keep it as the answer channel and report null).
  let working: Fetcher | null = null;
  let first: Snap | null = null;
  for (const f of fetchers) {
    try {
      console.log(`\nTrying: ${f.label}`);
      first = await f.run();
      working = f;
      console.log(`  WORKS. ${first ? 'Order found.' : 'Lookup succeeded but returned null (order not visible via this path).'}`);
      if (first) break;
    } catch (err) {
      console.log(`  failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  }
  if (!working || !first) {
    console.log('\nNo lookup path returned the order. Record the failures above; the order');
    console.log(`exists (dashboard shows the tab) — likely a different lookup/arg shape is needed.`);
    process.exit(1);
  }

  console.log(`\nUsing "${working.label}". Polling every ${POLL_INTERVAL_MS / 1000}s.\n`);
  const ourScheduled = new Date(OUR_SCHEDULED_ISO);
  let lastLine = '';
  let snap: Snap | null = first;

  for (let i = 0; i < MAX_POLLS; i++) {
    if (i > 0) {
      await sleep(POLL_INTERVAL_MS);
      try { snap = await working.run(); } catch (err) {
        console.log(`(poll error: ${err instanceof Error ? err.message.slice(0, 120) : err})`);
        continue;
      }
    }
    if (!snap) { console.log('(order vanished from lookup?)'); continue; }
    const line = JSON.stringify(snap);
    if (line === lastLine) { process.stdout.write('.'); continue; }
    lastLine = line;
    console.log(`\n[poll ${i + 1}] ${JSON.stringify(snap, null, 2)}`);

    const sched = parseGoTabTs(snap.scheduled as string) ?? ourScheduled;
    const sent = parseGoTabTs(snap.sent as string);
    const created = parseGoTabTs(snap.created as string) ?? parseGoTabTs(snap.placed as string);
    if (sent) {
    console.log('\n─── Q1 ANSWER ───');
    console.log(`our scheduledFor:  ${OUR_SCHEDULED_ISO}`);
    console.log(`scheduled (GoTab): ${snap.scheduled ?? '(null — field not set by our create!)'}`);
    console.log(`sent:              ${snap.sent}`);
    console.log(`isAsap:            ${snap.isAsap}`);
    console.log(`sent − scheduled = ${fmtDelta(sent.getTime() - sched.getTime())}`);
    if (created) console.log(`sent − created   = ${fmtDelta(sent.getTime() - created.getTime())}`);
    // VERDICT GUARD (2026-07-07): on an ASAP order GoTab sets
    // scheduled=placed itself, making sent−scheduled trivially tiny — that
    // is NOT evidence of held scheduling. Only isAsap:false + an echoed
    // future timestamp counts.
    if (snap.isAsap === true) {
    console.log('=> isAsap:true — ASAP order (no schedule requested, or schedule did not take).');
      console.log('   Held-scheduling verdict: N/A on this order. Compare GoTab timestamps only');
    console.log('   (local clock skew vs GoTab observed ~1s — never mix clocks).');
    } else {
          const vsCreation = created ? Math.abs(sent.getTime() - created.getTime()) : Infinity;
          const vsSchedule = Math.abs(sent.getTime() - sched.getTime());
          if (vsSchedule < 60_000 && vsCreation > 60_000) {
            console.log('=> isAsap:false and fired near the echoed timestamp — GoTab HELD the order. holdsSchedule VIABLE.');
          } else {
            console.log('=> isAsap:false but firing pattern unclear — inspect raw values above.');
          }
        }
      if (snap.prepared) {
        console.log(`prepared: ${snap.prepared} — full lifecycle observed. Done.`);
        return;
      }
      console.log('\nBump the order in the Konjo KDS to exercise `prepared`; polling continues...');
    } else {
      console.log('(no `sent` yet — GoTab is still holding the order.)');
    }
  }
  console.log('\nPoll limit reached — record the last snapshot.');
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
