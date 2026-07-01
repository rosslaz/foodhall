import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  VENDOR_ADAPTER: z.enum(['mock', 'gotab']).default('mock'),
  GOTAB_API_BASE: z.string().url().optional(),
  // GoTab's OAuth token endpoint (JSON-body POST, not the form-encoded
  // grant_type=client_credentials standard — see project doc "Auth"). Defaults
  // to the known sandbox/prod host; override per environment if needed.
  GOTAB_OAUTH_URL: z.string().url().default('https://gotab.io/api/oauth/token'),
  GOTAB_GRAPH_URL: z.string().url().default('https://gotab.io/api/v2/graph'),
  // Real GoTab credential field names (Client Credentials flow). The adapter
  // reads these; GOTAB_API_KEY/SECRET below are the legacy placeholder names,
  // kept optional so existing .env files don't break. Prefer the ACCESS_* names.
  GOTAB_API_ACCESS_ID: z.string().optional(),
  GOTAB_API_ACCESS_SECRET: z.string().optional(),
  GOTAB_API_KEY: z.string().optional(),
  GOTAB_API_SECRET: z.string().optional(),
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
