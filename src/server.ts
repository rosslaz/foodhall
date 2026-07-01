import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { workerHeartbeatAgeMs } from './lib/redis.js';
import { errorHandler } from './lib/errors.js';
import { realtime } from './modules/realtime/broker.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { vendorRoutes } from './modules/vendors/vendors.routes.js';
import { groupRoutes } from './modules/groups/groups.routes.js';
import { paymentRoutes } from './modules/payments/payments.routes.js';
import { realtimeRoutes } from './modules/realtime/realtime.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  // Fastify 4.x accepts a pino instance via `logger` (`loggerInstance` is a
  // Fastify 5 option and is a type error here).
  const app = Fastify({ logger });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.JWT_SECRET });
  // global: false — limits apply ONLY to routes that opt in via
  // config.rateLimit (group create/join, login, bootstrap-admin). Read routes
  // are deliberately uncapped: at a venue, every diner shares the venue NAT's
  // public IP, so aggressive per-IP global limits would throttle legitimate
  // Friday-night traffic collectively. The per-route limits stop scripted
  // abuse without touching real usage.
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  // Serve the three frontend surfaces as static files.
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
  });

  app.setErrorHandler(errorHandler);

  // Health covers BOTH processes: the API (by responding at all) and the
  // worker (via its Redis heartbeat). Returns HTTP 200 even when degraded —
  // a supervisor watching the API must not restart the API because the
  // WORKER is down; monitors should alert on the status field instead.
  app.get('/api/health', async () => {
    const heartbeatAgeMs = await workerHeartbeatAgeMs().catch(() => null);
    const workerAlive = heartbeatAgeMs !== null && heartbeatAgeMs < 60_000;
    return {
      status: workerAlive ? 'ok' : 'degraded',
      adapter: config.VENDOR_ADAPTER,
      worker: { alive: workerAlive, lastHeartbeatMsAgo: heartbeatAgeMs },
    };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(vendorRoutes, { prefix: '/api' });
  await app.register(groupRoutes, { prefix: '/api' });
  await app.register(paymentRoutes, { prefix: '/api' });
  await app.register(realtimeRoutes, { prefix: '/api' });

  realtime.start();
  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(`Server listening on http://${config.HOST}:${config.PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info('Shutting down…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only auto-start when run directly (not when imported by tests).
// Use pathToFileURL for the comparison: naive `file://${argv[1]}` string
// concatenation never matches on Windows (drive letters and backslashes need
// percent-encoding into file:///C:/... form), so `node dist/server.js` would
// silently exit without ever listening. The extension test covers tsx dev
// runs, where argv[1] can be reported differently.
const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl || /[\\/]server\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main();
}
