import { Worker } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { makeRedis, beatWorkerHeartbeat } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { realtime } from '../modules/realtime/broker.js';
import {
  fireTicket,
  handlePaymentTimeout,
  maybeSchedule,
} from '../modules/orders/orders.service.js';
import { reconcileSubmittedTickets } from '../modules/orders/status.service.js';
import { runSweeps } from '../modules/orders/sweeps.service.js';
import type { FireTicketJob, PaymentTimeoutJob, ScheduleGroupJob } from './queues.js';

// Separate process from the API. Run with `npm run worker`. Scale horizontally
// by running more worker instances — BullMQ distributes jobs across them.
//
// This process owns ALL orchestration: scheduling groups after payment,
// firing tickets (we-hold-timers mode), reconciling vendor status, payment
// timeouts, and the stuck-state/expiry sweeps. The API only records facts and
// enqueues. It also beats a Redis heartbeat every reconcile tick, which the
// API's /api/health surfaces — if this process dies, monitoring sees
// status: "degraded" within a minute instead of tables silently not eating.
//
// Note on adapter modes: when the configured vendor adapter holdsSchedule
// (GoTab), tickets are submitted to the platform at the all-paid moment and
// the fireTicket queue sits idle — the worker still matters: scheduling,
// timeouts, reconcile, and sweeps all run here.

// See queues.ts for why this cast exists (duplicate nested ioredis types).
const connection = makeRedis() as unknown as ConnectionOptions;
realtime.start();

const fireWorker = new Worker<FireTicketJob>(
  'fireTicket',
  async (job) => {
    logger.info({ ticketId: job.data.ticketId }, 'processing fireTicket job');
    await fireTicket(job.data.ticketId);
  },
  { connection, concurrency: 10 },
);

const scheduleWorker = new Worker<ScheduleGroupJob>(
  'scheduleGroup',
  async (job) => {
    logger.info({ groupId: job.data.groupId }, 'processing scheduleGroup job');
    await maybeSchedule(job.data.groupId);
  },
  { connection, concurrency: 5 },
);

const timeoutWorker = new Worker<PaymentTimeoutJob>(
  'paymentTimeout',
  async (job) => {
    logger.info({ groupId: job.data.groupId }, 'processing paymentTimeout job');
    await handlePaymentTimeout(job.data.groupId);
  },
  { connection, concurrency: 5 },
);

for (const w of [fireWorker, scheduleWorker, timeoutWorker]) {
  w.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'job failed'));
}

// Poll submitted tickets every 10s to advance them PENDING -> FIRED -> READY
// and complete groups. Cheap, and trivially replaceable by a GoTab webhook
// later (see status.service.ts). The heartbeat is written here — first, so a
// wedged reconcile still shows up as a stale beat rather than a healthy one.
// OVERLAP GUARD (review #3 fresh-eyes, 2026-07-08): a reconcile pass that
// outruns the 10s interval (many in-flight tickets × the 280ms GoTab pacing
// gate) must not stack concurrent passes — correctness would survive (all
// transitions are conditional) but the duplicate polls burn the 4rps budget.
// Skipped ticks are logged so a chronically slow reconcile is visible.
let reconcileInFlight = false;
const reconcileLoop = setInterval(() => {
  beatWorkerHeartbeat().catch((err) => logger.error({ err }, 'heartbeat write failed'));
  if (reconcileInFlight) {
    logger.warn('reconcile still running from previous tick — skipping (see review M4: batch-status query is the scale fix)');
    return;
  }
  reconcileInFlight = true;
  reconcileSubmittedTickets()
    .catch((err) => logger.error({ err }, 'reconcile loop error'))
    .finally(() => { reconcileInFlight = false; });
}, 10_000);

// Stuck-state + lifecycle sweeps (see sweeps.service.ts): the backstop for
// lost jobs and the expiry of abandoned OPEN groups.
const sweepLoop = setInterval(() => {
  runSweeps().catch((err) => logger.error({ err }, 'sweep loop error'));
}, 60_000);

// Beat immediately so /api/health goes green as soon as the worker is up.
beatWorkerHeartbeat().catch((err) => logger.error({ err }, 'initial heartbeat failed'));

logger.info('Workers started: fireTicket, scheduleGroup, paymentTimeout, reconciler, sweeps');

const shutdown = async () => {
  clearInterval(reconcileLoop);
  clearInterval(sweepLoop);
  await Promise.all([fireWorker.close(), scheduleWorker.close(), timeoutWorker.close()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
