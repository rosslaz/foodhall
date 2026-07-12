import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// GoTab menu-import integration tests (review M2, fixed 2026-07-12): the
// import was reworked from ~2 sequential round trips per product inside one
// interactive transaction (~800 statements for a DSC-scale parent catalog vs
// a 5s tx timeout) to set-based idempotent convergence. These tests prove the
// DSC-scale path (400 products) and the re-import sync semantics the admin
// UI depends on. Own file: getImportAdapter is vi.mocked to serve a
// controllable catalog (vitest per-file module registries keep the other int
// files on their real modules).

import type { VendorProduct } from '../../vendor-adapter/types.js';

let mockProducts: VendorProduct[] = [];
let mockLocationName: string | null = 'Mock Location';

vi.mock('../../vendor-adapter/index.js', async () => {
  const adapter = {
    name: 'import-test-mock',
    holdsSchedule: false,
    async submitTicket() {
      throw new Error('not used in import tests');
    },
    async getTicketStatus() {
      return 'IN_PROGRESS' as const;
    },
    async cancelTicket() {},
    // Factory executes lazily (after module top-levels), so reading the
    // mutable catalog at call time is safe — same pattern as guards.int.
    async listProducts() {
      return { locationName: mockLocationName, products: mockProducts };
    },
  };
  return { getVendorAdapter: () => adapter, getImportAdapter: () => adapter };
});

import { prisma } from '../../db/client.js';
import { redis } from '../../lib/redis.js';
import { closeQueues } from '../../jobs/queues.js';
import { realtime } from '../../modules/realtime/broker.js';
import { buildServer } from '../../server.js';

function makeProduct(i: number, overrides: Partial<VendorProduct> = {}): VendorProduct {
  return {
    gotabProductUuid: `prd_test_${i}`,
    name: `Item ${i}`,
    priceCents: 500 + i,
    prepSeconds: 120,
    availability: 'AVAILABLE',
    ...overrides,
  };
}

async function adminToken(app: Awaited<ReturnType<typeof buildServer>>) {
  await app.inject({
    method: 'POST',
    url: '/api/auth/bootstrap-admin',
    payload: { email: 'admin@test.io', password: 'admin1234' },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@test.io', password: 'admin1234' },
  });
  return login.json().token as string;
}

