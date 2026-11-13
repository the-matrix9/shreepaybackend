import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, Tx } from '../lib/prisma';
import { hmac } from '../lib/crypto';
import { logger } from '../lib/logger';

export interface ReqCtx {
  ipHash: string;
  uaHash: string;
}

export const reqCtx = (req: Request): ReqCtx => ({
  ipHash: hmac(req.ip ?? 'unknown'),
  uaHash: hmac(String(req.headers['user-agent'] ?? '').slice(0, 300)),
});

/** Security / audit event for a user. Never pass secrets in metadata. */
export async function securityEvent(
  userId: string | null,
  eventType: string,
  ctx?: ReqCtx,
  metadata?: Prisma.InputJsonValue,
  client: Tx = prisma,
) {
  try {
    await client.securityEvent.create({
      data: { userId, eventType, ipHash: ctx?.ipHash, userAgentHash: ctx?.uaHash, metadata },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, eventType }, 'failed to write security event');
  }
}

/** Admin action log. Uses the caller's transaction so the log commits atomically with the action. */
export async function adminAction(
  adminId: string,
  targetUserId: string | null,
  action: string,
  metadata?: Prisma.InputJsonValue,
  client: Tx = prisma,
) {
  await client.adminActionLog.create({ data: { adminId, targetUserId, action, metadata } });
}
