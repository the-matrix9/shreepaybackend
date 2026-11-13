import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { reqCtx, securityEvent } from '../services/auditService';

const allowed = (env.ADMIN_ALLOWED_IPS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const norm = (ip: string) => ip.replace(/^::ffff:/, '');

/** Optional extra layer: when ADMIN_ALLOWED_IPS is set, /admin/* answers 404 to every other address. */
export function adminIpAllowlist(req: Request, res: Response, next: NextFunction) {
  if (allowed.length === 0) return next();
  if (req.ip && allowed.includes(norm(req.ip))) return next();
  void securityEvent(null, 'ADMIN_IP_BLOCKED', reqCtx(req));
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
}
