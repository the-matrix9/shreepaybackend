import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler = (_req: Request, res: Response) =>
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request', details } });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });

  // Anything else is a bug: log server-side with context, return a generic message (no stack, no internals).
  logger.error(
    { err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err), prismaCode: err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined, path: req.path },
    'unhandled error',
  );
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
}
