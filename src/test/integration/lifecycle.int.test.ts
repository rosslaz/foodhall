import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../db/client.js';
import { redis } from '../../lib/redis.js';
import {
  fireTicketQueue,
  paymentTimeoutQueue,
  scheduleGroupQueue,
  closeQueues,
} from '../../jobs/queues.js';
import { realtime } from '../../modules/realtime/broker.js';
import {
  lockGroup,
  maybeSchedule,
  handlePaymentTimeout,
  fireTicket,
  redriveTicket,
} from '../../modules/orders/orders.service.js';
import { reconcileSubmittedTickets } from '../../modules/orders/status.service.js';
import { buildServer } from '../../server.js';

// Integration tests (S6): the state machine against real Postgres + Redis.
// Every bug found in the original code review lived in this orchestration —
// lock / pay / timeout / schedule — not in the unit-tested pure math. These
// tests call the real service functions and assert real database state.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 10);

// --- seed helpers -----------------------------------------------------------

async function seedHall() {
  const hall = await prisma.foodHall.create({ data: { name: `Hall ${rand()}` } });
  const burgers = await prisma.vendor.create({
    data: { foodHallId: hall.id, name: 'Burgers' },
  });
  const drinks = await prisma.vendor.create({
    data: { foodHallId: hall.id, name: 'Drinks' },
  });
  // Small prep times keep the happy-path test fast: burger 4s, drink 1s.
  const burgerItem = await prisma.menuItem.create({
    data: { vendorId: burgers.id, name: 'Burger', priceCents: 1200, prepSeconds: 4 },
  });
  const drinkItem = await prisma.menuItem.create({
    data: { vendorId: drinks.id, name: 'Lemonade', priceCents: 400, prepSeconds: 1 },
  });
  return { hall, burgers, drinks, burgerItem, drinkItem };
}

async function createGroup(foodHallId: string, memberNames: string[]) {
  const group = await prisma.groupOrder.create({
    data: {
      foodHallId,
      joinCode: rand().toUpperCase().slice(0, 6),
      members: {
        create: memberNames.map((displayName, i) => ({
          displayName,
          isHost: i === 0,
          sessionToken: `tok_${rand()}${rand()}`,
        })),
      },
    },
    include: { members: true },
  });
  return group;
}

type SeededMenuItem = { id: string; prepSeconds: number; priceCents: number };

function addItem(memberId: string, menuItem: SeededMenuItem, qty = 1) {
  return prisma.orderItem.create({
    data: {
      memberId,
      menuItemId: menuItem.id,
      qty,
      prepSecondsSnapshot: menuItem.prepSeconds,
      priceCentsSnapshot: menuItem.priceCents,
    },
  });
}

function payMember(memberId: string) {
  return prisma.member.update({ where: { id: memberId }, data: { payStatus: 'PAID' } });
}

// --- lifecycle hooks ---------------------------------------------------------

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

// --- tests --------------------------------------------------------------------

