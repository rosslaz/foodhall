import { prisma } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { getVendorAdapter } from '../../vendor-adapter/index.js';
import { realtime } from '../realtime/broker.js';

// Status reconciliation. The worker polls the vendor adapter for every ticket
// that has been submitted (has an external order id) but isn't terminal, and
// advances our state to match the vendor's:
//   PENDING (platform holds the schedule) -> FIRED when the kitchen starts
//   FIRED -> READY when the kitchen finishes
// Once every ticket in a group is READY/CANCELLED, the group COMPLETEs.
//
// All transitions are conditional updateMany guards, so this poll — or a
// future GoTab webhook calling markTicketReady() directly — can never
// double-process a ticket.
//
// WEBHOOK DESIGN (S10 — designed, deliberately not built until sandbox):
// POST /api/webhooks/gotab with raw-body HMAC verification before parsing;
// map GoTab SENT -> the PENDING->FIRED branch below, `prepared` set ->
// markTicketReady(). No new state logic needed: the conditional updateMany
// transitions make duplicate / out-of-order / replayed webhooks no-ops by
// construction. Lookup: our ticketId passed as GoTab's external reference at
// submission, falling back to gotabOrderId (unique, S9). The 10s poll stays
// as the fallback for dropped webhooks. Full contract in the project doc.

// First ticket to hit a kitchen moves the group SCHEDULED -> FIRED, so the
// board/admin status is honest. (GroupStatus.FIRED previously existed in the
// enum but was never set by anything.)
export async function markGroupFired(groupId: string) {
  const updated = await prisma.groupOrder.updateMany({
    where: { id: groupId, status: 'SCHEDULED' },
    data: { status: 'FIRED' },
  });
  if (updated.count > 0) {
    await realtime.publish({ type: 'group.updated', groupId });
  }
}

export async function markTicketReady(ticketId: string) {
  // Conditional: a second poll tick or a duplicate webhook is a no-op.
  const updated = await prisma.ticket.updateMany({
    where: { id: ticketId, status: { in: ['PENDING', 'FIRED', 'IN_PROGRESS'] } },
    data: { status: 'READY', readyAt: new Date() },
  });
  if (updated.count === 0) return;

  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  await realtime.publish({
    type: 'ticket.updated',
    groupId: ticket.groupId,
    ticketId,
    status: 'READY',
  });

  const remaining = await prisma.ticket.count({
    where: { groupId: ticket.groupId, status: { notIn: ['READY', 'CANCELLED'] } },
  });
  if (remaining === 0) {
    await prisma.groupOrder.update({
      where: { id: ticket.groupId },
      data: { status: 'COMPLETED' },
    });
    await finalizeScheduleOutcome(ticket.groupId);
    await realtime.publish({ type: 'group.updated', groupId: ticket.groupId });
    logger.info({ groupId: ticket.groupId }, 'group completed');
  }
}

// Telemetry (M3): fill in the actuals on the group's ScheduleOutcome row when
// the last ticket lands. readySpreadMs (first dish → last dish) is the
// product KPI; targetErrorMs is how far reality landed from the prediction.
// Best-effort: a telemetry failure must never block completion, so errors are
// logged and swallowed.
async function finalizeScheduleOutcome(groupId: string) {
  try {
    const outcome = await prisma.scheduleOutcome.findUnique({ where: { groupId } });
    if (!outcome) return; // group predates telemetry, or was never scheduled

    const readyTickets = await prisma.ticket.findMany({
      where: { groupId, status: 'READY' },
      select: { readyAt: true },
    });
    const times = readyTickets
      .map((t) => t.readyAt)
      .filter((d): d is Date => d !== null)
      .map((d) => d.getTime());
    if (times.length === 0) return;

    const first = Math.min(...times);
    const last = Math.max(...times);
    await prisma.scheduleOutcome.update({
      where: { groupId },
      data: {
        firstReadyAt: new Date(first),
        lastReadyAt: new Date(last),
        readySpreadMs: last - first,
        targetErrorMs: last - outcome.targetReadyAt.getTime(),
        completedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error({ err, groupId }, 'failed to finalize schedule outcome telemetry');
  }
}

export async function reconcileSubmittedTickets() {
  const adapter = getVendorAdapter();
  // PENDING-with-external-id covers platform-held schedules (GoTab) where we
  // learn about firing by observing status; FIRED covers the cooking phase in
  // both modes.
  const tickets = await prisma.ticket.findMany({
    where: { gotabOrderId: { not: null }, status: { in: ['PENDING', 'FIRED'] } },
  });
  for (const ticket of tickets) {
    try {
      const status = await adapter.getTicketStatus(ticket.gotabOrderId!);
      if (status === 'SCHEDULED') continue; // platform still holding it
      if (status === 'IN_PROGRESS') {
        if (ticket.status === 'PENDING') {
          const updated = await prisma.ticket.updateMany({
            where: { id: ticket.id, status: 'PENDING' },
            data: { status: 'FIRED', firedAt: new Date() },
          });
          if (updated.count > 0) {
            await markGroupFired(ticket.groupId);
            await realtime.publish({
              type: 'ticket.updated',
              groupId: ticket.groupId,
              ticketId: ticket.id,
              status: 'FIRED',
            });
          }
        }
      } else if (status === 'READY') {
        await markTicketReady(ticket.id);
      } else if (status === 'CANCELLED') {
        const updated = await prisma.ticket.updateMany({
          where: { id: ticket.id, status: { in: ['PENDING', 'FIRED'] } },
          data: { status: 'CANCELLED' },
        });
        if (updated.count > 0) {
          await realtime.publish({
            type: 'ticket.updated',
            groupId: ticket.groupId,
            ticketId: ticket.id,
            status: 'CANCELLED',
          });
        }
      }
    } catch (err) {
      logger.error({ err, ticketId: ticket.id }, 'failed to reconcile ticket status');
    }
  }
}
