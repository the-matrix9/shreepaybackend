import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sha256 } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Idempotency-Key support. Same key + same request => the original response is replayed.
 * Same key + different request => 422. Server errors (5xx) are not stored so the client can retry.
 */
export const idempotent = (endpoint: string) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const key = req.header('Idempotency-Key');
    if (!key) return next();
    if (!KEY_RE.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 chars: letters, digits, _ . : -');
    const userId = req.user!.id;
    const requestHash = sha256(endpoint + JSON.stringify(req.body ?? {}));

    const existing = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
    if (existing) return replay(existing, endpoint, requestHash, res);

    try {
      await prisma.idempotencyKey.create({ data: { userId, key, endpoint, requestHash } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
        if (again) return replay(again, endpoint, requestHash, res);
      }
      throw e;
    }

    const original = res.json.bind(res);
    res.json = ((body: unknown) => {
      const done =
        res.statusCode >= 500
          ? prisma.idempotencyKey.delete({ where: { userId_key: { userId, key } } })
          : prisma.idempotencyKey.update({
              where: { userId_key: { userId, key } },
              data: { response: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue, statusCode: res.statusCode },
            });
      done.catch((err) => logger.error({ err: (err as Error).message }, 'idempotency persist failed')).finally(() => original(body));
      return res;
    }) as Response['json'];
    next();
  } catch (e) {
    next(e);
  }
};

function replay(
  rec: { endpoint: string; requestHash: string; statusCode: number | null; response: unknown },
  endpoint: string,
  requestHash: string,
  res: Response,
) {
  if (rec.endpoint !== endpoint || rec.requestHash !== requestHash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used with a different request');
  }
  if (rec.statusCode === null) throw new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still processing');
  res.setHeader('Idempotent-Replayed', 'true');
  return res.status(rec.statusCode).json(rec.response);
}
