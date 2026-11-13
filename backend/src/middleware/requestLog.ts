import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hmac } from '../lib/crypto';
import { logger } from '../lib/logger';

/**
 * API usage logging is buffered and written in batches (one INSERT per ~2s instead of one per request),
 * so logging stays cheap at high request volume. The buffer is capped: under extreme load the oldest
 * usage rows are dropped before request handling is ever slowed down.
 */
const MAX_BUFFER = 20_000;
const FLUSH_AT = 500;
let buffer: Prisma.ApiRequestLogCreateManyInput[] = [];
let flushing = false;

export async function flushApiLogs() {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    await prisma.apiRequestLog.createMany({ data: batch });
  } catch (err) {
    logger.error({ err: (err as Error).message, dropped: batch.length }, 'api log flush failed');
  } finally {
    flushing = false;
  }
}

export function startApiLogFlusher(intervalMs = 2000) {
  const t = setInterval(() => void flushApiLogs(), intervalMs);
  t.unref();
  return t;
}

/** Records authenticated API calls for the usage page / admin API logs. Uses the route pattern, never raw ids/keys. */
export function apiRequestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.user) return;
    if (buffer.length >= MAX_BUFFER) return;
    buffer.push({
      userId: req.user.id,
      apiKeyId: req.apiKeyId ?? null,
      endpoint: `${req.baseUrl}${req.route?.path ?? ''}`.slice(0, 200),
      method: req.method,
      statusCode: res.statusCode,
      responseTime: Date.now() - start,
      ipHash: hmac(req.ip ?? 'unknown'),
    });
    if (buffer.length >= FLUSH_AT) void flushApiLogs();
  });
  next();
}
