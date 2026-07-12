import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getImportAdapter } from '../../vendor-adapter/index.js';
import { requireAuth } from '../auth/auth.routes.js';

const vendorSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  gotabLocationId: z.string().optional(),
});

const menuItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  priceCents: z.number().int().positive(),
  prepSeconds: z.number().int().positive(),
  available: z.boolean().optional(),
});

// Response allowlists (S5). The admin page reads gotabLocationId and
// available from this PUBLIC menu endpoint (audited against public/*.html),
// so they stay declared here — unlike group views, which strip them.
const menuResponseSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        vendors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: ['string', 'null'] },
              gotabLocationId: { type: ['string', 'null'] },
              active: { type: 'boolean' },
              menuItems: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: ['string', 'null'] },
                    priceCents: { type: 'number' },
                    prepSeconds: { type: 'number' },
                    prepConfirmed: { type: 'boolean' },
                    available: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

const defaultHallResponseSchema = {
  response: {
    200: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
  },
} as const;

const importGotabSchema = z.object({
  // Optional: blank means use GoTab's own location name. Provide a value only to
  // override GoTab's name (e.g. a cleaner customer-facing name).
  name: z.string().min(1).optional(),
  gotabLocationId: z.string().min(1),
  // Keep items available but flagged when GoTab has no prep time; the admin
  // sees which need a real prep. This flag lets a caller opt into hiding
  // prep-less items instead, if ever wanted.
  hideItemsMissingPrep: z.boolean().optional(),
});

