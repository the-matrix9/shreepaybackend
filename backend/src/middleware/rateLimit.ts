import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { redis } from '../lib/redis';

/**
 * With REDIS_URL set, counters are shared by every backend instance (required when running more than one).
 * Without it the in-memory store is used: fine for a single instance. If Redis is unreachable the limiter
 * fails open (passOnStoreError) rather than taking the whole API down.
 */
const store = (prefix: string) =>
  redis ? new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as Promise<never> }) : undefined;

const handler = (_req: Request, res: Response) =>
  res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });

const base = { standardHeaders: true, legacyHeaders: false, handler, passOnStoreError: true } as const;
const byPrincipal = (req: Request) => req.apiKeyId ?? req.user?.id ?? req.ip ?? 'unknown';

/** login / register / forgot / reset: per IP (default 10 per 15 min) */
export const authLimiter = rateLimit({ ...base, store: store('auth'), windowMs: env.AUTH_RATE_WINDOW_MIN * 60_000, limit: env.AUTH_RATE_LIMIT });

/** OTP verify / resend: per IP, on top of the per-account attempt limits stored in the database. */
export const otpLimiter = rateLimit({ ...base, store: store('otp'), windowMs: env.AUTH_RATE_WINDOW_MIN * 60_000, limit: env.OTP_RATE_LIMIT });

/** Pre-auth IP guard so invalid-key brute forcing is throttled too. */
export const apiIpLimiter = rateLimit({ ...base, store: store('apiip'), windowMs: 60_000, limit: env.API_RATE_LIMIT * 5 });

/** Payment API: per API key (default 100/min). Runs after authentication. */
export const apiLimiter = rateLimit({ ...base, store: store('api'), windowMs: 60_000, limit: env.API_RATE_LIMIT, keyGenerator: byPrincipal, validate: false });

/** Verification: per API key (default 30/min). */
export const verifyLimiter = rateLimit({ ...base, store: store('verify'), windowMs: 60_000, limit: env.VERIFY_RATE_LIMIT, keyGenerator: byPrincipal, validate: false });

/** Admin: strict. */
export const adminLimiter = rateLimit({ ...base, store: store('admin'), windowMs: 60_000, limit: env.ADMIN_RATE_LIMIT, keyGenerator: byPrincipal, validate: false });

/** Customer payment pages (HTML + assets): per IP. */
export const payLimiter = rateLimit({ ...base, store: store('pay'), windowMs: 60_000, limit: env.PAY_RATE_LIMIT });
