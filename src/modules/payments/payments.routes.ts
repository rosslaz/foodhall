import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../../db/client.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { realtime } from '../realtime/broker.js';
import { scheduleGroupQueue } from '../../jobs/queues.js';

// Per-member payment. For the MVP this is a mock that simply marks the member
// PAID and hands the "can the whole group be scheduled now?" question to the
// worker via a durable job.
//
// Real-provider seam: when wiring Stripe (or GoTab payments), this endpoint
// becomes "create payment intent" and a webhook handler calls markPaid() after
// confirmation. markPaid() itself stays unchanged — and because it enqueues
// rather than orchestrating inline, webhook handlers inherit the same
// reliability.

async function getMember(req: FastifyRequest) {
  const token = req.headers['x-member-token'];
  if (typeof token !== 'string') throw forbidden('Missing member token');
  const member = await prisma.member.findUnique({ where: { sessionToken: token } });
  if (!member) throw forbidden('Invalid member token');
  return member;
}

export async function markPaid(memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { orderItems: true },
  });
  if (!member) throw notFound('Member not found');
  await prisma.member.update({ where: { id: memberId }, data: { payStatus: 'PAID' } });
  await realtime.publish({ type: 'group.updated', groupId: member.groupId });

  // Scheduling runs in the worker, not inline: the payer's HTTP response must
  // not depend on vendor network calls, and a crash between "paid" and
  // "scheduled" must be retried, not lost. The jobId is per PAYMENT EVENT
  // (group + member), deliberately not per group: a per-group id could dedupe
  // away the last payment's job while an earlier, already-running job had
  // read stale not-all-paid state. Extra jobs are harmless — maybeSchedule's
  // conditional LOCKED→SCHEDULED flip guarantees exactly-once scheduling.
  await scheduleGroupQueue.add(
    'schedule',
    { groupId: member.groupId },
    {
      jobId: `schedule_${member.groupId}_${memberId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}

export async function paymentRoutes(app: FastifyInstance) {
  // Return the acting member's total (what they owe).
  app.get('/payments/me', async (req) => {
    const member = await getMember(req);
    // ACTIVE only (S7): items dropped by the payment timeout are not owed.
    const items = await prisma.orderItem.findMany({
      where: { memberId: member.id, status: 'ACTIVE' },
    });
    const totalCents = items.reduce((s, i) => s + i.priceCentsSnapshot * i.qty, 0);
    return { memberId: member.id, payStatus: member.payStatus, totalCents, items };
  });

  // Mock "pay now". Only valid once the group is LOCKED.
  app.post('/payments/pay', async (req) => {
    const member = await getMember(req);
    const group = await prisma.groupOrder.findUnique({ where: { id: member.groupId } });
    if (!group) throw notFound('Group not found');
    if (group.status !== 'LOCKED' && group.status !== 'SCHEDULED') {
      throw conflict('Group must be locked before paying');
    }
    if (member.payStatus === 'PAID') return { ok: true, alreadyPaid: true };
    await markPaid(member.id);
    return { ok: true };
  });
}
