import type { FastifyInstance, FastifyRequest } from 'fastify';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { realtime } from '../realtime/broker.js';
import { lockGroup } from '../orders/orders.service.js';
import {
  activeGroupsRouteSchema,
  groupViewRouteSchema,
  memberCredentialsResponseSchema,
} from './groups.schemas.js';

// 6-char uppercase join codes (no ambiguous chars).
const genJoinCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const genToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 32);

// SECURITY: Member.sessionToken is a bearer credential — anyone holding it can
// act as that member (add items, pay, lock as host). It must NEVER appear in
// any response except the one returned to the member who owns it at
// create/join time. Every place members are serialized uses this explicit
// select instead of a bare include. (Previously GET /groups/:id and the public
// board feed returned full Member rows, leaking every member's token.)
const memberPublicSelect = {
  id: true,
  displayName: true,
  isHost: true,
  payStatus: true,
  createdAt: true,
} as const;

const createGroupSchema = z.object({
  foodHallId: z.string().uuid(),
  hostName: z.string().min(1).max(40),
});

const joinSchema = z.object({
  joinCode: z.string().length(6),
  displayName: z.string().min(1).max(40),
});

const addItemSchema = z.object({
  menuItemId: z.string().uuid(),
  qty: z.number().int().min(1).max(20).default(1),
  notes: z.string().max(200).optional(),
});

// Resolve the acting member from the X-Member-Token header.
async function getMember(req: FastifyRequest) {
  const token = req.headers['x-member-token'];
  if (typeof token !== 'string') throw forbidden('Missing member token');
  const member = await prisma.member.findUnique({ where: { sessionToken: token } });
  if (!member) throw forbidden('Invalid member token');
  return member;
}

// Shape a group for the client, with per-member items and totals.
// Members are projected through memberPublicSelect — no session tokens.
async function getGroupView(groupId: string) {
  const group = await prisma.groupOrder.findUnique({
    where: { id: groupId },
    include: {
      members: {
        select: {
          ...memberPublicSelect,
          // ACTIVE only (S7): dropped items stay in the DB as audit trail but
          // never appear in client views — identical client behavior to the
          // old hard delete.
          orderItems: {
            where: { status: 'ACTIVE' },
            include: { menuItem: { include: { vendor: true } } },
          },
        },
      },
      tickets: { include: { vendor: true } },
    },
  });
  if (!group) throw notFound('Group not found');
  return group;
}

