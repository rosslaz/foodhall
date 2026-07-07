import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getGoTabAuth } from './gotab-auth.js';
import { classifyGoTabProduct } from './gotab-availability.js';
import { GoTabClient } from './gotab-client.js';
import { chooseSubmitSpot, type GoTabSpotRow, type GoTabZoneRow } from './gotab-spot.js';
import { mapGoTabStatus } from './gotab-status.js';
import type {
  SubmitTicketRequest,
  SubmitTicketResult,
  TicketStatusContext,
  VendorAdapter,
  VendorCatalog,
  VendorProduct,
  VendorTicketStatus,
} from './types.js';

// Real GoTab integration.
//
// STATUS (2026-07-07): submitTicket IMPLEMENTED in we-hold-timers mode
// (holdsSchedule = false) against the empirically verified open-tab path.
// The holdsSchedule fork is RESOLVED-TO-FALSE-FOR-NOW:
//   - Order creation works: openTab:true, no payments[] (Zach, 2026-07-02;
//     verified live 2026-07-06 — orders reach SENT in ~200ms).
//   - GoTab-HELD scheduling does NOT work yet: every API order is coerced to
//     ASAP regardless of zone config (isAsap:true, scheduled defaulted to
//     placed; verified on two zones incl. one built with asapOnly:false).
//     Zone order-interval config appears required and is not reachable from
//     any surface we have — escalated to Zach 2026-07-07. If his answer makes
//     it real, flip holdsSchedule to true: the `scheduled` seam is already in
//     the request body below, gated on the flag. Until then ASAP-at-fire-time
//     is exactly what we-hold-timers mode wants.
//
// ADAPTER LAW (project doc, 2026-07-06/07 — all encoded in this file + client):
//   1. Targeted lookups only. Bare location{ordersList} TIMES OUT server-side.
//      Proven fast: ordersList(condition:{orderId}). Status ctx carries the
//      vendor location for exactly this.
//   2. GraphQL is rate-limited at 4rps — the client paces (280ms spacing) and
//      retries 429 once. Do not add unpaced loops.
//   3. Timestamps arrive in MIXED formats (some +00:00, some tz-less UTC) —
//      parse via parseGoTabTimestamp (appends Z; JS parses tz-less as LOCAL).
//   4. Tildes appear in location, order, tab, AND zone uuids — REST path
//      segments must be encoded (client does this); GraphQL variables safe.
//   5. Order creation is REST-only (no GraphQL mutation exists).
//   6. Create response returns numeric orderId ONLY (no orderUuid) — the
//      external id we store IS the numeric orderId, and item `quantity` comes
//      back as a STRING.
//
// KNOWN LIMITS (recorded, accepted for POC):
//   - Idempotency: ticketId-keyed in-memory dedupe + the app's PENDING-only
//     guards. A process restart in the window between GoTab accepting and our
//     DB write can double-submit one ticket (sweep redrive) — the tab-level
//     externalId (= ticketId) makes duplicates identifiable in the dashboard.
//     Platform-side dedupe on externalId is unverified.
//   - cancelTicket remains 501: GoTab cancellation semantics unverified (2.4
//     investigation; also how stranded open tabs get closed).
//   - `prepared` unobservable in sandbox until a KDS display exists (asked).
//
// getTicketStatus status mapping (pure fn, unit-tested in gotab-status.ts):
//   GoTab PENDING / SCHEDULED          -> 'SCHEDULED'   (accepted, not at kitchen)
//   GoTab SENT (fired, not prepared)   -> 'IN_PROGRESS' (cooking)
//   `prepared` timestamp set           -> 'READY'
//   (cancelled)                        -> 'CANCELLED'

// GoTab timestamps: tz-less strings are UTC (verified 2026-07-07). JS parses
// tz-less as LOCAL — append Z before parsing or every delta is off by the UTC
// offset. Exported for reuse (reconcile/telemetry later).
export function parseGoTabTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(withZone);
  return isNaN(d.getTime()) ? null : d;
}

// Shape of the createTab REST response we rely on (verified live 2026-07-06).
interface CreateTabResponse {
  data?: {
    tabId?: string | number;
    tabUuid?: string;
    orders?: Array<{ orderId?: string | number }>;
  };
}

// Order row shape for status lookups (fields verified via introspection +
// live reads, 2026-07-07).
interface GoTabOrderRow {
  orderId: string | number;
  status: string | null;
  prepared: string | null;
}

const LATE_TARGET_FALLBACK_MS = 60_000;

export class GoTabAdapter implements VendorAdapter {
  readonly name = 'gotab';

  // RESOLVED-TO-FALSE-FOR-NOW (see header). We hold durable BullMQ timers and
  // submit ASAP orders at fire time. Flip to true ONLY when GoTab-held
  // scheduling is verified end-to-end (Zach escalation pending): the submit
  // body's `scheduled` seam below activates automatically on the flag.
  readonly holdsSchedule = false;

  private readonly client: GoTabClient;
  // Idempotency: ticketId -> result, process lifetime (mirrors the mock).
  private readonly submittedByTicket = new Map<string, SubmitTicketResult>();
  // Spot discovery cache: locationUuid -> spotUuid, process lifetime.
  private readonly spotByLocation = new Map<string, string>();

