// Env loader for the gotab conformance suite. vitest has no --env-file, so
// load .env manually (no dotenv dependency in this project — tiny parser,
// existing process.env always wins). Also supplies harmless fallbacks for the
// non-GoTab REQUIRED config fields: the config module validates ALL of them
// at import time and process.exit(1)s on failure — without fallbacks, running
// this suite on a machine with no .env would die before the creds-gated
// skip could even report "skipped".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const raw = readFileSync(join(process.cwd(), '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // No .env — fine; the suite will self-skip on missing creds.
}

// Fallbacks so `config` parses even without a .env (never used for anything —
// this suite touches neither the database nor Redis).
process.env.JWT_SECRET ??= 'gotab-suite-dummy-secret-16chars';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:5432/unused';
process.env.REDIS_URL ??= 'redis://localhost:6379';
