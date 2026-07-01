// Runs BEFORE each test file's imports (vitest setupFiles), so config/db/redis
// modules — which read process.env at import time — see the TEST values.
//
// Defaults target the docker-compose dev infra with a separate database and a
// separate Redis logical db (1), so dev data and the dev worker's queues are
// never touched. Override with TEST_DATABASE_URL / TEST_REDIS_URL.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://foodhall:foodhall@localhost:5432/foodhall_test?schema=public';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'integration-test-secret-0123456789';
process.env.VENDOR_ADAPTER = 'mock';
process.env.PAYMENT_TIMEOUT_SECONDS = process.env.PAYMENT_TIMEOUT_SECONDS ?? '300';
process.env.GROUP_OPEN_EXPIRY_HOURS = process.env.GROUP_OPEN_EXPIRY_HOURS ?? '6';
