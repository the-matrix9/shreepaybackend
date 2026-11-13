import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { verifyPayment } from './paymentService';

/**
 * Automatic payment verification (no button needed).
 *
 *  1. kickAutoVerify(ref): called when the customer's payment page polls /verify/<ref>. Verifies that one
 *     order right away, so the merchant is credited within a second or two of the customer paying.
 *  2. startAutoVerify(): background poller that re-checks recent PENDING orders every few seconds, so the
 *     merchant is credited even if the customer closes the page right after paying.
 *
 * Both go through paymentService.verifyPayment, which already guarantees exactly-once crediting
 * (compare-and-set on the order status + unique constraints), so running them concurrently, or on several
 * instances, can never credit twice.
 */

async function checkOrder(o: { userId: string; orderId: string }) {
  try {
    await verifyPayment({ userId: o.userId, orderId: o.orderId });
  } catch (err) {
    // Upstream down / amount mismatch / duplicate UTR etc. are already recorded by verifyPayment where relevant.
    logger.warn({ orderId: o.orderId, err: (err as Error).message }, 'auto-verify check failed');
  }
}

/* ---------- 1. instant check when the customer's page polls ---------- */
const lastKick = new Map<string, number>();
const KICK_MIN_GAP_MS = 3_000;

export async function kickAutoVerify(upstreamOrderId: string) {
  if (!env.AUTO_VERIFY) return;
  const now = Date.now();
  if (now - (lastKick.get(upstreamOrderId) ?? 0) < KICK_MIN_GAP_MS) return; // throttle per order
  lastKick.set(upstreamOrderId, now);
  if (lastKick.size > 20_000) for (const [k, t] of lastKick) if (now - t > 60_000) lastKick.delete(k);

  const order = await prisma.paymentOrder.findUnique({
    where: { upstreamOrderId },
    select: { userId: true, orderId: true, status: true },
  });
  if (order && order.status === 'PENDING') await checkOrder(order);
}

/* ---------- 2. background poller ---------- */
let running = false;

async function tick() {
  if (running) return; // never overlap with a slow previous run
  running = true;
  try {
    const since = new Date(Date.now() - env.AUTO_VERIFY_WINDOW_MIN * 60_000);
    const orders = await prisma.paymentOrder.findMany({
      where: { status: 'PENDING', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' }, // newest first: those are the ones being paid right now
      take: env.AUTO_VERIFY_BATCH,
      select: { userId: true, orderId: true },
    });
    // Small worker pool so we don't hammer the upstream.
    let i = 0;
    const worker = async () => {
      while (i < orders.length) await checkOrder(orders[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(env.AUTO_VERIFY_CONCURRENCY, orders.length) }, worker));
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'auto-verify tick failed');
  } finally {
    running = false;
  }
}

export function startAutoVerify(): NodeJS.Timeout | undefined {
  if (!env.AUTO_VERIFY) return undefined;
  const t = setInterval(() => void tick(), env.AUTO_VERIFY_INTERVAL_SEC * 1000);
  t.unref();
  logger.info({ everySec: env.AUTO_VERIFY_INTERVAL_SEC, windowMin: env.AUTO_VERIFY_WINDOW_MIN }, 'auto-verify enabled');
  return t;
}
