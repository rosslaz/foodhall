// PROBE v2 (read-only): goGetScheduleIntersectionSpans with the REAL input
// shape learned from v1's introspection:
//   input: { _locationId: BigInt, _timezone: String }   (location-scoped!)
//   payload: { results: GoGetScheduleIntersectionSpansRecord, query, clientMutationId }
// v1 also showed my payload auto-selection wrongly expanded `query: Query`;
// this version selects ONLY `results` with introspected subfields.
//
// Run:  npx tsx --env-file=.env scripts/probe-schedule-spans.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

const KONJO_LOC_UUID = 'ZQFbjpg06x4rf1w08RTuOhGa';
const TIMEZONE = 'America/Detroit';

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TypeRef { kind: string; name: string | null; ofType: TypeRef | null }
const typeName = (t: TypeRef | null): string => (t ? t.name ?? typeName(t.ofType) : '?');
const isScalar = (n: string) => /^(String|Int|Float|Boolean|ID|BigInt|Datetime|Date|Time|Cursor|JSON)$/i.test(n);

async function fieldsOf(name: string) {
  const d = await client.graph<{
    __type: { fields: Array<{ name: string; type: TypeRef }> | null } | null;
  }>(
    `query { __type(name: "${name}") { fields { name type { kind name ofType { kind name ofType { kind name } } } } } }`,
    {},
  );
  return d.__type?.fields ?? [];
}

async function main() {
  // 1) numeric locationId from the uuid
  const loc = await client.graph<{ location: { locationId: string; name: string } | null }>(
    `query ($loc: String!) { location(locationUuid: $loc) { locationId name } }`,
    { loc: KONJO_LOC_UUID },
  );
  if (!loc.location) { console.error('location lookup failed'); process.exit(1); }
  console.log(`Location: ${loc.location.name} (locationId=${loc.location.locationId})`);
  await sleep(350);

  // 2) results selection from the record type (one level, expand objects once)
  const recFields = await fieldsOf('GoGetScheduleIntersectionSpansRecord');
  console.log(`Record fields: ${recFields.map((f) => `${f.name}: ${typeName(f.type)}`).join(', ')}`);
  const parts: string[] = [];
  for (const f of recFields) {
    const tn = typeName(f.type);
    if (isScalar(tn)) { parts.push(f.name); continue; }
    await sleep(300);
    const inner = await fieldsOf(tn);
    const innerScalars = inner.filter((x) => isScalar(typeName(x.type))).map((x) => x.name);
    parts.push(innerScalars.length ? `${f.name} { ${innerScalars.join(' ')} }` : f.name);
  }
  const selection = parts.length ? parts.join(' ') : '__typename';
  console.log(`Selecting: results { ${selection} }`);
  await sleep(350);

  // 3) the call
  const input = { _locationId: loc.location.locationId, _timezone: TIMEZONE };
  console.log(`Calling with input: ${JSON.stringify(input)}\n`);
  const res = await client.graph<Record<string, unknown>>(
    `mutation ($input: GoGetScheduleIntersectionSpansInput!) {
      goGetScheduleIntersectionSpans(input: $input) { results { ${selection} } }
    }`,
    { input },
  );
  console.log('RESULT:');
  console.log(JSON.stringify(res, null, 2));
  console.log('\nEMPTY/null => GoTab sees NO scheduling windows for this location =>');
  console.log('root cause of ASAP coercion confirmed, and it is not configurable from any');
  console.log('dashboard surface we have found => Zach email. NON-EMPTY => windows exist');
  console.log('and something else blocks scheduling => also Zach, different evidence.');
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
