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
  // getImportAdapter) and creates/updates the vendor and its menu items in one
  // transaction. Idempotent: re-importing the same location updates existing
  // items (matched by gotabProductUuid) instead of duplicating.
  //
  // PREP TIME HONESTY: we store GoTab's ACTUAL value — if GoTab has no prep
  // (null or 0), we store 0 and set prepConfirmed=false. We do NOT fabricate a
  // placeholder number (an invented value that looks real is worse than an
  // honest zero). The response flags every unconfirmed item so the admin sets a
  // real prep. DEFERRED (option 1 follow-up): unconfirmed items are still
  // technically orderable — the scheduler will use their 0 prep and mis-stagger
  // if ordered before an admin fixes them. prepConfirmed is the breadcrumb for
  // adding "not orderable until confirmed" enforcement later.
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
          `GoTab returned no orderable products for location ${gotabLocationId}. ` +
            'Check the location id and that it has orderable (non-CUSTOM) products.',
        );
      }
      // Vendor name: admin's override if given, else GoTab's location name, else
      // a last-resort fallback so the vendor is never nameless.
      const vendorName = name ?? catalog.locationName ?? `Vendor ${gotabLocationId.slice(0, 8)}`;

      // Upsert the vendor by (hall, gotabLocationId) so re-import reuses it.
      const created = await prisma.$transaction(async (tx) => {
        let vendor = await tx.vendor.findFirst({
          where: { foodHallId: hallId, gotabLocationId },
        });
        vendor = vendor
          ? await tx.vendor.update({ where: { id: vendor.id }, data: { name: vendorName } })
          : await tx.vendor.create({
              data: { name: vendorName, gotabLocationId, foodHallId: hallId },
            });

        const items = [];
        for (const p of products) {
          const missingPrep = p.prepSeconds === null;
          // Store GoTab's actual value. Missing prep -> 0 (honest "unset"),
          // NOT a fabricated placeholder. prepConfirmed carries the real signal.
          const prepSeconds = p.prepSeconds ?? 0;
          const available = missingPrep && hideItemsMissingPrep ? false : true;
          // Match an existing item by (vendor, gotabProductUuid) for idempotency.
          const existing = await tx.menuItem.findFirst({
            where: { vendorId: vendor.id, gotabProductUuid: p.gotabProductUuid },
          });
          const saved = existing
            ? await tx.menuItem.update({
                where: { id: existing.id },
                // Do NOT overwrite an admin-corrected prep time on re-import:
                // only refresh name/price, and only fill prep if GoTab now has a
                // real value AND the item is still unconfirmed (never clobber a
                // human-set prep). Setting a real prep also confirms it.
                data: {
                  name: p.name,
                  priceCents: p.priceCents,
                  ...(p.prepSeconds !== null && !existing.prepConfirmed
                    ? { prepSeconds: p.prepSeconds, prepConfirmed: true }
                    : {}),
                },
              })
            : await tx.menuItem.create({
                data: {
                  vendorId: vendor.id,
                  name: p.name,
                  priceCents: p.priceCents,
                  prepSeconds,
                  // Confirmed only when GoTab actually supplied a prep time.
                  // Items with no GoTab prep stay unconfirmed (prep = 0) until
                  // an admin sets a real one.
                  prepConfirmed: !missingPrep,
                  available,
                  gotabProductUuid: p.gotabProductUuid,
                },
              });
          items.push({
            id: saved.id,
            name: saved.name,
            priceCents: saved.priceCents,
            prepSeconds: saved.prepSeconds,
            prepConfirmed: saved.prepConfirmed,
            needsPrepTime: !saved.prepConfirmed,
          });
        }
        return { vendor, items };
      });

      const needingPrep = created.items.filter((i) => i.needsPrepTime).length;
      return reply.status(201).send({
        vendorId: created.vendor.id,
        vendorName: created.vendor.name,
        importedCount: created.items.length,
        needingPrepTime: needingPrep,
        items: created.items,
      });
    },
  );
}
