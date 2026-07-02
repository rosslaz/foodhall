import { z } from 'zod';

// A present-but-blank line in .env (e.g. `GOTAB_API_KEY=` straight from the
// template) arrives as '' — which is NOT nullish, so it silently defeats `??`
// fallbacks and truthiness checks downstream ('' shadowed populated legacy
// credential names, and made getImportAdapter() think creds were absent).
// Coerce blank to undefined BEFORE validation so "blank" and "unset" are the
// same thing everywhere. Also applied to the URL fields: a blank value would
// otherwise fail .url() and kill boot, instead of falling back to the default.
const blankToUndef = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;
const optionalString = z.preprocess(blankToUndef, z.string().optional());
const optionalUrl = z.preprocess(blankToUndef, z.string().url().optional());
const urlWithDefault = (def: string) =>
  z.preprocess(blankToUndef, z.string().url().default(def));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  VENDOR_ADAPTER: z.enum(['mock', 'gotab']).default('mock'),
  GOTAB_API_BASE: optionalUrl,
  // GoTab's OAuth token endpoint (JSON-body POST, not the form-encoded
  // grant_type=client_credentials standard — see project doc "Auth"). Defaults
  // to the known sandbox/prod host; override per environment if needed.
  GOTAB_OAUTH_URL: urlWithDefault('https://gotab.io/api/oauth/token'),
  GOTAB_GRAPH_URL: urlWithDefault('https://gotab.io/api/v2/graph'),
  // Real GoTab credential field names (Client Credentials flow). The adapter
  // reads these; GOTAB_API_KEY/SECRET below are the legacy placeholder names,
  // kept optional so existing .env files don't break. Prefer the ACCESS_* names.
  GOTAB_API_ACCESS_ID: optionalString,
  GOTAB_API_ACCESS_SECRET: optionalString,
  GOTAB_API_KEY: optionalString,
  GOTAB_API_SECRET: optionalString,
  GROUP_READY_WINDOW_SECONDS: z.coerce.number().default(120),
  PAYMENT_TIMEOUT_SECONDS: z.coerce.number().default(300),
  // OPEN groups older than this are cancelled by the worker sweep (a group
  // still open after hours is abandoned; expiring it also neutralizes its
  // members' session tokens, since every mutating route gates on status).
  GROUP_OPEN_EXPIRY_HOURS: z.coerce.number().default(6),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
