// PROBE (throwaway): discover how GoTab's three dashboard availability states
// (Available / Unavailable / Hidden) map onto Product fields.
//
// Run (server can stay up; this script touches no DB, only GoTab reads):
//   npx tsx --env-file=.env scripts/probe-gotab-availability.ts
//
// Procedure:
//   1. Run once as a BASELINE (all four Konjo items "Available").
//   2. In the GoTab dashboard, set "Konjo Me Test Item 4" to UNAVAILABLE.
//      Run again.
//   3. Set the same item to HIDDEN. Run again.
//   4. Set it back to AVAILABLE (leave the sandbox clean). Run once more.
// Diff the outputs between runs — whichever fields flip are the mapping.
//
// The script introspects the Product type first and automatically includes any
// scalar/enum fields whose names look availability-related, so a field we have
// never queried (e.g. a hidden/visibility flag) is caught too.

import { getGoTabAuth } from '../src/vendor-adapter/gotab-auth.js';
import { GoTabClient } from '../src/vendor-adapter/gotab-client.js';

const KONJO_LOC = 'ZQFbjpg06x4rf1w08RTuOhGa';

// Always queried (known-good from the import feature).
const BASE_FIELDS = [
  'name',
  'productUuid',
  'productType',
  'basePrice',
  'prepTime',
  'orderEnabled',
  'available',
];

// Any additional Product scalar/enum field matching this is availability-ish
// enough to watch.
const INTERESTING = /(avail|hidden|visib|enable|active|status|display|show|menu|stock|sold|archiv|delet)/i;

interface IntrospectedField {
  name: string;
  type: { kind: string; name: string | null; ofType: { kind: string; name: string | null } | null };
}

function isScalarish(t: IntrospectedField['type']): boolean {
  const unwrap = (x: { kind: string; name: string | null; ofType?: unknown } | null): string =>
    x ? (x.kind === 'NON_NULL' || x.kind === 'LIST'
      ? unwrap(x.ofType as never)
      : x.kind)
      : 'NONE';
  const kind = unwrap(t as never);
  return kind === 'SCALAR' || kind === 'ENUM';
}

async function main() {
  const client = new GoTabClient(getGoTabAuth());

  // --- Step 1: introspect the Product type for extra availability-ish fields.
  let extraFields: string[] = [];
  try {
    const intro = await client.graph<{
      __type: { name: string; fields: IntrospectedField[] } | null;
    }>(
      `query { __type(name: "Product") { name fields { name type { kind name ofType { kind name } } } } }`,
      {},
    );
    if (intro.__type?.fields) {
      const all = intro.__type.fields;
      extraFields = all
        .filter((f) => isScalarish(f.type))
        .map((f) => f.name)
        .filter((n) => INTERESTING.test(n) && !BASE_FIELDS.includes(n));
      console.log(`Product type has ${all.length} fields.`);
      console.log(
        'All scalar/enum field names:',
        all.filter((f) => isScalarish(f.type)).map((f) => f.name).join(', '),
      );
      console.log('Extra availability-ish fields being queried:', extraFields.join(', ') || '(none)');
    } else {
      console.log(
        'Introspection returned no type named "Product" — proceeding with base fields only.',
      );
    }
  } catch (err) {
    console.log(
      `Introspection failed (${err instanceof Error ? err.message : err}) — proceeding with base fields only.`,
    );
  }

  // --- Step 2: dump Konjo's products with base + discovered fields.
  const fieldList = [...BASE_FIELDS, ...extraFields].join('\n          ');
  const query = `query ($loc: String!) {
    location(locationUuid: $loc) {
      name
      productsList {
          ${fieldList}
      }
    }
  }`;

  const data = await client.graph<{
    location: { name: string | null; productsList: Array<Record<string, unknown>> | null } | null;
  }>(query, { loc: KONJO_LOC });

  const loc = data.location;
  if (!loc) {
    console.error('Location came back null — check the UUID / credentials.');
    process.exit(1);
  }
  console.log(`\nLocation: ${loc.name}`);
  console.log(`Products (${loc.productsList?.length ?? 0}):\n`);
  for (const p of loc.productsList ?? []) {
    console.log(JSON.stringify(p));
  }
}

main().catch((err) => {
  console.error('Probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
