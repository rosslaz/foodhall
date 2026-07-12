import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// GUARD-FAMILY integration tests (review H1+H2 / prep Phase A, the A4 item):
// the fail-fast orderability guards and the terminal fire-failure blast
// pattern, against real Postgres + Redis. Lives in its OWN file because the
// terminal tests vi.mock the vendor-adapter module — vitest isolates module
// registries per test file, so lifecycle.int.test.ts keeps the real mock
// adapter (its happy path depends on the mock kitchen's timing behavior).
//
// COVERAGE BOUNDARY (deliberate): the config-gated guard branches
// (VENDOR_ADAPTER === 'gotab' → vendor.gotabLocationId / gotabProductUuid
// checks) are NOT exercised here — the int environment forces the mock
// adapter, and remocking the config module isn't worth the fragility. Those
// branches are three synchronous null-checks reviewed by eye; they get real
// coverage when the creds-gated test:gotab suite exists (roadmap 2.7).

// The mocked adapter: throws a TERMINAL error (4xx AppError — what the real
// GoTab adapter raises for unmapped items) whenever the ticket contains a
// burger-named item; accepts everything else like the mock would. This lets
// one test fire a sibling successfully BEFORE the terminal failure, proving
// FIRED siblings are preserved (food cooking cannot be un-cooked).
const submitSpy = vi.fn();
vi.mock('../../vendor-adapter/index.js', async () => {
  const { AppError } = await import('../../lib/errors.js');
  const adapter = {
    name: 'terminal-test-mock',
    holdsSchedule: false,
    async submitTicket(req: { ticketId: string; items: Array<{ name: string }>; targetReadyAt: Date }) {
      submitSpy(req.ticketId);
      if (req.items.some((i) => i.name.includes('Burger'))) {
        throw new AppError(400, 'GOTAB_UNMAPPED_ITEMS', 'terminal: unmapped items (test)');
      }
      return {
        externalOrderId: `ext_${req.ticketId.slice(0, 8)}`,
        acceptedAt: new Date(),
        estimatedReadyAt: req.targetReadyAt,
      };
    },
    async getTicketStatus() {
      return 'IN_PROGRESS' as const;
    },
    async cancelTicket() {},
    async listProducts() {
      return { locationName: null, products: [] };
    },
  };
  return { getVendorAdapter: () => adapter, getImportAdapter: () => adapter };
});

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
import { buildServer } from '../../server.js';

const rand = () => Math.random().toString(36).slice(2, 10);

async function seedHall(opts: { burgerPrepConfirmed?: boolean } = {}) {
  const hall = await prisma.foodHall.create({ data: { name: `Hall ${rand()}` } });
  const burgers = await prisma.vendor.create({ data: { foodHallId: hall.id, name: 'Burgers' } });
  const drinks = await prisma.vendor.create({ data: { foodHallId: hall.id, name: 'Drinks' } });
  const burgerItem = await prisma.menuItem.create({
    data: {
      vendorId: burgers.id,
      name: 'Burger',
      priceCents: 1200,
      prepSeconds: opts.burgerPrepConfirmed === false ? 0 : 4,
      prepConfirmed: opts.burgerPrepConfirmed ?? true,
    },
  });
  const drinkItem = await prisma.menuItem.create({
    data: { vendorId: drinks.id, name: 'Lemonade', priceCents: 400, prepSeconds: 1 },
  });
  return { hall, burgers, drinks, burgerItem, drinkItem };
}

