import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { unauthorized, forbidden } from '../../lib/errors.js';
import { hashPassword, verifyPassword, type JwtPayload } from './auth.service.js';

// Type @fastify/jwt's payload/user instead of re-declaring FastifyRequest.user
// ourselves: the plugin already augments FastifyRequest with `user`, and a
// second conflicting declaration is a compile error. This is the supported
// extension point.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload; // what app.jwt.sign() accepts
    user: JwtPayload; // what req.user is after jwtVerify()
  }
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Bootstrap CREATES the admin account, so it enforces a minimum password
// policy — unlike login, which correctly accepts anything (never enforce
// policy at verification time; review #5). min(1) on login stays.
const bootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Admin password must be at least 8 characters'),
});

// Require a valid JWT; optionally require a specific role.
export function requireAuth(role?: 'ADMIN' | 'VENDOR') {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    try {
      const payload = await req.jwtVerify<JwtPayload>();
      req.user = payload;
    } catch {
      throw unauthorized('Invalid or missing token');
    }
    if (role && req.user?.role !== role) throw forbidden(`Requires ${role} role`);
  };
}

export async function authRoutes(app: FastifyInstance) {
  // Rate-limited (M4): credential-guessing surface. 20/min/IP is generous for
  // humans (a couple of staff logins) and hostile to brute force.
  app.post(
    '/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw unauthorized('Invalid credentials');
    }
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role,
      vendorId: user.vendorId ?? undefined,
    };
    const token = app.jwt.sign(payload, { expiresIn: '12h' });
    return reply.send({ token, role: user.role, vendorId: user.vendorId });
    },
  );

  // Bootstrap helper: create the first admin if none exists. Disabled once any
  // admin exists, so it can't be abused after setup.
  // Rate-limited (M4): tight — it's a setup-only endpoint.
  app.post(
    '/bootstrap-admin',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const existing = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (existing > 0) throw forbidden('Admin already exists');
    const { email, password } = bootstrapSchema.parse(req.body);
    const user = await prisma.user.create({
      data: { email, passwordHash: hashPassword(password), role: 'ADMIN' },
    });
    return reply.status(201).send({ id: user.id, email: user.email });
    },
  );
}
