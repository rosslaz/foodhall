// The contract every POS integration must satisfy. Swapping the mock for the
// real GoTab client is a one-file change — nothing else in the app imports a
// concrete adapter, only this interface via the factory in ./index.ts.
//
// Timer ownership (see project doc "DECISION: Timer ownership"): adapters
// declare, via `holdsSchedule`, whether the platform itself holds scheduled
// orders and releases them to the kitchen (GoTab's per-order `scheduled`
// timestamp on a shared tab), or whether the app must hold durable timers and
// submit each ticket at fire time (the mock). Both modes flow through the same
// submitTicket() call — only the meaning of `scheduledFor` differs.

export interface TicketItem {
  name: string;
  qty: number;
  notes?: string;
  priceCents: number;
}

export interface SubmitTicketRequest {
  ticketId: string; // our internal ticket id (idempotency key)
  vendorLocationId: string; // gotabLocationId on the Vendor
  items: TicketItem[];
  // When the vendor's kitchen should START this ticket (the fire time).
  // holdsSchedule=true adapters receive future timestamps and hold the order
  // themselves; holdsSchedule=false adapters only ever see scheduledFor <= now
  // (we held the timer and are firing right now).
  scheduledFor: Date;
  // When the group expects everything ready (display / sequencing hint).
  targetReadyAt: Date;
}

export interface SubmitTicketResult {
  externalOrderId: string; // GoTab order id (or mock equivalent)
  acceptedAt: Date;
  estimatedReadyAt: Date;
}

// SCHEDULED = accepted by the platform but not yet released to the kitchen.
export type VendorTicketStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'READY' | 'CANCELLED';

// A product read from the vendor's catalog, normalized to our units/shape.
// prepSeconds is null when the platform has no usable prep time (GoTab returns
// null OR 0 for "unset" — both map to null here; the admin fills it in).
export interface VendorProduct {
  gotabProductUuid: string;
  name: string;
  priceCents: number;
  prepSeconds: number | null;
}

// Result of reading a location's catalog for menu import: the location's own
// name (used as the default vendor name) plus its orderable products.
export interface VendorCatalog {
  locationName: string | null;
  products: VendorProduct[];
}

export interface VendorAdapter {
  readonly name: string;
  // True: the platform holds scheduled orders and fires them itself; we submit
  // every ticket as soon as the group is fully paid and run no fire timers.
  // False: we hold durable timers (BullMQ) and call submitTicket at fire time.
  readonly holdsSchedule: boolean;
  // Send a ticket to the vendor's POS. Must be idempotent on ticketId.
  submitTicket(req: SubmitTicketRequest): Promise<SubmitTicketResult>;
  // Poll current status of a previously submitted ticket.
  getTicketStatus(externalOrderId: string): Promise<VendorTicketStatus>;
  // Cancel a ticket if still cancellable.
  cancelTicket(externalOrderId: string): Promise<void>;
  // Read a location's name + orderable products, for menu onboarding/import.
  // This is a READ — unblocked even while submitTicket is not (see gotab.ts).
  listProducts(locationUuid: string): Promise<VendorCatalog>;
}
