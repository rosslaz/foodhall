import { defineConfig } from 'vitest/config';

// Integration tests (S6): real services against real Postgres + Redis.
// Requires `docker compose up -d`. Uses a SEPARATE foodhall_test database
// (created/synced by global-setup) and Redis db 1 (so BullMQ queues never
// collide with a dev worker on db 0). Run with: npm run test:int
//
// fileParallelism: false — tests truncate shared tables, so files must run
// serially.
export default defineConfig({
  test: {
    include: ['src/test/integration/**/*.int.test.ts'],
    setupFiles: ['src/test/integration/setup-env.ts'],
    globalSetup: ['src/test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
