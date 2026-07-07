// Pure spot-selection logic for GoTab ticket submission. Own module with NO
// config/prisma imports so unit tests run without booting the app (same rule
// as gotab-status.ts / gotab-availability.ts).
//
// WHY THIS EXISTS (2026-07-07): creating a tab requires a spotUuid, but our
// Vendor model carries only gotabLocationId — no spot. Rather than a
// migration, the adapter discovers a spot per location at runtime (spotsList +
// zonesList, cached for process lifetime) and this function picks which one.
// A per-vendor override column is the recorded production follow-up.
//
// Selection rules, in order:
//   1. Exclude hidden/archived spots and spots whose zone is hidden or
//      explicitly unavailable. (A spot with an UNKNOWN zone is kept — zone
//      data missing is not evidence of a problem.)
//   2. Prefer spots whose zone has asapOnly === false: harmless today (we
//      submit ASAP orders in we-hold-timers mode) and future-proof for the
//      holdsSchedule flip, where an asapOnly zone would coerce scheduled
//      orders to ASAP (verified 2026-07-07, order 133476673).
//   3. Deterministic tiebreak: ascending numeric spotId — stable across runs.

export interface GoTabSpotRow {
  spotId: string | number;
  spotUuid: string;
  name: string | null;
  zoneId: string | number | null;
  hidden?: boolean | null;
  archived?: boolean | null;
}

export interface GoTabZoneRow {
  zoneId: string | number;
  name?: string | null;
  asapOnly?: boolean | null;
  hidden?: boolean | null;
  available?: boolean | null;
}

export function chooseSubmitSpot(
  spots: GoTabSpotRow[],
  zones: GoTabZoneRow[],
): GoTabSpotRow | null {
  const zoneById = new Map(zones.map((z) => [String(z.zoneId), z]));

  const candidates = spots.filter((s) => {
    if (s.hidden === true || s.archived === true) return false;
    const zone = s.zoneId != null ? zoneById.get(String(s.zoneId)) : undefined;
    if (zone && (zone.hidden === true || zone.available === false)) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  const rank = (s: GoTabSpotRow): number => {
    const zone = s.zoneId != null ? zoneById.get(String(s.zoneId)) : undefined;
    return zone?.asapOnly === false ? 0 : 1; // scheduling-capable zones first
  };
  candidates.sort((a, b) => rank(a) - rank(b) || Number(a.spotId) - Number(b.spotId));
  return candidates[0] ?? null;
}
