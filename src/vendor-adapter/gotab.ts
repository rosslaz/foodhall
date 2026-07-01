import { config } from '../config/index.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getGoTabAuth } from './gotab-auth.js';
import { GoTabClient } from './gotab-client.js';
import { mapGoTabStatus } from './gotab-status.js';
import type {
  SubmitTicketRequest,
  SubmitTicketResult,
  VendorAdapter,
  VendorProduct,
  VendorTicketStatus,
} from './types.js';

// Real GoTab integration.
//
// STATUS (2026-06-27): auth + read path implemented and buildable. submitTicket
// is NOT implemented and is BLOCKED on an unresolved architectural decision —
// see the ⚠️ note below. Do not implement submitTicket until that resolves.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  THE holdsSchedule FORK IS UNRESOLVED. (project doc: "make-or-break test")
// ─────────────────────────────────────────────────────────────────────────────
// The original scaffold asserted holdsSchedule = true ("GoTab holds the timer":
// submit one per-vendor order with a future `scheduled` timestamp on a shared
// tab, GoTab releases each to its kitchen at that time). That came from SUPPORT
// CORRESPONDENCE, not the live API. Reading the actual REST docs + sandbox
// testing surfaced three problems that put it in doubt:
//   1. The API only supports CLOSED tabs (openTab must be false). A closed tab
//      needs payments[] that zero the balance at creation.
//   2. Sandbox payment is Cash-only and server-assigned / POS-settled — our
//      Client Credentials integration cannot settle a tab via API
//      (PROCESSOR_INVALID for both "CASH" and the Cash-product UUID). So right
//      now we cannot even CREATE an order via API, let alone schedule one.
//   3. `scheduled` may be a coarse (day-grain) pickup field, not a minute-level
//      fire time. Unverified whether it releases to the KDS at an exact instant.
// Open question with GoTab support: is there an API path to submit a scheduled
// order WITHOUT a settling payment? Its answer picks the mode:
//   - If yes and `scheduled` fires precisely  -> holdsSchedule = true.
//   - If no (creation always needs settlement we can't do via API)
//                                             -> holdsSchedule = false: WE hold
//     durable BullMQ fire timers and submit each ticket at fire time (exactly
//     what the mock adapter models today).
// holdsSchedule is therefore declared `false` here as the SAFE DEFAULT until the
// test resolves it — false means the app keeps its own timers, so a wrong guess
// degrades to "we fire on time ourselves" rather than "nothing ever fires."
// ─────────────────────────────────────────────────────────────────────────────
//
// getTicketStatus status mapping (poll ordersList; data is live, no batch lag):
//   GoTab PENDING / SCHEDULED          -> 'SCHEDULED'   (accepted, not at kitchen)
//   GoTab SENT (fired, not prepared)   -> 'IN_PROGRESS' (cooking)
//   `prepared` timestamp set           -> 'READY'
//   (cancelled)                        -> 'CANCELLED'
//
// Prep-time note for whoever wires product mapping: GoTab product `prepTime` is
// in MINUTES and our scheduler works in SECONDS — multiply by 60. Treat both
// null AND 0 as "unset" (own prep table is source of truth). See project doc.
export class GoTabAdapter implements VendorAdapter {
  readonly name = 'gotab';

  // SAFE DEFAULT pending the make-or-break test (see ⚠️ above). Do not flip to
  // true until the sandbox confirms GoTab can hold a precise per-order fire time
  // on a shared tab that our integration can actually create.
  readonly holdsSchedule = false;

  private readonly client: GoTabClient;

  constructor() {
    // Resolving auth validates that credentials exist; throws CONFIG otherwise.
    this.client = new GoTabClient(getGoTabAuth());
    if (config.VENDOR_ADAPTER === 'gotab') {
      logger.info('GoTab adapter constructed (read path live; submitTicket stubbed)');
    }
  }

  async submitTicket(_req: SubmitTicketRequest): Promise<SubmitTicketResult> {
    // BLOCKED — see the ⚠️ holdsSchedule-fork note at the top of this file.
    // Implementing this requires knowing whether we submit a scheduled order to
    // GoTab (holdsSchedule=true) or fire at our own timer (false), AND a working
    // tab-creation path that our integration can settle. Neither is resolved.
    throw new AppError(
      501,
      'NOT_IMPLEMENTED',
      'GoTab submitTicket is blocked on the holdsSchedule decision (see gotab.ts header)',
    );
  }

  async getTicketStatus(externalOrderId: string): Promise<VendorTicketStatus> {
    // Reads a single order by its GoTab id via GraphQL ordersList, mapping
    // GoTab's status/timestamps onto our VendorTicketStatus. Field names below
    // (`status`, `prepared`) are from support correspondence + docs; VERIFY
    // against the live schema when a real order exists to query (blocked today
    // because we can't create one — see the ⚠️ note).
    const query = `query ($orderUuid: String!) {
      order: orderByOrderUuid(orderUuid: $orderUuid) {
        orderUuid
        status
        prepared
      }
    }`;
    const data = await this.client.graph<{
      order: { orderUuid: string; status: string | null; prepared: string | null } | null;
    }>(query, { orderUuid: externalOrderId });

    const order = data.order;
    if (!order) {
      throw new AppError(404, 'GOTAB_ORDER_NOT_FOUND', `GoTab order ${externalOrderId} not found`);
    }
    return mapGoTabStatus(order.status, order.prepared);
  }

  async cancelTicket(_externalOrderId: string): Promise<void> {
    // GoTab cancellation semantics after `scheduled` is set are undocumented for
    // our case — the project doc lists "document what is and isn't cancellable
    // after scheduled is set" as a Phase-2 build item. Stubbed until then.
    throw new AppError(
      501,
      'NOT_IMPLEMENTED',
      'GoTab cancelTicket not yet implemented (cancellability rules unverified)',
    );
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
  //   - orderEnabled/available: skip items not orderable.
  async listProducts(locationUuid: string): Promise<VendorProduct[]> {
    const query = `query ($loc: String!) {
      location(locationUuid: $loc) {
        productsList {
          name
          productUuid
          productType
          basePrice
          prepTime
          orderEnabled
          available
        }
      }
    }`;
    const data = await this.client.graph<{
      location: {
        productsList: Array<{
          name: string;
          productUuid: string;
          productType: string | null;
          basePrice: number | null;
          prepTime: number | null;
          orderEnabled: boolean | null;
          available: boolean | null;
        }> | null;
      } | null;
    }>(query, { loc: locationUuid });

    const list = data.location?.productsList ?? [];
    const products: VendorProduct[] = [];
    for (const p of list) {
      // Skip back-office payment instruments and anything not orderable.
      if ((p.productType ?? '').toUpperCase() === 'CUSTOM') continue;
      if (p.orderEnabled === false) continue;
      // prepTime: minutes -> seconds; null or 0 -> unset (null).
      const prepSeconds =
        p.prepTime && p.prepTime > 0 ? Math.round(p.prepTime * 60) : null;
      products.push({
        gotabProductUuid: p.productUuid,
        name: p.name,
        priceCents: p.basePrice ?? 0,
        prepSeconds,
      });
    }
    logger.info(
      { locationUuid, total: list.length, imported: products.length },
      'listed GoTab products for import',
    );
    return products;
  }
}