describe('group lifecycle state machine', () => {
  it('happy path: lock -> pay -> re-anchored schedule -> fire -> ready -> completed, telemetry finalized', async () => {
    const { hall, burgerItem, drinkItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann', 'Bob']);
    const [ann, bob] = group.members;
    await addItem(ann!.id, burgerItem); // 4s — slowest, fires first
    await addItem(bob!.id, drinkItem); // 1s — fires 3s later

    await lockGroup(group.id);
    let g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('LOCKED');

    await payMember(ann!.id);
    await maybeSchedule(group.id); // not everyone paid — must be a no-op
    g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('LOCKED');

    await payMember(bob!.id);
    const anchor = Date.now();
    await maybeSchedule(group.id);

    g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('SCHEDULED');

    // Re-anchored stagger: burger fires ~now, drink fires ~3s later, both
    // targeting anchor + 4s.
    const tickets = await prisma.ticket.findMany({
      where: { groupId: group.id },
      include: { vendor: true },
    });
    const burgerTicket = tickets.find((t) => t.vendor.name === 'Burgers')!;
    const drinkTicket = tickets.find((t) => t.vendor.name === 'Drinks')!;
    expect(drinkTicket.fireAt.getTime() - burgerTicket.fireAt.getTime()).toBe(3000);
    expect(Math.abs(burgerTicket.fireAt.getTime() - anchor)).toBeLessThan(1500);
    expect(Math.abs(g.targetReadyAt!.getTime() - (anchor + 4000))).toBeLessThan(1500);

    // Telemetry row written with the prediction.
    const outcome = await prisma.scheduleOutcome.findUniqueOrThrow({
      where: { groupId: group.id },
    });
    expect(outcome.vendorCount).toBe(2);
    expect(outcome.itemCount).toBe(2);
    expect(outcome.completedAt).toBeNull();

    // Durable fire jobs enqueued (mock adapter does not hold schedules).
    const jobs = await fireTicketQueue.getJobs(['delayed', 'waiting', 'active', 'completed']);
    expect(jobs.length).toBe(2);

    // Simulate the worker firing both tickets.
    await fireTicket(burgerTicket.id);
    await fireTicket(drinkTicket.id);
    const fired = await prisma.ticket.findMany({ where: { groupId: group.id } });
    expect(fired.every((t) => t.status === 'FIRED' && t.gotabOrderId !== null)).toBe(true);

    // The mock kitchen finishes exactly at targetReadyAt; wait past it, then
    // reconcile like the worker's 10s loop would.
    await sleep(Math.max(0, g.targetReadyAt!.getTime() - Date.now()) + 1200);
    await reconcileSubmittedTickets();

    g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('COMPLETED');
    const final = await prisma.scheduleOutcome.findUniqueOrThrow({
      where: { groupId: group.id },
    });
    expect(final.completedAt).not.toBeNull();
    expect(final.readySpreadMs).not.toBeNull();
    expect(final.readySpreadMs!).toBeGreaterThanOrEqual(0);
    expect(final.targetErrorMs).not.toBeNull();
  });

  it('double lock creates exactly one ticket set', async () => {
    const { hall, burgerItem, drinkItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    await addItem(group.members[0]!.id, burgerItem);
    await addItem(group.members[0]!.id, drinkItem);

    const results = await Promise.allSettled([lockGroup(group.id), lockGroup(group.id)]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1);

    const tickets = await prisma.ticket.findMany({ where: { groupId: group.id } });
    expect(tickets.length).toBe(2); // one per vendor, no duplicates
  });

  it('concurrent final payments schedule exactly once', async () => {
    const { hall, burgerItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann', 'Bob']);
    const [ann, bob] = group.members;
    await addItem(ann!.id, burgerItem);
    await addItem(bob!.id, burgerItem);
    await lockGroup(group.id);
    await payMember(ann!.id);
    await payMember(bob!.id);

    await Promise.all([maybeSchedule(group.id), maybeSchedule(group.id)]);

    const outcomes = await prisma.scheduleOutcome.count({ where: { groupId: group.id } });
    expect(outcomes).toBe(1);
    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('SCHEDULED');
    const jobs = await fireTicketQueue.getJobs(['delayed', 'waiting', 'active', 'completed']);
    expect(jobs.length).toBe(1); // one ticket (same vendor), deduped jobId
  });

  it('payment timeout: drops unpaid items (DROPPED, not deleted), cancels the empty ticket, re-anchors tighter', async () => {
    const { hall, burgerItem, drinkItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann', 'Bob']);
    const [ann, bob] = group.members;
    // Ann pays for the FAST item; Bob never pays for the SLOWEST item — the
    // recompute must shrink the target.
    await addItem(ann!.id, drinkItem); // 1s
    await addItem(bob!.id, burgerItem); // 4s
    await lockGroup(group.id);
    const locked = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    await payMember(ann!.id);

    const before = Date.now();
    await handlePaymentTimeout(group.id);

    // Bob's item is audit trail, not gone.
    const bobItems = await prisma.orderItem.findMany({ where: { memberId: bob!.id } });
    expect(bobItems.length).toBe(1);
    expect(bobItems[0]!.status).toBe('DROPPED');
    expect(bobItems[0]!.droppedAt).not.toBeNull();
    // Bob himself still exists, still UNPAID, and no longer blocks anything.
    const bobRow = await prisma.member.findUniqueOrThrow({ where: { id: bob!.id } });
    expect(bobRow.payStatus).toBe('UNPAID');

    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('SCHEDULED');
    // Re-anchored from the drink alone: target ≈ now + 1s, strictly tighter
    // than the lock-time target (which included the 4s burger).
    expect(g.targetReadyAt!.getTime()).toBeLessThan(locked.targetReadyAt!.getTime());
    expect(Math.abs(g.targetReadyAt!.getTime() - (before + 1000))).toBeLessThan(1500);

    const tickets = await prisma.ticket.findMany({
      where: { groupId: group.id },
      include: { vendor: true },
    });
    expect(tickets.find((t) => t.vendor.name === 'Burgers')!.status).toBe('CANCELLED');
    expect(tickets.find((t) => t.vendor.name === 'Drinks')!.status).toBe('PENDING');

    const outcome = await prisma.scheduleOutcome.findUniqueOrThrow({
      where: { groupId: group.id },
    });
    expect(outcome.vendorCount).toBe(1);
    expect(outcome.itemCount).toBe(1);
  });

  it('payment timeout with nobody paid cancels the group and its tickets', async () => {
    const { hall, burgerItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    await addItem(group.members[0]!.id, burgerItem);
    await lockGroup(group.id);

    await handlePaymentTimeout(group.id);

    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('CANCELLED');
    const tickets = await prisma.ticket.findMany({ where: { groupId: group.id } });
    expect(tickets.every((t) => t.status === 'CANCELLED')).toBe(true);
    expect(await prisma.scheduleOutcome.count({ where: { groupId: group.id } })).toBe(0);
  });

  it('zero-item members never block scheduling', async () => {
    const { hall, burgerItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann', 'Lurker']);
    const [ann] = group.members;
    await addItem(ann!.id, burgerItem);
    await lockGroup(group.id);
    await payMember(ann!.id); // Lurker has no items and never pays
    await maybeSchedule(group.id);
    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('SCHEDULED');
  });

  it('fireTicket is idempotent and redriveTicket recovers a stuck ticket', async () => {
    const { hall, burgerItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    await addItem(group.members[0]!.id, burgerItem);
    await lockGroup(group.id);
    await payMember(group.members[0]!.id);
    await maybeSchedule(group.id);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { groupId: group.id } });

    // Double fire (BullMQ retry / duplicate delivery): one transition, stable ids.
    await fireTicket(ticket.id);
    const first = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    await fireTicket(ticket.id);
    const second = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(first.status).toBe('FIRED');
    expect(second.firedAt!.getTime()).toBe(first.firedAt!.getTime());
    expect(second.gotabOrderId).toBe(first.gotabOrderId);
  });

  it('redriveTicket submits a ticket whose fire job was lost', async () => {
    const { hall, burgerItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    await addItem(group.members[0]!.id, burgerItem);
    await lockGroup(group.id);
    await payMember(group.members[0]!.id);
    await maybeSchedule(group.id);
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { groupId: group.id } });
    expect(ticket.status).toBe('PENDING'); // job exists but no worker ran it

    await redriveTicket(ticket.id); // the sweep's recovery path
    const after = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe('FIRED'); // mock mode: we hold timers, so redrive fires
    expect(after.gotabOrderId).not.toBeNull();
  });
});

describe('HTTP response allowlists (S5)', () => {
  it('group view never leaks sessionToken or gotabLocationId, and hides dropped items', async () => {
    const { hall, burgers, burgerItem, drinkItem } = await seedHall();
    // Give the burger vendor an internal POS mapping that must NOT reach diners.
    await prisma.vendor.update({
      where: { id: burgers.id },
      data: { gotabLocationId: 'gotab-loc-secret' },
    });
    const group = await createGroup(hall.id, ['Ann', 'Bob']);
    const [ann, bob] = group.members;
    await addItem(ann!.id, burgerItem);
    const bobItem = await addItem(bob!.id, drinkItem);
    await prisma.orderItem.update({
      where: { id: bobItem.id },
      data: { status: 'DROPPED', droppedAt: new Date() },
    });

    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/groups/${group.id}` });
      expect(res.statusCode).toBe(200);
      const raw = res.body;
      expect(raw).not.toContain('sessionToken');
      expect(raw).not.toContain(ann!.sessionToken);
      expect(raw).not.toContain('gotab-loc-secret');

      const body = res.json();
      expect(body.joinCode).toBe(group.joinCode); // board still gets what it needs
      const allItems = body.members.flatMap((m: { orderItems: unknown[] }) => m.orderItems);
      expect(allItems.length).toBe(1); // the DROPPED item is invisible to clients

      // Create response still returns the member their own credentials.
      const created = await app.inject({
        method: 'POST',
        url: '/api/groups',
        payload: { foodHallId: hall.id, hostName: 'Host' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().memberToken).toBeTruthy();

      // Body-less POST with no Content-Type header — exactly what the
      // frontends send for /lock and /pay — must be accepted. Regression for
      // "Body cannot be empty when content-type is set to 'application/json'"
      // (the old api() helpers claimed JSON on body-less requests).
      const locked = await app.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/lock`,
        headers: { 'x-member-token': ann!.sessionToken },
      });
      expect(locked.statusCode).toBe(200);
      expect(locked.json().targetReadyAt).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
