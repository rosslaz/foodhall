import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// Stale-FIRED sweep integration tests (backlog item, 2026-07-12): FIRED
// groups whose targetReadyAt is hours past must be expired (CANCELLED, tickets
// closed out) so the reconcile stops polling GoTab for them forever — the
// zombie-group problem observed live 07-07/07-08. Uses the REAL mock adapter
// (no vi.mock): groups are built through the actual services, then aged by
// rewinding targetReadyAt.

import { prisma } from '../../db/client.js';
import { redis } from '../../lib/redis.js';
import {
  fireTicketQueue,
  paymentTimeoutQueue,
  scheduleGroupQueue,
  closeQueues,
} from '../../jobs/queues.js';
import { realtime } from '../../modules/realtime/broker.js';
import { lockGroup, maybeSchedule, fireTicket } from '../../modules/orders/orders.service.js';
import { sweepStaleFiredGroups } from '../../modules/orders/sweeps.service.js';

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedFiredGroup() {
  const hall = await prisma.foodHall.create({ data: { name: `Hall ${rand()}` } });
  const vendor = await prisma.vendor.create({ data: { foodHallId: hall.id, name: 'Grill' } });
  const item = await prisma.menuItem.create({
    data: { vendorId: vendor.id, name: 'Skewer', priceCents: 900, prepSeconds: 2 },
  });
  const group = await prisma.groupOrder.create({
    data: {
      foodHallId: hall.id,
      joinCode: rand().toUpperCase().slice(0, 6),
      members: {
        create: [{ displayName: 'Ann', isHost: true, sessionToken: `tok_${rand()}${rand()}` }],
      },
    },
    include: { members: true },
  });
  await prisma.orderItem.create({
    data: {
      memberId: group.members[0]!.id,
      menuItemId: item.id,
      qty: 1,
      prepSecondsSnapshot: item.prepSeconds,
      priceCentsSnapshot: item.priceCents,
    },
  });
  await lockGroup(group.id);
  await prisma.member.update({ where: { id: group.members[0]!.id }, data: { payStatus: 'PAID' } });
  await maybeSchedule(group.id);
  const ticket = await prisma.ticket.findFirstOrThrow({ where: { groupId: group.id } });
  await fireTicket(ticket.id); // mock adapter accepts -> ticket FIRED, group FIRED
  const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
  expect(g.status).toBe('FIRED'); // precondition sanity
  return { groupId: group.id, ticketId: ticket.id };
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ScheduleOutcome", "OrderItem", "Ticket", "Member", "GroupOrder", "MenuItem", "Vendor", "User", "FoodHall" CASCADE',
  );
  await Promise.all([
    fireTicketQueue.obliterate({ force: true }),
    paymentTimeoutQueue.obliterate({ force: true }),
    scheduleGroupQueue.obliterate({ force: true }),
  ]);
});

afterAll(async () => {
  await closeQueues();
  await realtime.close();
  await redis.quit().catch(() => {});
  await prisma.$disconnect();
});

describe('sweepStaleFiredGroups', () => {
  it('expires a FIRED group hours past target: group CANCELLED, FIRED ticket closed out', async () => {
    const { groupId, ticketId } = await seedFiredGroup();
    // Age it: target was due 5 hours ago (> the 4h default expiry).
    await prisma.groupOrder.update({
      where: { id: groupId },
      data: { targetReadyAt: new Date(Date.now() - 5 * 3_600_000) },
    });

    await sweepStaleFiredGroups();

    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: groupId } });
    expect(g.status).toBe('CANCELLED'); // reconcile filter (PENDING/FIRED) no longer matches
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    expect(t.status).toBe('CANCELLED');

    // Idempotent: a second sweep pass is a clean no-op.
    await sweepStaleFiredGroups();
    expect(
      (await prisma.groupOrder.findUniqueOrThrow({ where: { id: groupId } })).status,
    ).toBe('CANCELLED');
  });

  it('leaves a fresh FIRED group (target in the future / recently past) untouched', async () => {
    const { groupId, ticketId } = await seedFiredGroup();
    // Recently past target (1 minute) — normal service window, NOT stale.
    await prisma.groupOrder.update({
      where: { id: groupId },
      data: { targetReadyAt: new Date(Date.now() - 60_000) },
    });

    await sweepStaleFiredGroups();

    expect(
      (await prisma.groupOrder.findUniqueOrThrow({ where: { id: groupId } })).status,
    ).toBe('FIRED');
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status,
    ).toBe('FIRED');
  });
});
