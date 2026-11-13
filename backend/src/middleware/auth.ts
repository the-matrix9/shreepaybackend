import type { NextFunction, Request, Response } from 'express';
import type { User } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { API_KEY_RE, sha256 } from '../lib/crypto';
import { forbidden, unauthorized } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { reqCtx, securityEvent } from '../services/auditService';
import { resolveSession, SESSION_COOKIE } from '../services/authService';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      apiKeyId?: string;
      authType?: 'session' | 'apikey';
      sessionToken?: string;
      startedAt?: number;
    }
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : '';
}

/** API-key auth: extract -> validate format -> hash -> lookup -> key status -> merchant status -> touch lastUsedAt. */
export const authenticateApiKey = asyncHandler(async (req, _res, next) => {
  const token = bearer(req);
  if (!token || !API_KEY_RE.test(token)) throw unauthorized('Invalid or missing API key', 'INVALID_API_KEY');
  const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(token) }, include: { user: true } });
  if (!key) {
    await securityEvent(null, 'INVALID_API_KEY_ATTEMPT', reqCtx(req), { prefix: token.slice(0, 11) });
    throw unauthorized('Invalid or missing API key', 'INVALID_API_KEY');
  }
  if (key.status !== 'ACTIVE') throw unauthorized('This API key has been revoked', 'API_KEY_REVOKED');
  if (key.user.status !== 'ACTIVE') throw forbidden('Account is not active', 'ACCOUNT_SUSPENDED');
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }); // throttled: 1 write/min/key
  }
  req.user = key.user;
  req.apiKeyId = key.id;
  req.authType = 'apikey';
  next();
});

export const authenticateSession = asyncHandler(async (req, _res, next) => {
  const token = req.signedCookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized();
  const s = await resolveSession(token);
  if (!s) throw unauthorized('Session expired', 'SESSION_EXPIRED');
  if (s.user.status !== 'ACTIVE') throw forbidden('Account is not active', 'ACCOUNT_SUSPENDED');
  req.user = s.user;
  req.authType = 'session';
  req.sessionToken = token;
  next();
});

/** Bearer sk_live_... => API key auth; otherwise cookie session. */
export function authenticateAny(req: Request, res: Response, next: NextFunction) {
  return req.headers.authorization ? authenticateApiKey(req, res, next) : authenticateSession(req, res, next);
}

/** Endpoints that must never be reachable with an API key (key management, profile, withdrawals). */
export function requireSession(req: Request, _res: Response, next: NextFunction) {
  if (req.authType !== 'session') return next(forbidden('This endpoint requires a dashboard login', 'SESSION_REQUIRED'));
  next();
}

export function requireMerchant(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'USER') return next(forbidden('Merchant account required', 'MERCHANT_ONLY'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') {
    void securityEvent(req.user?.id ?? null, 'ADMIN_ACCESS_DENIED', reqCtx(req), { path: req.path.slice(0, 100) });
    return next(forbidden('Admin access required', 'ADMIN_ONLY'));
  }
  next();
}
