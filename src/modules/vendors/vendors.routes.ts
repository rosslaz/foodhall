import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
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
      return prisma.menuItem.update({ where: { id: itemId }, data: body });
    },
  );
}