  constructor() {
    // Resolving auth validates that credentials exist; throws CONFIG otherwise.
    this.client = new GoTabClient(getGoTabAuth());
    if (config.VENDOR_ADAPTER === 'gotab') {
      logger.info('GoTab adapter constructed (submit path live: ASAP / we-hold-timers mode)');
    }
  }

  async submitTicket(req: SubmitTicketRequest): Promise<SubmitTicketResult> {
    // Idempotent on ticketId: BullMQ retries and sweep redrives are safe.
    const existing = this.submittedByTicket.get(req.ticketId);
    if (existing) {
      logger.info({ ticketId: req.ticketId }, 'gotab submit deduped (already submitted)');
      return existing;
    }

    // Every item must map to a GoTab product — createTab items reference
    // product.productUuid. Missing mapping = operator config error: terminal,
    // named, not retryable (the sweep would just fail it identically).
    const unmapped = req.items.filter((i) => !i.gotabProductUuid);
    if (unmapped.length > 0) {
      throw new AppError(
        400,
        'GOTAB_UNMAPPED_ITEMS',
        `Ticket ${req.ticketId} has items with no GoTab product mapping: ` +
          unmapped.map((i) => i.name).join(', ') +
          '. Link them to GoTab products (re-import) or remove them.',
      );
    }

    const spotUuid = await this.resolveSpot(req.vendorLocationId);
    const now = new Date();

    // Item notes: forwarded at the ORDER level (documented top-level `notes`
    // string) rather than per-item — the per-item notes shape is an object
    // with unverified keys; don't guess. Capped for sanity.
    const noteParts = req.items
      .filter((i) => i.notes)
      .map((i) => `${i.name}: ${i.notes}`);
    const notes = noteParts.length > 0 ? noteParts.join('; ').slice(0, 200) : undefined;

    const body = {
      externalId: req.ticketId, // provenance + future webhook/dedupe lookup key
      openTab: true, // the unblock: no payments[] required on open tabs
      spotUuid,
      name: `FoodHall ${req.ticketId.slice(0, 8)}`,
      items: req.items.map((i) => ({
        product: { productUuid: i.gotabProductUuid! },
        quantity: i.qty,
      })),
      ...(notes ? { notes } : {}),
      // The holdsSchedule flip seam: in we-hold-timers mode we deliberately
      // send NO `scheduled` field — ASAP firing at submit time is the point.
      // When the flag flips (GoTab-held verified), future fire times ride here.
      ...(this.holdsSchedule && req.scheduledFor > now
        ? { scheduled: req.scheduledFor.toISOString() }
        : {}),
    };

    const resp = await this.client.locPost<CreateTabResponse>(
      req.vendorLocationId,
      'tabs',
      body,
    );

    const orderId = resp.data?.orders?.[0]?.orderId;
    if (orderId == null) {
      throw new AppError(
        502,
        'GOTAB_NO_ORDER_ID',
        `GoTab createTab returned no order id for ticket ${req.ticketId}: ` +
          JSON.stringify(resp).slice(0, 300),
      );
    }

    const result: SubmitTicketResult = {
      externalOrderId: String(orderId),
      acceptedAt: now,
      estimatedReadyAt:
        req.targetReadyAt > now
          ? req.targetReadyAt
          : new Date(now.getTime() + LATE_TARGET_FALLBACK_MS),
    };
    this.submittedByTicket.set(req.ticketId, result);
    logger.info(
      {
        ticketId: req.ticketId,
        externalOrderId: result.externalOrderId,
        tabUuid: resp.data?.tabUuid, // no column for this yet — log is the record
        spotUuid,
        items: req.items.length,
      },
      'gotab ticket submitted (open tab, ASAP)',
    );
    return result;
  }

  async getTicketStatus(
    externalOrderId: string,
    ctx?: TicketStatusContext,
  ): Promise<VendorTicketStatus> {
    // External ids are GoTab's numeric orderIds (see header §6). Validate
    // before inlining into the query — also guards legacy/foreign ids.
    if (!/^\d+$/.test(externalOrderId)) {
      throw new AppError(
        400,
        'GOTAB_BAD_ORDER_ID',
        `Not a GoTab numeric order id: ${externalOrderId}`,
      );
    }

    let order: GoTabOrderRow | null | undefined;
    if (ctx?.vendorLocationId) {
      // The PROVEN lookup (adapter law §1): location-scoped, condition-indexed.
      const data = await this.client.graph<{
        location: { ordersList: GoTabOrderRow[] | null } | null;
      }>(
        `query ($loc: String!) {
          location(locationUuid: $loc) {
            ordersList(condition: { orderId: "${externalOrderId}" }) {
              orderId status prepared
            }
          }
        }`,
        { loc: ctx.vendorLocationId },
      );
      order = data.location?.ordersList?.[0];
    } else {
      // Fallback: top-level PK lookup. Schema-verified to exist
      // (order(orderId: BigInt)); first exercised by the conformance smoke.
      const data = await this.client.graph<{ order: GoTabOrderRow | null }>(
        `query { order(orderId: "${externalOrderId}") { orderId status prepared } }`,
        {},
      );
      order = data.order;
    }

    if (!order) {
      throw new AppError(404, 'GOTAB_ORDER_NOT_FOUND', `GoTab order ${externalOrderId} not found`);
    }
    return mapGoTabStatus(order.status, order.prepared);
  }

