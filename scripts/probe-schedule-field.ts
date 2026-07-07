// PROBE: discover the REAL scheduling field for order creation by
// introspecting GoTab's GraphQL Mutation inputs — instead of guessing REST
// body shapes one stranded tab at a time.
//
// CONTEXT (2026-07-07): REST createTab with top-level `scheduled` was
// silently IGNORED — order came back isAsap: true, GoTab.scheduled = placed,
// fired 200ms after creation. The Order type carries `isAsap` and
// `orderIntervalTypeId`, suggesting scheduling lives in an "interval"
// concept. If the schema exposes createTab/addTabItems-ish mutations, their
// INPUT types name the real fields.
//
// This probe is READ-ONLY (introspection only — creates nothing).
//
// Run:  npx tsx --env-file=.env scripts/probe-schedule-field.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

const client = new GoTabClient(getGoTabAuth());

interface TypeRef { kind: string; name: string | null; ofType: TypeRef | null }
const typeName = (t: TypeRef | null): string =>
  t ? (t.name ?? typeName(t.ofType)) : '?';

async function fields(type: string) {
  const d = await client.graph<{
    __type: {
      fields: Array<{ name: string; args: Array<{ name: string; type: TypeRef }>; type: TypeRef }> | null;
      inputFields: Array<{ name: string; type: TypeRef }> | null;
    } | null;
  }>(
    `query { __type(name: "${type}") {
      fields { name type { kind name ofType { kind name ofType { kind name } } } args { name type { kind name ofType { kind name ofType { kind name } } } } }
      inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
    } }`,
    {},
  );
  return d.__type;
}

async function enumValues(type: string) {
  const d = await client.graph<{ __type: { enumValues: Array<{ name: string }> | null } | null }>(
    `query { __type(name: "${type}") { enumValues { name } } }`, {},
  );
  return d.__type?.enumValues?.map((v) => v.name) ?? null;
}

async function main() {
  // 1) Mutation root: anything tab/order-ish?
  const mut = await fields('Mutation');
  const interesting = (mut?.fields ?? []).filter((f) => /tab|order|schedul/i.test(f.name));
  console.log(`Mutation root: ${mut?.fields?.length ?? 0} total fields. Tab/order/schedule-ish:`);
  for (const f of interesting) {
    const args = f.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(', ');
    console.log(`  ${f.name}(${args})`);
  }

  // 2) For each createTab/addItems-ish mutation, dump its input type's fields
  //    one level deep — the field names ARE the answer.
  const createish = interesting.filter((f) => /create|add|place|submit/i.test(f.name));
  const dumped = new Set<string>();
  for (const f of createish) {
    for (const a of f.args) {
      const t = typeName(a.type);
      if (t === '?' || dumped.has(t)) continue;
      dumped.add(t);
      const inner = await fields(t);
      const inputs = inner?.inputFields ?? inner?.fields ?? [];
      if (!inputs.length) continue;
      console.log(`\nInput type ${t} (arg "${a.name}" of ${f.name}):`);
      for (const i of inputs) console.log(`  ${i.name}: ${typeName(i.type)}`);
      // One more level for anything schedule/interval/order-detail flavored.
      for (const i of inputs.filter((x) => /schedul|interval|detail|order|item/i.test(x.name))) {
        const it = typeName(i.type);
        if (dumped.has(it)) continue;
        dumped.add(it);
        const deep = await fields(it);
        const deepInputs = deep?.inputFields ?? deep?.fields ?? [];
        if (deepInputs.length) {
          console.log(`    ${it}:`);
          for (const di of deepInputs) console.log(`      ${di.name}: ${typeName(di.type)}`);
        }
      }
    }
  }

  // 3) The interval concept: what is OrderIntervalType?
  for (const t of ['OrderIntervalType', 'OrderInterval', 'Interval']) {
    const it = await fields(t);
    if (it?.fields?.length) {
      console.log(`\nType ${t}:`);
      for (const f of it.fields) console.log(`  ${f.name}: ${typeName(f.type)}`);
    }
  }
  // isAsap suggests an enum or type id domain — check for an enum.
  for (const e of ['OrderIntervalTypeEnum', 'IntervalType', 'OrderType']) {
    const vals = await enumValues(e);
    if (vals?.length) console.log(`\nEnum ${e}: ${vals.join(', ')}`);
  }

  console.log('\nDone. If a scheduling field appears above, that names the REST body field');
  console.log('(or gives us a GraphQL mutation to use instead of REST). If NOTHING');
  console.log('schedule-shaped appears, the answer is a Zach question: "what is the exact');
  console.log('request shape to create a SCHEDULED (isAsap: false) order via the API?"');
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
