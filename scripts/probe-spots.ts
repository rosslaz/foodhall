// PROBE (read-only): enumerate Konjo's zones + spots, joined, to find a spot
// under the TAKEOUT (or DELIVERY) zone group — the scheduling-capable kind
// per GoTab docs ("If the spot allows scheduling, which is typical of takeout
// and delivery orders..."). Zone groups visible in the dashboard: Dine-In
// (DINING), Takeout (TAKEOUT), Delivery (DELIVERY), E-Commerce (ECOMMERCE).
//
// Introspects Zone and Spot types first (field names are not guessed), then
// queries zonesList + spotsList and joins client-side. Paced under the 4rps
// GraphQL limit.
//
// Run:  npx tsx --env-file=.env scripts/probe-spots.ts

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';
const CURRENT_PROBE_SPOT = 'spt_Fo3Not1quvTWJobPfptx7H_A'; // the one that coerced to ASAP

const client = new GoTabClient(getGoTabAuth());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TypeRef { kind: string; name: string | null; ofType: TypeRef | null }
const scalarish = (t: TypeRef | null): boolean => {
  const unwrap = (x: TypeRef | null): string =>
    x ? (x.kind === 'NON_NULL' || x.kind === 'LIST' ? unwrap(x.ofType) : x.kind) : 'NONE';
  const k = unwrap(t);
  return k === 'SCALAR' || k === 'ENUM';
};

async function scalarFields(type: string): Promise<string[]> {
  const d = await client.graph<{
    __type: { fields: Array<{ name: string; type: TypeRef }> | null } | null;
  }>(
    `query { __type(name: "${type}") { fields { name type { kind name ofType { kind name ofType { kind name } } } } } }`,
    {},
  );
  return (d.__type?.fields ?? []).filter((f) => scalarish(f.type)).map((f) => f.name);
}

async function main() {
  const zoneFields = await scalarFields('Zone');
  console.log(`Zone scalar fields: ${zoneFields.join(', ') || '(no Zone type?)'}`);
  await sleep(400);
  const spotFields = await scalarFields('Spot');
  console.log(`Spot scalar fields: ${spotFields.join(', ') || '(no Spot type?)'}\n`);
  await sleep(400);

  const zoneWish = ['zoneId', 'zoneUuid', 'name', 'type', 'asapOnly',
    'asapOrderingEnabled', 'orderIntervalId', 'openTabOnly', 'requiresAddress',
    'available', 'hidden', 'kdsConfigs'];
  const spotWish = ['spotId', 'spotUuid', 'name', 'urlName', 'zoneId', 'active',
    'enabled', 'scheduled', 'allowScheduling'];
  const zq = zoneWish.filter((w) => zoneFields.includes(w));
  const sq = spotWish.filter((w) => spotFields.includes(w));
  // Also include any zone/spot field that smells scheduling-related but wasn't
  // on the wishlist — the field NAMES are half of what we're here to learn.
  for (const f of zoneFields) if (/schedul|type|group/i.test(f) && !zq.includes(f)) zq.push(f);
  for (const f of spotFields) if (/schedul|type|zone/i.test(f) && !sq.includes(f)) sq.push(f);

  const d = await client.graph<{
    location: {
      zonesList: Array<Record<string, unknown>> | null;
      spotsList: Array<Record<string, unknown>> | null;
    } | null;
  }>(
    `query ($loc: String!) {
      location(locationUuid: $loc) {
        zonesList { ${zq.join(' ')} }
        spotsList { ${sq.join(' ')} }
      }
    }`,
    { loc: KONJO_LOC },
  );

  const zones = d.location?.zonesList ?? [];
  const spots = d.location?.spotsList ?? [];
  const zoneById = new Map(zones.map((z) => [String(z.zoneId), z]));

  console.log(`Zones (${zones.length}):`);
  for (const z of zones) console.log(`  ${JSON.stringify(z)}`);
  console.log(`\nSpots (${spots.length}):`);
  for (const s of spots) {
    const z = zoneById.get(String(s.zoneId));
    const marker = s.spotUuid === CURRENT_PROBE_SPOT ? '   <== the spot that coerced to ASAP' : '';
    console.log(`  ${JSON.stringify(s)}  zone=${z ? JSON.stringify(z) : '?'}${marker}`);
  }

  console.log('\nPick a spot whose zone belongs to the TAKEOUT (or DELIVERY) group and');
  console.log('paste its spt_ uuid into the SPOT knob in scripts/probe-open-tab.ts.');
  console.log('If NO spot lives under Takeout/Delivery: create a zone + spot inside the');
  console.log('Takeout group in the dashboard, then re-run this probe to grab the uuid.');
}

main().catch((err) => {
  console.error('Probe crashed:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