  async cancelTicket(_externalOrderId: string): Promise<void> {
    // GoTab cancellation semantics are unverified (what is cancellable after
    // an order is SENT; how open tabs are closed without settlement). 2.4
    // investigation item — also the answer to stranded-tab hygiene. Until
    // verified, failing loudly beats silently pretending a kitchen stopped.
    throw new AppError(
      501,
      'NOT_IMPLEMENTED',
      'GoTab cancelTicket not yet implemented (cancellability rules unverified)',
    );
  }

  // Discover a submit spot for a location (spotsList + zonesList, one query,
  // cached for process lifetime). Selection logic is pure + unit-tested in
  // gotab-spot.ts. Production follow-up: per-vendor override column.
  private async resolveSpot(locationUuid: string): Promise<string> {
    const cached = this.spotByLocation.get(locationUuid);
    if (cached) return cached;

    const data = await this.client.graph<{
      location: {
        spotsList: GoTabSpotRow[] | null;
        zonesList: GoTabZoneRow[] | null;
      } | null;
    }>(
      `query ($loc: String!) {
        location(locationUuid: $loc) {
          spotsList { spotId spotUuid name zoneId hidden archived }
          zonesList { zoneId name asapOnly hidden available }
        }
      }`,
      { loc: locationUuid },
    );

    const spot = chooseSubmitSpot(
      data.location?.spotsList ?? [],
      data.location?.zonesList ?? [],
    );
    if (!spot) {
      throw new AppError(
        400,
        'GOTAB_NO_SPOT',
        `No usable spot found at GoTab location ${locationUuid} — create a visible spot ` +
          '(dashboard: Zones) before submitting orders to this vendor.',
      );
    }
    this.spotByLocation.set(locationUuid, spot.spotUuid);
    logger.info(
      { locationUuid, spotUuid: spot.spotUuid, spotName: spot.name },
      'gotab submit spot resolved (cached for process lifetime)',
    );
    return spot.spotUuid;
  }

  // List a location's orderable products, for menu import/onboarding.
  //
  // UNBLOCKED: this is a pure catalog READ via GraphQL productsList — verified
  // working in the sandbox (project doc "Products"), independent of the
  // submit/settlement blocker. Mapping rules (all confirmed against Konjo):
  //   - price: basePrice/displayPrice are in CENTS already. Use basePrice.
  //   - productType CUSTOM = back-office payment instruments (Cash Payment,
  //     Write-Off, etc.), NOT menu items — filter them out. Keep DEFAULT.
  //   - prepTime is in MINUTES; ×60 to seconds. Treat both null AND 0 as
  //     "unset" -> null (own prep table is the source of truth; admin fills in).
  //   - availability: classified via gotab-availability.ts (empirically
  //     verified tri-state; enableTimestamp discriminates 86'd vs hidden).
  //     HIDDEN and CUSTOM are dropped; UNAVAILABLE (86'd) products ARE
  //     returned, flagged, so the import can carry them as available:false.
  async listProducts(locationUuid: string): Promise<VendorCatalog> {
    const query = `query ($loc: String!) {
      location(locationUuid: $loc) {
        name
        productsList {
          name
          productUuid
          productType
          basePrice
          prepTime
          orderEnabled
          available
          enableTimestamp
        }
      }
    }`;
    const data = await this.client.graph<{
      location: {
        name: string | null;
        productsList: Array<{
          name: string;
          productUuid: string;
          productType: string | null;
          basePrice: number | null;
          prepTime: number | null;
          orderEnabled: boolean | null;
          available: boolean | null;
          enableTimestamp: string | null;
        }> | null;
      } | null;
    }>(query, { loc: locationUuid });

    const list = data.location?.productsList ?? [];
    const products: VendorProduct[] = [];
    let hiddenOrCustom = 0;
    for (const p of list) {
      const disposition = classifyGoTabProduct(p);
      if (disposition === 'CUSTOM' || disposition === 'HIDDEN') {
        hiddenOrCustom++;
        continue;
      }
      // prepTime: minutes -> seconds; null or 0 -> unset (null).
      const prepSeconds =
        p.prepTime && p.prepTime > 0 ? Math.round(p.prepTime * 60) : null;
      products.push({
        gotabProductUuid: p.productUuid,
        name: p.name,
        priceCents: p.basePrice ?? 0,
        prepSeconds,
        availability: disposition,
      });
    }
    logger.info(
      {
        locationUuid,
        total: list.length,
        returned: products.length,
        unavailable: products.filter((p) => p.availability === 'UNAVAILABLE').length,
        skippedHiddenOrCustom: hiddenOrCustom,
      },
      'listed GoTab products for import',
    );
    return { locationName: data.location?.name ?? null, products };
  }
}
