import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { config } from '../../config/index.js';
import { getVendorAdapter } from '../../vendor-adapter/index.js';
import { realtime } from '../realtime/broker.js';
import { handlePaymentTimeout, redriveTicket } from './orders.service.js';

// Periodic backstops, run by the worker every 60s. Queues and inline calls are
// the primary mechanism; these sweeps exist because the failure that matters
// most — a table silently not getting fed — is exactly the one a lost job
// produces. Every action here is idempotent (conditional updates, adapter
// dedupe on ticketId), so re-driving is always safe; the cost of a false
// positive is a duplicate no-op, the cost of a miss is a hungry table.
//
// Detections are logged at error level deliberately: in a venue deployment,
// error-level logs are what monitoring alerts on, and a sweep firing means a
// primary mechanism failed and should be investigated.

// How long past fireAt before a PENDING ticket counts as stuck (we-hold-timers
// mode). Covers normal job latency without tolerating real loss for long.
const FIRE_GRACE_MS = 30_000;
// Extra slack past PAYMENT_TIMEOUT_SECONDS before re-running a timeout that
// the queue should have run.
const TIMEOUT_GRACE_MS = 60_000;
// Per-sweep batch cap: a pathological backlog drains over several ticks
// instead of hammering the DB/vendor in one.
const BATCH = 50;

export async function runSweeps() {
  await sweepStuckTickets();
  await sweepStuckLockedGroups();
  await sweepExpiredOpenGroups();
}

// A ticket is stuck when its group says "we're cooking" (SCHEDULED/FIRED) but
// the ticket was never handed to the vendor (PENDING, no external id):
//   - we-hold-timers mode: the delayed fire job was lost or its retries
//     exhausted; stuck once fireAt + grace has passed.
//   - platform-held mode: the submit-at-all-paid call failed; stuck
//     immediately, since submission should have happened the moment the group
//     scheduled (no fireAt condition — the platform owns the timing).
async function sweepStuckTickets() {
  const adapter = getVendorAdapter();
  const tickets = await prisma.ticket.findMany({
    where: {
      status: 'PENDING',
      gotabOrderId: null,
      group: { status: { in: ['SCHEDULED', 'FIRED'] } },
      ...(adapter.holdsSchedule
        ? {}
        : { fireAt: { lte: new Date(Date.now() - FIRE_GRACE_MS) } }),
    },
    select: { id: true },
    take: BATCH,
  });
  for (const t of tickets) {
    logger.error(
      { ticketId: t.id },
      'SWEEP: stuck ticket (scheduled group, never submitted) — re-driving',
    );
    try {
      await redriveTicket(t.id);
    } catch (err) {
      logger.error({ err, ticketId: t.id }, 'SWEEP: re-drive failed; will retry next sweep');
    }
  }
}

// A LOCKED group past the payment deadline means the paymentTimeout job was
// lost — without this, a group whose members never all pay sits LOCKED
// forever. handlePaymentTimeout is idempotent (re-checks LOCKED).
async function sweepStuckLockedGroups() {
  const cutoff = new Date(Date.now() - config.PAYMENT_TIMEOUT_SECONDS * 1000 - TIMEOUT_GRACE_MS);
  const groups = await prisma.groupOrder.findMany({
    where: { status: 'LOCKED', lockedAt: { lte: cutoff } },
    select: { id: true },
    take: BATCH,
  });
  for (const g of groups) {
    logger.error(
      { groupId: g.id },
      'SWEEP: LOCKED group past payment deadline (lost timeout job?) — running timeout handler',
    );
    try {
      await handlePaymentTimeout(g.id);
    } catch (err) {
      logger.error({ err, groupId: g.id }, 'SWEEP: timeout handler failed; will retry next sweep');
    }
  }
}

// Lifecycle expiry (M4): OPEN groups older than GROUP_OPEN_EXPIRY_HOURS are
// abandoned — cancel them so rows (and the authority of their members'
// session tokens, which every mutating route gates on group status) don't
// accumulate forever on a public, unauthenticated surface.
async function sweepExpiredOpenGroups() {
  const cutoff = new Date(Date.now() - config.GROUP_OPEN_EXPIRY_HOURS * 3_600_000);
  const groups = await prisma.groupOrder.findMany({
    where: { status: 'OPEN', createdAt: { lte: cutoff } },
    select: { id: true },
    take: BATCH,
  });
  for (const g of groups) {
    const updated = await prisma.groupOrder.updateMany({
      where: { id: g.id, status: 'OPEN' },
      data: { status: 'CANCELLED' },
    });
    if (updated.count > 0) {
      // warn, not error: expiry is expected housekeeping, not a failure.
      logger.warn({ groupId: g.id }, 'SWEEP: expired idle OPEN group');
      await realtime.publish({ type: 'group.updated', groupId: g.id });
    }
  }
}
