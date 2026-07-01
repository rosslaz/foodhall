import { prisma } from '../../db/client.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getVendorAdapter } from '../../vendor-adapter/index.js';
import { fireTicketQueue, paymentTimeoutQueue } from '../../jobs/queues.js';
import { realtime } from '../realtime/broker.js';
import { config } from '../../config/index.js';
import { computeSchedule } from '../scheduler/scheduler.js';
import { getPrepEstimator } from '../scheduler/prep-estimates.js';
import { markGroupFired } from './status.service.js';
import { Prisma } from '@prisma/client';

// Group order lifecycle: lock -> (everyone pays) -> schedule -> fire -> ready.
//
// Timing model (see scheduler.ts and the project doc):
//   - lockGroup() computes a PROVISIONAL schedule anchored at lock time. This
//     is a display estimate only — kitchens cannot start before payment.
//   - maybeSchedule() recomputes the REAL schedule anchored at the moment the
//     group becomes fully paid, then either hands every ticket to the vendor
//     platform with future `scheduledFor` timestamps (adapter.holdsSchedule —
//     the GoTab mode) or enqueues durable delayed fire jobs (mock mode).
// Re-anchoring matters: if fire times stayed anchored at lock, a slow payment
// would push them all into the past and every ticket would fire at once —
// destroying the stagger exactly when groups pay slowly.

// Lock a group: freeze items, create one PENDING ticket per vendor, and start
// the payment-timeout clock. Nothing fires yet — see maybeSchedule().
export async function lockGroup(groupId: string) {
  const res = await prisma.$transaction(async (tx) => {
    const group = await tx.groupOrder.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: {
            orderItems: {
              where: { status: 'ACTIVE' },
              include: { menuItem: { select: { vendorId: true } } },
            },
          },
        },
      },
    });
    if (!group) throw notFound('Group not found');
    if (group.status !== 'OPEN') throw conflict('Group is not open');

    const allItems = group.members.flatMap((m) => m.orderItems);
    if (allItems.length === 0) throw badRequest('Cannot lock an empty group');

    // Provisional schedule for display while the group pays. Real fire times
    // are re-anchored in maybeSchedule() at the all-paid moment.
    const lockedAt = new Date();
    const schedule = computeSchedule(
      allItems.map((i) => ({ vendorId: i.menuItem.vendorId, prepSeconds: i.prepSecondsSnapshot })),
      lockedAt,
    );

    const vendorToTicket = new Map<string, string>();
    for (const vs of schedule.vendorSchedules) {
      const ticket = await tx.ticket.create({
        data: { groupId, vendorId: vs.vendorId, status: 'PENDING', fireAt: vs.fireAt },
      });
      vendorToTicket.set(vs.vendorId, ticket.id);
    }
    for (const item of allItems) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { ticketId: vendorToTicket.get(item.menuItem.vendorId)! },
      });
    }

    // Conditional transition: if a concurrent lock already moved the group out
    // of OPEN, this matches zero rows and the WHOLE transaction — including
    // the tickets created above — rolls back. Prevents duplicate ticket sets
    // from a double-tapped lock button.
    const updated = await tx.groupOrder.updateMany({
      where: { id: groupId, status: 'OPEN' },
      data: { status: 'LOCKED', lockedAt, targetReadyAt: schedule.targetReadyAt },
    });
    if (updated.count === 0) throw conflict('Group was locked concurrently');

    return { targetReadyAt: schedule.targetReadyAt };
  }).catch((err) => {
    // The partial unique index (one live ticket per vendor per group, S9) can
    // fire before our conditional status guard when two locks race — map it
    // to the same 409 so both detection paths read identically to clients.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('Group was locked concurrently');
    }
    throw err;
  });

  await paymentTimeoutQueue.add(
    'timeout',
    { groupId },
    // NOTE: BullMQ forbids ':' in custom job ids (it's the Redis key
    // delimiter) — underscores throughout. Caught by the integration suite.
    { delay: config.PAYMENT_TIMEOUT_SECONDS * 1000, jobId: `timeout_${groupId}` },
  );
  await realtime.publish({
    type: 'group.locked',
    groupId,
    targetReadyAt: res.targetReadyAt.toISOString(),
  });
  return res;
}