export async function groupRoutes(app: FastifyInstance) {
  // Active groups for a hall (board display): locked through fired.
  // Public endpoint — members projected through memberPublicSelect AND the
  // response allowlist schema (S5).
  app.get(
    '/halls/:hallId/active-groups',
    { schema: activeGroupsRouteSchema },
    async (req) => {
    const { hallId } = req.params as { hallId: string };
    const groups = await prisma.groupOrder.findMany({
      where: { foodHallId: hallId, status: { in: ['LOCKED', 'SCHEDULED', 'FIRED'] } },
      include: {
        members: { select: memberPublicSelect },
        tickets: { include: { vendor: true } },
      },
      orderBy: { targetReadyAt: 'asc' },
    });
    return { groups };
    },
  );

  // Create a group; the creator becomes the host member. This response is the
  // ONLY place the host's sessionToken is returned (to its owner).
  // Rate-limited (M4): unauthenticated + row-creating. 30/min/IP stops
  // scripted group spam while staying far above real venue traffic, even
  // behind a shared NAT.
  app.post(
    '/groups',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: memberCredentialsResponseSchema,
    },
    async (req, reply) => {
    const { foodHallId, hostName } = createGroupSchema.parse(req.body);
    const hall = await prisma.foodHall.findUnique({ where: { id: foodHallId } });
    if (!hall) throw notFound('Food hall not found');

    const group = await prisma.groupOrder.create({
      data: {
        foodHallId,
        joinCode: genJoinCode(),
        members: {
          create: { displayName: hostName, isHost: true, sessionToken: genToken() },
        },
      },
      include: { members: true },
    });
    const host = group.members[0]!;
    return reply.status(201).send({
      groupId: group.id,
      joinCode: group.joinCode,
      memberToken: host.sessionToken,
      memberId: host.id,
    });
    },
  );

  // Join an existing open group by code. Like create, this response returns
  // the new member's own token — and only theirs.
  // Rate-limited (M4): 60/min/IP — higher than create because one shared NAT
  // can legitimately produce a burst of joins when a large table sits down.
  app.post(
    '/groups/join',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: memberCredentialsResponseSchema,
    },
    async (req, reply) => {
    const { joinCode, displayName } = joinSchema.parse(req.body);
    const group = await prisma.groupOrder.findUnique({ where: { joinCode } });
    if (!group) throw notFound('No group with that code');
    if (group.status !== 'OPEN') throw conflict('This group is no longer accepting members');

    const member = await prisma.member.create({
      data: { groupId: group.id, displayName, sessionToken: genToken() },
    });
    await realtime.publish({ type: 'group.updated', groupId: group.id });
    return reply.status(201).send({
      groupId: group.id,
      joinCode: group.joinCode,
      memberToken: member.sessionToken,
      memberId: member.id,
    });
    },
  );

  // Full group state (used by clients and the readiness board). Response
  // allowlist schema (S5) structurally strips anything undeclared.
  app.get('/groups/:groupId', { schema: groupViewRouteSchema }, async (req) => {
    const { groupId } = req.params as { groupId: string };
    return getGroupView(groupId);
  });

  // Add an item to the acting member's cart (only while OPEN).
  app.post('/groups/:groupId/items', async (req, reply) => {
    const { groupId } = req.params as { groupId: string };
    const member = await getMember(req);
    if (member.groupId !== groupId) throw forbidden('Member not in this group');

    const group = await prisma.groupOrder.findUnique({ where: { id: groupId } });
    if (!group) throw notFound('Group not found');
    if (group.status !== 'OPEN') throw conflict('Group is locked; cannot add items');

    const { menuItemId, qty, notes } = addItemSchema.parse(req.body);
    const menuItem = await prisma.menuItem.findUnique({
      where: { id: menuItemId },
      include: { vendor: { select: { foodHallId: true } } },
    });
    // Tenant guard: the item must belong to a vendor in THIS group's hall.
    // Harmless with one hall, but the schema is multi-tenant from day one and
    // every query must filter by hall (project doc) — otherwise a valid item
    // id from hall B could be injected into a hall A order.
    if (!menuItem || !menuItem.available || menuItem.vendor.foodHallId !== group.foodHallId) {
      throw badRequest('Item unavailable');
    }

    const item = await prisma.orderItem.create({
      data: {
        memberId: member.id,
        menuItemId,
        qty,
        notes,
        prepSecondsSnapshot: menuItem.prepSeconds,
        priceCentsSnapshot: menuItem.priceCents,
      },
    });
    await realtime.publish({ type: 'group.updated', groupId });
    return reply.status(201).send(item);
  });

  // Remove one of the acting member's items (only while OPEN).
  app.delete('/groups/:groupId/items/:itemId', async (req, reply) => {
    const { groupId, itemId } = req.params as { groupId: string; itemId: string };
    const member = await getMember(req);
    const item = await prisma.orderItem.findUnique({ where: { id: itemId } });
    if (!item || item.memberId !== member.id) throw forbidden('Not your item');

    const group = await prisma.groupOrder.findUnique({ where: { id: groupId } });
    if (group?.status !== 'OPEN') throw conflict('Group is locked; cannot remove items');

    await prisma.orderItem.delete({ where: { id: itemId } });
    await realtime.publish({ type: 'group.updated', groupId });
    return reply.status(204).send();
  });

  // Lock the group (host only). Freezes items and computes the schedule.
  app.post('/groups/:groupId/lock', async (req) => {
    const { groupId } = req.params as { groupId: string };
    const member = await getMember(req);
    if (member.groupId !== groupId || !member.isHost) {
      throw forbidden('Only the host can lock the group');
    }
    return lockGroup(groupId);
  });
}
