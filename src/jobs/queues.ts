import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { makeRedis } from '../lib/redis.js';

// Three queues:
//   - fireTicket: delayed jobs that send a ticket to its vendor at fireAt.
//     Only used when the vendor adapter does NOT hold schedules itself
//     (adapter.holdsSchedule === false, i.e. the mock). With GoTab the
//     platform holds scheduled orders and this queue sits idle.
//   - scheduleGroup: enqueued by markPaid() after each payment; the worker
//     runs maybeSchedule(). Moves scheduling orchestration (and vendor I/O)
//     out of the HTTP request path and gives it retry semantics — a payment
//     response no longer depends on N vendor calls, and a crash between
//     "paid" and "scheduled" is retried instead of lost.
//   - paymentTimeout: drops unpaid items if a group doesn't fully pay in time.

export interface FireTicketJob {
  ticketId: string;
}

export interface PaymentTimeoutJob {
  groupId: string;
}

export interface ScheduleGroupJob {
  groupId: string;
}

// Cast: npm frequently installs a second ioredis copy nested under bullmq,
// and the two copies' types are structurally incompatible (protected class
// members) even though the instance is fully compatible at runtime. The cast
// keeps `npm run typecheck` green regardless of node_modules layout.
const connection = makeRedis() as unknown as ConnectionOptions;

// RETENTION (leak review #6, 2026-07-18): BullMQ's DEFAULT keeps completed
// and failed jobs in Redis FOREVER — every payment/ticket/group adds
// permanent records, unbounded, surviving restarts (Redis persistence makes
// this a storage leak, not a process one). Keep a debugging window instead:
// completed jobs for 24h (capped), failures for a week (the sweeps and
// SWEEP: alerts reference them forensically). Queue-level defaults apply to
// every add unless a call site overrides.
const defaultJobOptions = {
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
};

export const fireTicketQueue = new Queue<FireTicketJob>('fireTicket', {
  connection,
  defaultJobOptions,
});
export const paymentTimeoutQueue = new Queue<PaymentTimeoutJob>('paymentTimeout', {
  connection,
  defaultJobOptions,
});
export const scheduleGroupQueue = new Queue<ScheduleGroupJob>('scheduleGroup', {
  connection,
  defaultJobOptions,
});

export const QUEUE_NAMES = {
  fireTicket: 'fireTicket',
  paymentTimeout: 'paymentTimeout',
  scheduleGroup: 'scheduleGroup',
} as const;

// Close all queues plus the shared connection. Used by integration-test
// teardown; long-running processes never call this.
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    fireTicketQueue.close(),
    paymentTimeoutQueue.close(),
    scheduleGroupQueue.close(),
  ]);
  await (connection as unknown as { quit: () => Promise<unknown> }).quit().catch(() => {});
}
