import cors from 'cors';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { env, isProd } from '../config/env';

const allowedOrigins = new Set([new URL(env.FRONTEND_URL).origin]);

// Pure JSON API: no content is ever rendered from here, so the CSP is as strict as possible.
export const securityHeaders = helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
  frameguard: { action: 'deny' },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  crossOriginResourcePolicy: { policy: 'same-site' },
});

// Allowlist only (never "*"). Requests without an Origin (server-to-server API-key calls) are not CORS requests.
export const corsMiddleware = cors({
  origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  maxAge: 600,
});

/**
 * CSRF defense for cookie-authenticated requests: SameSite=Lax cookie PLUS a strict Origin check on
 * every state-changing request. Bearer-key requests carry no ambient credentials, so they are exempt.
 */
export function csrfOriginCheck(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.authorization) return next();
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
  if (origin && allowedOrigins.has(origin)) return next();
  res.status(403).json({ success: false, error: { code: 'CSRF_BLOCKED', message: 'Cross-site request blocked' } });
}

function safeOrigin(u: string) {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}