function importCall(
  app: Awaited<ReturnType<typeof buildServer>>,
  token: string,
  hallId: string,
  gotabLocationId: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/halls/${hallId}/vendors/import-gotab`,
    headers: { authorization: `Bearer ${token}` },
    payload: { gotabLocationId },
  });
}

beforeEach(async () => {
  mockProducts = [];
  mockLocationName = 'Mock Location';
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ScheduleOutcome", "OrderItem", "Ticket", "Member", "GroupOrder", "MenuItem", "Vendor", "User", "FoodHall" CASCADE',
  );
});

afterAll(async () => {
  await closeQueues();
  await realtime.close();
  await redis.quit().catch(() => {});
  await prisma.$disconnect();
});

describe('GoTab menu import (M2: DSC-scale + sync semantics)', () => {
  it('imports a 400-product parent-scale catalog in one call', async () => {
    // 380 normal, 15 with no prep time (unconfirmed), 5 currently 86d.
    mockProducts = [
      ...Array.from({ length: 380 }, (_, i) => makeProduct(i)),
      ...Array.from({ length: 15 }, (_, i) => makeProduct(380 + i, { prepSeconds: null })),
      ...Array.from({ length: 5 }, (_, i) =>
        makeProduct(395 + i, { availability: 'UNAVAILABLE' }),
      ),
    ];
    const hall = await prisma.foodHall.create({ data: { name: 'DSC Test' } });
    const app = await buildServer();
    try {
      const token = await adminToken(app);
      const res = await importCall(app, token, hall.id, 'loc_parent_scale');
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.importedCount).toBe(400);
      expect(body.needingPrepTime).toBe(15);
      expect(body.unavailableItems.length).toBe(5);
      expect(body.deactivatedItems.length).toBe(0);

      const dbCount = await prisma.menuItem.count({
        where: { vendor: { gotabLocationId: 'loc_parent_scale' } },
      });
      expect(dbCount).toBe(400);
      // 86'd products imported as available:false (runtime state belongs in
      // the catalog — GoTab restores it upstream on its own).
      const unavailable = await prisma.menuItem.count({
        where: { vendor: { gotabLocationId: 'loc_parent_scale' }, available: false },
      });
      expect(unavailable).toBe(5);
    } finally {
      await app.close();
    }
  });

  it('re-import converges: price sync, 86 sync, upstream removal deactivates, new item appears, admin prep never clobbered', async () => {
    mockProducts = [
      makeProduct(1), // will get a price change
      makeProduct(2), // will flip UNAVAILABLE
      makeProduct(3), // will vanish upstream -> deactivated
      makeProduct(4, { prepSeconds: null }), // admin will confirm prep; GoTab later supplies one
    ];
    const hall = await prisma.foodHall.create({ data: { name: 'Sync Test' } });
    const app = await buildServer();
    try {
      const token = await adminToken(app);
      expect((await importCall(app, token, hall.id, 'loc_sync')).statusCode).toBe(201);

      // Admin sets a real prep on item 4 (what PATCH /items does).
      const item4 = await prisma.menuItem.findFirstOrThrow({
        where: { gotabProductUuid: 'prd_test_4' },
      });
      await prisma.menuItem.update({
        where: { id: item4.id },
        data: { prepSeconds: 300, prepConfirmed: true },
      });

      // Upstream changes: price bump on 1; 2 goes 86'd; 3 disappears; 5 is
      // new; 4 now has a GoTab prep that must NOT clobber the admin's 300s.
      mockProducts = [
        makeProduct(1, { priceCents: 999 }),
        makeProduct(2, { availability: 'UNAVAILABLE' }),
        makeProduct(4, { prepSeconds: 60 }),
        makeProduct(5),
      ];
      const res = await importCall(app, token, hall.id, 'loc_sync');
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.importedCount).toBe(4);
      expect(body.deactivatedItems).toEqual(['Item 3']);
      expect(body.unavailableItems).toEqual(['Item 2']);

      const rows = await prisma.menuItem.findMany({
        where: { vendor: { gotabLocationId: 'loc_sync' } },
      });
      const byUuid = new Map(rows.map((r) => [r.gotabProductUuid, r]));
      expect(byUuid.get('prd_test_1')!.priceCents).toBe(999);
      expect(byUuid.get('prd_test_2')!.available).toBe(false);
      expect(byUuid.get('prd_test_3')!.available).toBe(false); // deactivated, not deleted
      expect(byUuid.get('prd_test_4')!.prepSeconds).toBe(300); // admin value preserved
      expect(byUuid.get('prd_test_4')!.prepConfirmed).toBe(true);
      expect(byUuid.get('prd_test_5')).toBeTruthy(); // new item created

      // No duplicates: exactly one vendor, exactly 5 items total.
      expect(await prisma.vendor.count({ where: { gotabLocationId: 'loc_sync' } })).toBe(1);
      expect(rows.length).toBe(5);
    } finally {
      await app.close();
    }
  });

  it('unconfirmed prep fills and confirms when GoTab later supplies a real value', async () => {
    mockProducts = [makeProduct(1, { prepSeconds: null })];
    const hall = await prisma.foodHall.create({ data: { name: 'Prep Test' } });
    const app = await buildServer();
    try {
      const token = await adminToken(app);
      await importCall(app, token, hall.id, 'loc_prep');
      let row = await prisma.menuItem.findFirstOrThrow({
        where: { gotabProductUuid: 'prd_test_1' },
      });
      expect(row.prepConfirmed).toBe(false);
      expect(row.prepSeconds).toBe(0); // honest zero, never a fabricated placeholder

      mockProducts = [makeProduct(1, { prepSeconds: 180 })];
      const res = await importCall(app, token, hall.id, 'loc_prep');
      expect(res.json().needingPrepTime).toBe(0);
      row = await prisma.menuItem.findFirstOrThrow({
        where: { gotabProductUuid: 'prd_test_1' },
      });
      expect(row.prepSeconds).toBe(180);
      expect(row.prepConfirmed).toBe(true); // GoTab-supplied prep confirms
    } finally {
      await app.close();
    }
  });
});
