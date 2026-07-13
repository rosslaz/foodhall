import { defineConfig } from 'vitest/config';

// GoTab live-sandbox conformance suite (roadmap 2.7): the REAL GoTabAdapter
// against the REAL sandbox. Creds-gated — the suite self-skips when
// GOTAB_API_ACCESS_ID/SECRET are absent (so CI, which never has creds, shows
// skipped rather than red). Run with: npm run test:gotab
//
// NOT part of `npm run check` on purpose: it needs live creds, live network,
// and strands one $10 open tab in the sandbox per run (settle via the
// dashboard's "Pay with Tender Types" — see project doc).
//
// Timeouts are generous: live HTTP + the client's 280ms pacing gate + a
// status-race retry loop.
export default defineConfig({
  test: {
    include: ['src/test/gotab/**/*.gotab.test.ts'],
    setupFiles: ['src/test/gotab/setup-env.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