export async function vendorRoutes(app: FastifyInstance) {
  // --- Public: resolve the default (first) food hall for the single-hall MVP ---
  app.get('/halls/default', { schema: defaultHallResponseSchema }, async () => {
    const hall = await prisma.foodHall.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!hall) throw notFound('No food hall configured');
    return { id: hall.id, name: hall.name };
  });

  // --- Public: list vendors + available menu for a food hall (customers) ---
  app.get('/halls/:hallId/menu', { schema: menuResponseSchema }, async (req) => {
    const { hallId } = req.params as { hallId: string };
    const vendors = await prisma.vendor.findMany({
      where: { foodHallId: hallId, active: true },
      include: {
        menuItems: {
          where: { available: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    return { vendors };
  });

  // --- Admin: vendor CRUD ---
  app.post(
    '/halls/:hallId/vendors',
    { preHandler: requireAuth('ADMIN') },
    async (req, reply) => {
      const { hallId } = req.params as { hallId: string };
      const body = vendorSchema.parse(req.body);
      const vendor = await prisma.vendor.create({
        data: { ...body, foodHallId: hallId },
      });
      return reply.status(201).send(vendor);
    },
  );

  app.patch(
    '/vendors/:vendorId',
    { preHandler: requireAuth('ADMIN') },
    async (req) => {
      const { vendorId } = req.params as { vendorId: string };
      const body = vendorSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body);
      return prisma.vendor.update({ where: { id: vendorId }, data: body });
    },
  );

  // --- Admin: menu item CRUD ---
  app.post(
    '/vendors/:vendorId/items',
    { preHandler: requireAuth('ADMIN') },
    async (req, reply) => {
      const { vendorId } = req.params as { vendorId: string };
      const body = menuItemSchema.parse(req.body);
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) throw notFound('Vendor not found');
      const item = await prisma.menuItem.create({ data: { ...body, vendorId } });
      return reply.status(201).send(item);
    },
  );

  app.patch(
    '/items/:itemId',
    { preHandler: requireAuth('ADMIN') },
    async (req) => {
      const { itemId } = req.params as { itemId: string };
      const body = menuItemSchema.partial().parse(req.body);
      // An admin explicitly setting prepSeconds means the prep time is now a
      // real, human-confirmed value — clear the "needs prep" flag so it stops
      // being treated as a placeholder.
      const data =
        body.prepSeconds !== undefined ? { ...body, prepConfirmed: true } : body;
      return prisma.menuItem.update({ where: { id: itemId }, data });
    },
  );

  // --- Admin: import a vendor + menu from GoTab ---
  // Reads the location's catalog from GoTab (real, even in mock fire-mode — see
  // getImportAdapter) and creates/updates the vendor and its menu items.
  // Idempotent: re-importing the same location updates existing items (matched
  // by gotabProductUuid) instead of duplicating.
  //
  // NOT ATOMIC — BY DESIGN (review M2, fixed 2026-07-12): the old version ran
  // ~2 sequential round trips PER PRODUCT inside one interactive transaction —
  // ~800 statements for a DSC-scale parent catalog (~400 products) against a
  // 5s tx timeout. This operation never needed atomicity; it needs IDEMPOTENT
  // CONVERGENCE, which the (vendorId, gotabProductUuid) key already gives it:
  // a mid-failure partial import is not corruption, it is an import you run
  // again. Shape now: one batch read of existing items → in-memory diff → one
  // createMany for new items → chunked updates for CHANGED rows only (stable
  // re-imports touch almost nothing) → deactivation sweep last → one final
  // read for the response. ~8 round trips for 400 products, no interactive tx.
  //
  // PREP TIME HONESTY: we store GoTab's ACTUAL value — if GoTab has no prep
  // (null or 0), we store 0 and set prepConfirmed=false. We do NOT fabricate a
  // placeholder number (an invented value that looks real is worse than an
  // honest zero). The response flags every unconfirmed item so the admin sets a
  // real prep. DEFERRED (option 1 follow-up): unconfirmed items are still
  // technically orderable — the scheduler will use their 0 prep and mis-stagger
  // if ordered before an admin fixes them. prepConfirmed is the breadcrumb for
  // adding "not orderable until confirmed" enforcement later.
  //
  // AVAILABILITY (verified mapping, project doc 2026-07-02): listProducts
  // returns AVAILABLE and UNAVAILABLE (86'd, auto-expiring) products; HIDDEN
  // and CUSTOM never reach us. UNAVAILABLE imports as local available:false —
  // runtime 86 state belongs in the catalog, not skipped, because GoTab
  // restores it on its own. For GoTab-linked items, GoTab is the availability
  // SOURCE OF TRUTH: re-import syncs `available` both directions on matched
  // items and deactivates local GoTab-linked items missing from the fetched
  // list (hidden/archived/deleted upstream). Hand-added items (null
  // gotabProductUuid) are never touched. The response NAMES everything
  // unavailable or deactivated — required while finding #5 stands (an
  // available:false item is invisible in the admin UI, so silence = confusion).
  app.post(
    '/halls/:hallId/vendors/import-gotab',
    { preHandler: requireAuth('ADMIN') },
    async (req, reply) => {
      const { hallId } = req.params as { hallId: string };
      const { name, gotabLocationId, hideItemsMissingPrep } = importGotabSchema.parse(
        req.body,
      );

      const hall = await prisma.foodHall.findUnique({ where: { id: hallId } });
      if (!hall) throw notFound('Food hall not found');

      // Pull the catalog from GoTab. Adapter errors (auth, bad location, network)
      // surface as 502 via AppError from the client layer.
      const adapter = getImportAdapter();
      let catalog;
      try {
        catalog = await adapter.listProducts(gotabLocationId);
      } catch (err) {
        throw badRequest(
          `Could not read products from GoTab for location ${gotabLocationId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const products = catalog.products;
      if (products.length === 0) {
        throw badRequest(
          `GoTab returned no importable products for location ${gotabLocationId}. ` +
            'Check the location id and that it has customer-facing (non-hidden, non-CUSTOM) products.',
        );
      }
      // Vendor name: admin's override if given, else GoTab's location name, else
      // a last-resort fallback so the vendor is never nameless.
      const vendorName = name ?? catalog.locationName ?? `Vendor ${gotabLocationId.slice(0, 8)}`;

      // Upsert the vendor by (hall, gotabLocationId) so re-import reuses it.
      // (findFirst+create has a benign race under concurrent imports of the
      // same location — admin-only route, pre-existing, accepted.)
      let vendor = await prisma.vendor.findFirst({
        where: { foodHallId: hallId, gotabLocationId },
      });
      vendor = vendor
        ? await prisma.vendor.update({ where: { id: vendor.id }, data: { name: vendorName } })
        : await prisma.vendor.create({
            data: { name: vendorName, gotabLocationId, foodHallId: hallId },
          });

      // One batch read of everything we might update, then diff in memory.
      const fetchedUuids = products.map((p) => p.gotabProductUuid);
      const existingRows = await prisma.menuItem.findMany({
        where: { vendorId: vendor.id, gotabProductUuid: { in: fetchedUuids } },
      });
      const existingByUuid = new Map(existingRows.map((r) => [r.gotabProductUuid!, r]));

      const toCreate: {
        vendorId: string;
        name: string;
        priceCents: number;
        prepSeconds: number;
        prepConfirmed: boolean;
        available: boolean;
        gotabProductUuid: string;
      }[] = [];
      const updates: { id: string; data: Record<string, unknown> }[] = [];

      for (const p of products) {
        const missingPrep = p.prepSeconds === null;
        const gotabSaysAvailable = p.availability === 'AVAILABLE';
        const existing = existingByUuid.get(p.gotabProductUuid);
        if (existing) {
          // Do NOT overwrite an admin-corrected prep time on re-import: only
          // refresh name/price/availability, and only fill prep if GoTab now
          // has a real value AND the item is still unconfirmed (never clobber
          // a human-set prep). Setting a real prep also confirms it.
          // `available` syncs BOTH directions from GoTab.
          const fillPrep = p.prepSeconds !== null && !existing.prepConfirmed;
          const changed =
            existing.name !== p.name ||
            existing.priceCents !== p.priceCents ||
            existing.available !== gotabSaysAvailable ||
            fillPrep;
          if (changed) {
            updates.push({
              id: existing.id,
              data: {
                name: p.name,
                priceCents: p.priceCents,
                available: gotabSaysAvailable,
                ...(fillPrep ? { prepSeconds: p.prepSeconds, prepConfirmed: true } : {}),
              },
            });
          }
        } else {
          toCreate.push({
            vendorId: vendor.id,
            name: p.name,
            priceCents: p.priceCents,
            // Store GoTab's actual value. Missing prep -> 0 (honest "unset"),
            // NOT a fabricated placeholder. prepConfirmed carries the signal;
            // confirmed only when GoTab actually supplied a prep time.
            prepSeconds: p.prepSeconds ?? 0,
            prepConfirmed: !missingPrep,
            // hideItemsMissingPrep applies at CREATION only; on update, GoTab's
            // availability is authoritative for GoTab-linked items.
            available: gotabSaysAvailable && !(missingPrep && hideItemsMissingPrep),
            gotabProductUuid: p.gotabProductUuid,
          });
        }
      }

      if (toCreate.length > 0) {
        // Single statement; skipDuplicates makes a concurrent-import race
        // converge instead of P2002 (the final read below picks up the winner).
        await prisma.menuItem.createMany({ data: toCreate, skipDuplicates: true });
      }
      const CHUNK = 50;
      for (let i = 0; i < updates.length; i += CHUNK) {
        await Promise.all(
          updates
            .slice(i, i + CHUNK)
            .map((u) => prisma.menuItem.update({ where: { id: u.id }, data: u.data })),
        );
      }

      // Deactivation sweep: local GoTab-linked items for this vendor that are
      // NOT in the fetched list have gone hidden/archived/deleted upstream —
      // deactivate them so our menu can't sell what GoTab no longer offers.
      // Runs LAST, and by construction can never touch a just-fetched item
      // (notIn fetchedUuids), so a mid-import failure cannot deactivate live
      // products. Hand-added items (gotabProductUuid null) are untouched.
      const stale = await prisma.menuItem.findMany({
        where: {
          vendorId: vendor.id,
          gotabProductUuid: { not: null, notIn: fetchedUuids },
          available: true,
        },
        select: { id: true, name: true },
      });
      if (stale.length > 0) {
        await prisma.menuItem.updateMany({
          where: { id: { in: stale.map((s) => s.id) } },
          data: { available: false },
        });
      }

      // One final read builds the response uniformly for created, updated,
      // and unchanged rows alike (same shape as before the M2 rework).
      const finalRows = await prisma.menuItem.findMany({
        where: { vendorId: vendor.id, gotabProductUuid: { in: fetchedUuids } },
      });
      const rowByUuid = new Map(finalRows.map((r) => [r.gotabProductUuid!, r]));
      const items = products.flatMap((p) => {
        const saved = rowByUuid.get(p.gotabProductUuid);
        if (!saved) return []; // unreachable in practice (created above); never 500 the summary over it
        return [{
          id: saved.id,
          name: saved.name,
          priceCents: saved.priceCents,
          prepSeconds: saved.prepSeconds,
          prepConfirmed: saved.prepConfirmed,
          needsPrepTime: !saved.prepConfirmed,
          available: saved.available,
          gotabUnavailable: p.availability !== 'AVAILABLE',
        }];
      });

      const needingPrep = items.filter((i) => i.needsPrepTime).length;
      const unavailableItems = items.filter((i) => i.gotabUnavailable).map((i) => i.name);
      return reply.status(201).send({
        vendorId: vendor.id,
        vendorName: vendor.name,
        importedCount: items.length,
        needingPrepTime: needingPrep,
        unavailableItems,
        deactivatedItems: stale.map((s) => s.name),
        items,
      });
    },
  );
}
