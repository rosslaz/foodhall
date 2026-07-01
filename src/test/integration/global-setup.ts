import { execSync } from 'node:child_process';

// Global setup (runs once, in its own process): create/sync the TEST database
// schema with `prisma db push`. db push creates the database if missing and
// syncs it to schema.prisma without touching migration history.
//
// NOTE: the partial unique index from S9 lives only in migration SQL, so it
// is NOT present in the test database — no test depends on it (the in-app
// guards are what's under test; the index is the production backstop).
export default function globalSetup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://foodhall:foodhall@localhost:5432/foodhall_test?schema=public';
  try {
    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    });
  } catch (err) {
    // The most common failure is simply that docker compose isn't up.
    console.error(
      '\nIntegration test setup failed. Is Postgres running? (docker compose up -d)\n',
    );
    throw err;
  }
}