async function createGroup(foodHallId: string, memberNames: string[]) {
  return prisma.groupOrder.create({
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

beforeEach(async () => {
  submitSpy.mockClear();
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

describe('orderability guards (H2 / finding #7)', () => {
  it('add-item rejects unconfirmed-prep items with 400, accepts after confirmation', async () => {
    const { hall, burgerItem } = await seedHall({ burgerPrepConfirmed: false });
    const group = await createGroup(hall.id, ['Ann']);
    const ann = group.members[0]!;

    const app = await buildServer();
    try {
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/items`,
        headers: { 'x-member-token': ann.sessionToken },
        payload: { menuItemId: burgerItem.id, qty: 1 },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().message).toContain('not orderable yet');

      // Admin sets a real prep time (what the PATCH route does) — orderable.
      await prisma.menuItem.update({
        where: { id: burgerItem.id },
        data: { prepSeconds: 240, prepConfirmed: true },
      });
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/groups/${group.id}/items`,
        headers: { 'x-member-token': ann.sessionToken },
        payload: { menuItemId: burgerItem.id, qty: 1 },
      });
      expect(accepted.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('lock re-validates: an item un-confirmed AFTER being added blocks the lock with a named error', async () => {
    const { hall, burgerItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    await addItem(group.members[0]!.id, burgerItem);

    // Simulate the backstop scenario: config changed post-add (e.g. a
    // re-import un-confirmed the prep). The add-time guard passed; the lock
    // must still refuse — failing here is recoverable, failing at fire time
    // strands a paid group.
    await prisma.menuItem.update({
      where: { id: burgerItem.id },
      data: { prepConfirmed: false, prepSeconds: 0 },
    });

    await expect(lockGroup(group.id)).rejects.toThrow(/not orderable yet.*Burger/);
    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('OPEN'); // lock rolled back — nothing half-locked
  });
});

describe('terminal fire failure (H1 blast pattern)', () => {
  it('terminal submit → ticket FAILED, group CANCELLED, PENDING sibling CANCELLED, FIRED sibling preserved, no retry', async () => {
    const { hall, burgerItem, drinkItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    const ann = group.members[0]!;
    await addItem(ann.id, burgerItem); // terminal-throwing vendor
    await addItem(ann.id, drinkItem); // accepted vendor
    await lockGroup(group.id);
    await payMember(ann.id);
    await maybeSchedule(group.id);

    const tickets = await prisma.ticket.findMany({
      where: { groupId: group.id },
      include: { vendor: true },
    });
    const burgerTicket = tickets.find((t) => t.vendor.name === 'Burgers')!;
    const drinkTicket = tickets.find((t) => t.vendor.name === 'Drinks')!;

    // Drink fires successfully FIRST — it is now cooking at a real kitchen.
    await fireTicket(drinkTicket.id);
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: drinkTicket.id } })).status,
    ).toBe('FIRED');

    // Burger fails terminally: the blast pattern.
    await fireTicket(burgerTicket.id); // must NOT throw — terminal errors are swallowed
    const burger = await prisma.ticket.findUniqueOrThrow({ where: { id: burgerTicket.id } });
    expect(burger.status).toBe('FAILED');
    const g = await prisma.groupOrder.findUniqueOrThrow({ where: { id: group.id } });
    expect(g.status).toBe('CANCELLED'); // countdown stops; clients render a terminal state
    // The FIRED sibling is preserved — food cooking cannot be un-cooked.
    const drink = await prisma.ticket.findUniqueOrThrow({ where: { id: drinkTicket.id } });
    expect(drink.status).toBe('FIRED');
    // Telemetry: cancelled mid-flight = actuals stay null (itself signal).
    const outcome = await prisma.scheduleOutcome.findUniqueOrThrow({
      where: { groupId: group.id },
    });
    expect(outcome.completedAt).toBeNull();

    // No retry / no redrive: a second fire is a no-op (ticket is not PENDING)
    // — the adapter is never called again for the failed ticket.
    const callsAfterFailure = submitSpy.mock.calls.length;
    await fireTicket(burgerTicket.id);
    expect(submitSpy.mock.calls.length).toBe(callsAfterFailure);
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: burgerTicket.id } })).status,
    ).toBe('FAILED');
  });

  it('terminal failure with a PENDING sibling cancels the sibling (its timer will no-op)', async () => {
    const { hall, burgerItem, drinkItem } = await seedHall();
    const group = await createGroup(hall.id, ['Ann']);
    const ann = group.members[0]!;
    await addItem(ann.id, burgerItem);
    await addItem(ann.id, drinkItem);
    await lockGroup(group.id);
    await payMember(ann.id);
    await maybeSchedule(group.id);

    const tickets = await prisma.ticket.findMany({
      where: { groupId: group.id },
      include: { vendor: true },
    });
    const burgerTicket = tickets.find((t) => t.vendor.name === 'Burgers')!;
    const drinkTicket = tickets.find((t) => t.vendor.name === 'Drinks')!;

    // Burger fails terminally while the drink is still PENDING (its delayed
    // fire job hasn't run yet).
    await fireTicket(burgerTicket.id);

    const drink = await prisma.ticket.findUniqueOrThrow({ where: { id: drinkTicket.id } });
    expect(drink.status).toBe('CANCELLED');
    // When the drink's delayed job eventually fires, it must no-op on the
    // status guard — the kitchen never sees a ticket for a cancelled group.
    const callsBefore = submitSpy.mock.calls.length;
    await fireTicket(drinkTicket.id);
    expect(submitSpy.mock.calls.length).toBe(callsBefore);
    expect(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: drinkTicket.id } })).status,
    ).toBe('CANCELLED');
  });
});
