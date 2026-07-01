import { nanoid } from 'nanoid';
import { logger } from '../lib/logger.js';
import type {
  SubmitTicketRequest,
  SubmitTicketResult,
  VendorAdapter,
  VendorTicketStatus,
} from './types.js';

// In-memory simulation of a GoTab-like vendor POS.
//
// holdsSchedule = false: this mock models a POS with no native scheduling, so
// the app holds durable fire timers (BullMQ) and calls submitTicket at fire
// time. It still honors a future scheduledFor — reporting SCHEDULED until
// then — so flipping holdsSchedule to true demos the GoTab-held mode too.
//
// Readiness: a ticket becomes READY exactly at the request's targetReadyAt,
// i.e. the simulated kitchen agrees with the scheduler's prediction. This is
// deliberate: demos should show the synchronization working, and any drift you
// then observe comes from real code paths, not mock noise. (Previously cook
// time was 30s + 20s/item — unrelated to the prepSeconds the scheduler used —
// so countdowns hit zero while tickets were still cooking, or long before.)

interface MockOrder {
  externalOrderId: string;
  ticketId: string;
  acceptedAt: Date;
  startAt: Date; // when the simulated kitchen starts (fire time)
  readyAt: Date;
  cancelled: boolean;
}

// Cook time used when targetReadyAt is already in the past (ticket fired late).
const LATE_FIRE_FALLBACK_MS = 60_000;

export class MockGoTabAdapter implements VendorAdapter {
  readonly name = 'mock-gotab';
  readonly holdsSchedule = false;
  private byTicket = new Map<string, MockOrder>();
  private byExternal = new Map<string, MockOrder>();

  async submitTicket(req: SubmitTicketRequest): Promise<SubmitTicketResult> {
    const existing = this.byTicket.get(req.ticketId);
    if (existing) {
      return {
        externalOrderId: existing.externalOrderId,
        acceptedAt: existing.acceptedAt,
        estimatedReadyAt: existing.readyAt,
      };
    }
    const now = new Date();
    const startAt = req.scheduledFor > now ? req.scheduledFor : now;
    const readyAt =
      req.targetReadyAt > startAt
        ? req.targetReadyAt
        : new Date(startAt.getTime() + LATE_FIRE_FALLBACK_MS);
    const order: MockOrder = {
      externalOrderId: `mock_${nanoid(10)}`,
      ticketId: req.ticketId,
      acceptedAt: now,
      startAt,
      readyAt,
      cancelled: false,
    };
    this.byTicket.set(req.ticketId, order);
    this.byExternal.set(order.externalOrderId, order);
    logger.info(
      { ticketId: req.ticketId, externalOrderId: order.externalOrderId, startAt, readyAt },
      'mock vendor accepted ticket',
    );
    return {
      externalOrderId: order.externalOrderId,
      acceptedAt: order.acceptedAt,
      estimatedReadyAt: order.readyAt,
    };
  }

  async getTicketStatus(externalOrderId: string): Promise<VendorTicketStatus> {
    const order = this.byExternal.get(externalOrderId);
    if (!order) {
      // Unknown id means this in-memory mock lost its state (process restart).
      // Report READY — NOT cancelled — so dev flows complete instead of
      // erroneously cancelling live tickets (the previous behavior). Real
      // adapters query the platform's persistent state and never hit this.
      logger.warn(
        { externalOrderId },
        'mock adapter has no record of this order (restart?) — reporting READY',
      );
      return 'READY';
    }
    if (order.cancelled) return 'CANCELLED';
    const now = Date.now();
    if (now < order.startAt.getTime()) return 'SCHEDULED';
    if (now < order.readyAt.getTime()) return 'IN_PROGRESS';
    return 'READY';
  }

  async cancelTicket(externalOrderId: string): Promise<void> {
    const order = this.byExternal.get(externalOrderId);
    if (order) order.cancelled = true;
  }
}
