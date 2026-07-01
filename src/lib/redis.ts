import { Redis } from 'ioredis';
import { config } from '../config/index.js';

// BullMQ requires maxRetriesPerRequest: null on its connections.
export function makeRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

// Shared connection for general pub/sub + caching (not used by BullMQ workers).
export const redis = makeRedis();

// --- Worker liveness heartbeat (M2) ---
// The worker SETs this key every reconcile tick; the API's /api/health reads
// it. If the worker dies, nothing fires/reconciles/times-out while the API
// keeps accepting orders — this makes that failure visible to any uptime
// monitor within a minute instead of via an annoyed operator.
const WORKER_HEARTBEAT_KEY = 'foodhall:worker:heartbeat';

export async function beatWorkerHeartbeat(): Promise<void> {
  await redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()));
}

// ms since the last beat, or null if the worker has never beaten.
export async function workerHeartbeatAgeMs(): Promise<number | null> {
  const value = await redis.get(WORKER_HEARTBEAT_KEY);
  if (!value) return null;
  const ts = Number(value);
  if (!Number.isFinite(ts)) return null;
  return Date.now() - ts;
}