// Called after each payment (and after a payment timeout drops items). If
// every member who is actually ordering has paid: atomically transition to
// SCHEDULED, re-anchor the schedule to "now", and hand the tickets to the
// vendor platform or to our own durable timers, depending on the adapter.
export async function maybeSchedule(groupId: string) {
  const group = await prisma.groupOrder.findUnique({
    where: { id: groupId },
    include: { members: { include: { orderItems: { where: { status: 'ACTIVE' } } } } },
  });
  if (!group) throw notFound('Group not found');
  if (group.status !== 'LOCKED') return; // not ready, or already scheduled

  // Only members who actually hold items must pay. Zero-item members (joined
  // but added nothing, or had their items dropped by the payment timeout)
  // must not block the group. Previously ANY unpaid member blocked forever.
  const ordering = group.members.filter((m) => m.orderItems.length > 0);
  if (ordering.length === 0) return;
  if (!ordering.every((m) => m.payStatus === 'PAID')) return;

  const result = await prisma.$transaction(async (tx) => {
    // Atomic transition: of N concurrent payment callbacks all observing
    // "everyone paid", exactly one proceeds past this point.
    const flipped = await tx.groupOrder.updateMany({
      where: { id: groupId, status: 'LOCKED' },
      data: { status: 'SCHEDULED' },
    });
    if (flipped.count === 0) return null;

    const tickets = await tx.ticket.findMany({
      where: { groupId, status: 'PENDING' },
      include: { orderItems: { where: { status: 'ACTIVE' } } },
    });

    // Cancel tickets whose items were all dropped (payment timeout) — never
    // send an empty ticket to a kitchen.
    const live = tickets.filter((t) => t.orderItems.length > 0);
    const empty = tickets.filter((t) => t.orderItems.length === 0);
    if (empty.length > 0) {
      await tx.ticket.updateMany({
        where: { id: { in: empty.map((t) => t.id) } },
        data: { status: 'CANCELLED' },
      });
    }

    // RE-ANCHOR: the real schedule starts now — the first moment every paid
    // ticket is allowed to hit a kitchen. Also recomputes correctly when the
    // payment timeout dropped items (e.g. the slowest item is gone).
    //
    // Prep times come from the PrepEstimator (S8), not the add-time snapshot:
    // price is contractual and frozen; prep is a prediction and should be the
    // freshest available when fire times are computed. (Read-only lookup via
    // the global client — fine alongside this transaction.)
    const now = new Date();
    const estimator = getPrepEstimator();
    const estimates = await estimator.estimate(
      live.flatMap((t) =>
        t.orderItems.map((i) => ({
          menuItemId: i.menuItemId,
          vendorId: t.vendorId,
          snapshotPrepSeconds: i.prepSecondsSnapshot,
        })),
      ),
    );
    const schedule = computeSchedule(
      live.flatMap((t) =>
        t.orderItems.map((i) => ({
          vendorId: t.vendorId,
          prepSeconds: estimates.get(i.menuItemId) ?? i.prepSecondsSnapshot,
        })),
      ),
      now,
    );
    const fireAtByVendor = new Map(schedule.vendorSchedules.map((v) => [v.vendorId, v.fireAt]));
    for (const t of live) {
      await tx.ticket.update({
        where: { id: t.id },
        data: { fireAt: fireAtByVendor.get(t.vendorId)! },
      });
    }
    await tx.groupOrder.update({
      where: { id: groupId },
      data: { targetReadyAt: schedule.targetReadyAt },
    });

    // Telemetry (M3): record the prediction in the same transaction that
    // commits it. Actuals are filled in at completion (status.service.ts).
    // This row is the calibration + pitch dataset — it must exist from the
    // first real order, not be bolted on later.
    await tx.scheduleOutcome.create({
      data: {
        groupId,
        foodHallId: group.foodHallId,
        scheduledAt: now,
        targetReadyAt: schedule.targetReadyAt,
        vendorCount: live.length,
        itemCount: live.reduce((s, t) => s + t.orderItems.length, 0),
      },
    });

    return {
      liveTicketIds: live.map((t) => t.id),
      fireAtByTicket: new Map(live.map((t) => [t.id, fireAtByVendor.get(t.vendorId)!])),
      targetReadyAt: schedule.targetReadyAt,
    };
  });

  if (!result) return; // another caller won the transition

  await paymentTimeoutQueue.remove(`timeout_${groupId}`).catch(() => {});

  const adapter = getVendorAdapter();
  if (adapter.holdsSchedule) {
    // GoTab mode: the platform holds scheduled orders and releases them
    // itself. Submit everything now with future scheduledFor timestamps; no
    // app-side fire timers exist in this mode. The reconcile poll observes
    // platform-side firing (PENDING -> FIRED) — see status.service.ts.
    for (const ticketId of result.liveTicketIds) {
      try {
        await submitTicketToVendor(ticketId, { markFired: false });
      } catch (err) {
        // Ticket stays PENDING without an external id. Logged loudly; a
        // recovery sweep belongs in Phase 2 alongside the real adapter.
        logger.error({ err, ticketId }, 'failed to submit scheduled ticket to vendor');
      }
    }
  } else {
    // Mock mode: WE hold the timers — durable delayed jobs that survive
    // restarts (in-memory setTimeout is unacceptable: a restart would mean a
    // table never gets fed). Retries are safe: submission is idempotent on
    // ticketId at both our layer and the adapter's.
    const now = Date.now();
    for (const ticketId of result.liveTicketIds) {
      const fireAt = result.fireAtByTicket.get(ticketId)!;
      await fireTicketQueue.add(
        'fire',
        { ticketId },
        {
          delay: Math.max(0, fireAt.getTime() - now),
          jobId: `fire_${ticketId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );
    }
  }

  await realtime.publish({ type: 'group.updated', groupId });
  logger.info(
    { groupId, tickets: result.liveTicketIds.length, targetReadyAt: result.targetReadyAt },
    'group scheduled',
  );
}

// Submit one ticket to the vendor adapter. Idempotent: skips tickets that have
// already left PENDING, uses conditional updates, and adapters dedupe on
// ticketId — so BullMQ retries are safe.
async function submitTicketToVendor(ticketId: string, opts: { markFired: boolean }) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      vendor: true,
      group: true,
      orderItems: { where: { status: 'ACTIVE' }, include: { menuItem: true } },
    },
  });
  if (!ticket) throw notFound('Ticket not found');
  if (ticket.status !== 'PENDING') {
    logger.warn({ ticketId, status: ticket.status }, 'submit skipped (not pending)');
    return;
  }
  if (ticket.orderItems.length === 0) {
    // Safety net — maybeSchedule already cancels empty tickets, but never
    // send an empty ticket to a kitchen under any path.
    await prisma.ticket.updateMany({
      where: { id: ticketId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    logger.warn({ ticketId }, 'cancelled empty ticket instead of submitting');
    return;
  }

  const adapter = getVendorAdapter();
  const result = await adapter.submitTicket({
    ticketId: ticket.id,
    vendorLocationId: ticket.vendor.gotabLocationId ?? ticket.vendor.id,
    scheduledFor: ticket.fireAt,
    targetReadyAt: ticket.group.targetReadyAt ?? ticket.fireAt,
    items: ticket.orderItems.map((oi) => ({
      name: oi.menuItem.name,
      qty: oi.qty,
      notes: oi.notes ?? undefined,
      priceCents: oi.priceCentsSnapshot,
    })),
  });

  if (opts.markFired) {
    // We held the timer and just fired this to the kitchen.
    const updated = await prisma.ticket.updateMany({
      where: { id: ticketId, status: 'PENDING' },
      data: { status: 'FIRED', firedAt: result.acceptedAt, gotabOrderId: result.externalOrderId },
    });
    if (updated.count > 0) {
      await markGroupFired(ticket.groupId);
      await realtime.publish({
        type: 'ticket.updated',
        groupId: ticket.groupId,
        ticketId,
        status: 'FIRED',
      });
    }
  } else {
    // Platform holds the schedule: record the external id; the ticket stays
    // PENDING until the reconcile poll observes the platform firing it.
    await prisma.ticket.updateMany({
      where: { id: ticketId, status: 'PENDING' },
      data: { gotabOrderId: result.externalOrderId },
    });
  }
  logger.info(
    { ticketId, externalOrderId: result.externalOrderId, scheduledFor: ticket.fireAt },
    'ticket submitted to vendor',
  );
}

// Worker entry point (we-hold-timers mode), runs at the ticket's fireAt.
export async function fireTicket(ticketId: string) {
  await submitTicketToVendor(ticketId, { markFired: true });
}

// Sweep backstop (see sweeps.service.ts): re-drive a ticket whose submission
// was lost — a fire job that never ran, or a platform submission that failed
// at the all-paid moment. Safe to call repeatedly: submission is idempotent
// on ticketId at our layer (PENDING-only guards) and the adapter's.
export async function redriveTicket(ticketId: string) {
  const adapter = getVendorAdapter();
  // Platform-held mode: submit so the platform owns the (possibly already
  // past) schedule. We-hold-timers mode: the fire moment has passed — fire
  // it now rather than re-enqueueing a delayed job.
  await submitTicketToVendor(ticketId, { markFired: !adapter.holdsSchedule });
}

// Payment timeout: drop items of members who never paid, then schedule what
// remains. Members themselves are kept (still UNPAID) — maybeSchedule only
// requires payment from members who still hold items, so dropped members no
// longer block the group. (Previously this deadlocked: items were deleted but
// the still-UNPAID member failed the old all-members-paid check, leaving the
// group LOCKED forever and the paid members unfed.)
export async function handlePaymentTimeout(groupId: string) {
  const group = await prisma.groupOrder.findUnique({
    where: { id: groupId },
    include: { members: { include: { orderItems: { where: { status: 'ACTIVE' } } } } },
  });
  if (!group || group.status !== 'LOCKED') return;

  const unpaid = group.members.filter((m) => m.payStatus !== 'PAID');
  const unpaidItemIds = unpaid.flatMap((m) => m.orderItems.map((i) => i.id));

  if (unpaidItemIds.length > 0) {
    logger.warn(
      { groupId, unpaidMembers: unpaid.length, droppedItems: unpaidItemIds.length },
      'payment timeout — dropping unpaid items',
    );
    // Re-check payment status and group state INSIDE the predicate: a member
    // may pay (and the group may schedule) between our read above and this
    // statement, and we must never drop a paid member's items or touch an
    // already-scheduled group.
    // S7: mark DROPPED instead of deleting — the record of who ordered and
    // bailed feeds the calibration dataset and dispute handling. Everything
    // downstream filters status: ACTIVE, so a DROPPED item can never cook,
    // be owed, or appear in a client view.
    await prisma.orderItem.updateMany({
      where: {
        id: { in: unpaidItemIds },
        status: 'ACTIVE',
        member: { payStatus: { not: 'PAID' }, group: { status: 'LOCKED' } },
      },
      data: { status: 'DROPPED', droppedAt: new Date() },
    });
  }

  const remaining = await prisma.orderItem.count({
    where: { member: { groupId }, status: 'ACTIVE' },
  });
  if (remaining === 0) {
    // Nobody paid: cancel the group and its pending tickets (conditional, in
    // case the group moved on concurrently).
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.groupOrder.updateMany({
        where: { id: groupId, status: 'LOCKED' },
        data: { status: 'CANCELLED' },
      });
      if (cancelled.count > 0) {
        await tx.ticket.updateMany({
          where: { groupId, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
      }
    });
    await realtime.publish({ type: 'group.updated', groupId });
    return;
  }

  await realtime.publish({ type: 'group.updated', groupId });
  // Re-anchors the schedule around the surviving items and cancels any ticket
  // left empty by the drops.
  await maybeSchedule(groupId);
}
