import { defineConfig } from 'vitest/config';

// Unit tests only — fast, no infrastructure. Integration tests (src/test/)
// need Postgres + Redis and run via `npm run test:int` (vitest.int.config.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/test/**'],
  },
});
