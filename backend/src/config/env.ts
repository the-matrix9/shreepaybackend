import 'dotenv/config';
import { z } from 'zod';

const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  DATABASE_URL: z.string().min(1),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  BACKEND_URL: z.string().url().default('http://localhost:4000'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  UPSTREAM_PAYMENT_API_URL: z.string().url(),
  UPSTREAM_TIMEOUT_MS: int(10000),
  UPSTREAM_GENERATE_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  UPSTREAM_VERIFY_RETRIES: z.coerce.number().int().min(0).max(3).default(1),

  // JWT_SECRET is reserved. Web auth uses opaque server-side sessions (no JWT in the browser).
  JWT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().min(32),
  COOKIE_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: int(24 * 7),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),

  // Credit only if upstream confirms the paid amount equals the order amount. Set to "false" ONLY if
  // the upstream verify response never includes an amount (then the order amount is trusted).
  UPSTREAM_REQUIRE_AMOUNT: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  UPI_CHANGE_COOLDOWN_HOURS: z.coerce.number().int().min(0).default(24),

  MIN_WITHDRAWAL: int(100), // rupees
  MAX_PAYMENT_AMOUNT: int(500000), // rupees, per order
  ORDER_EXPIRY_MINUTES: int(60 * 24),

  AUTH_RATE_LIMIT: int(10),
  AUTH_RATE_WINDOW_MIN: int(15),
  API_RATE_LIMIT: int(100),
  VERIFY_RATE_LIMIT: int(30),
  ADMIN_RATE_LIMIT: int(60),
  LOGIN_MAX_FAILURES: int(5),
  LOGIN_LOCK_MINUTES: int(15),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(), // defaults to "ShreePay <SMTP_USER>" (Gmail always sends as the logged-in account)

  // Customer-facing payment pages. Use a SEPARATE host in production (e.g. https://pay.example.com
  // pointing at this same backend) so pages that originate upstream never share an origin with the API/session cookie.
  PAYMENT_PAGE_BASE_URL: z.string().url().optional(),
  UPSTREAM_PASSTHROUGH_PREFIXES: z.string().default('/verify/,/static/,/assets/,/_next/,/qr/'),
  PAY_RATE_LIMIT: int(300),

  // Shared store for rate limits when running several instances.
  REDIS_URL: z.string().optional(),

  // Email OTP
  OTP_TTL_MIN: int(10),
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().min(0).default(60),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_HOURLY_LIMIT: int(6),
  OTP_RATE_LIMIT: int(20),

  // Automatic payment verification (replaces the manual "verify" button)
  AUTO_VERIFY: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  AUTO_VERIFY_INTERVAL_SEC: int(5), // how often pending orders are re-checked
  AUTO_VERIFY_WINDOW_MIN: int(10), // only orders newer than this are polled (upstream orders expire in ~2 min)
  AUTO_VERIFY_BATCH: int(100), // max orders checked per tick
  AUTO_VERIFY_CONCURRENCY: int(5), // parallel upstream checks per tick

  // Scale / abuse protection
  HASH_CONCURRENCY: int(4), // max parallel Argon2 operations per process (CPU/memory DoS guard)
  MAX_SESSIONS_PER_USER: int(10),
  ADMIN_ALLOWED_IPS: z.string().optional(), // comma-separated; empty = no IP restriction
});

// Treat blank values (e.g. `ADMIN_PASSWORD=` copied from .env.example) as "not set".
const source = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
const parsed = schema.safeParse(source);
if (!parsed.success) {
  // Print variable names only, never values.
  const names = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  console.error('Invalid environment configuration:\n - ' + names.join('\n - '));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

const strip = (u: string) => u.replace(/\/+$/, '');
export const paymentBaseUrl = strip(env.PAYMENT_PAGE_BASE_URL ?? env.BACKEND_URL);
export const paymentHostname = new URL(paymentBaseUrl).hostname;
export const apiHostname = new URL(env.BACKEND_URL).hostname;
export const splitPaymentHost = paymentHostname !== apiHostname;
