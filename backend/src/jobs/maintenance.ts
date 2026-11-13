import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const LOCK_ID = 727001;
const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Periodic housekeeping. A transaction-scoped Postgres advisory lock makes sure only ONE instance does
 * the work per tick when several backends run side by side (and works through pooled connections).
 */
export async function runMaintenance() {
  const result = await prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_ID}) AS locked`;
      if (!locked) return null;
      const now = new Date();
      return {
        expiredOrders: (await tx.paymentOrder.updateMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, data: { status: 'EXPIRED' } })).count,
        sessions: (await tx.session.deleteMany({ where: { expiresAt: { lt: now } } })).count,
        idempotency: (await tx.idempotencyKey.deleteMany({ where: { createdAt: { lt: ago(DAY) } } })).count,
        resets: (await tx.passwordReset.deleteMany({ where: { expiresAt: { lt: ago(DAY) } } })).count,
        otps: (await tx.emailOtp.deleteMany({ where: { expiresAt: { lt: ago(DAY) } } })).count,
        apiLogs: (await tx.apiRequestLog.deleteMany({ where: { createdAt: { lt: ago(90 * DAY) } } })).count,
        // Signups that never verified their email (they can't hold keys, balances or orders).
        unverifiedUsers: (await tx.user.deleteMany({ where: { role: 'USER', emailVerified: false, createdAt: { lt: ago(DAY) } } })).count,
      };
    },
    { timeout: 60_000, maxWait: 5_000 },
  );
  if (result) logger.info(result, 'maintenance done');
}

export function startMaintenance(intervalMs = 10 * 60_000) {
  const tick = () => runMaintenance().catch((err) => logger.error({ err: (err as Error).message }, 'maintenance failed'));
  void tick();
  const t = setInterval(tick, intervalMs);
  t.unref();
  return t;
}
