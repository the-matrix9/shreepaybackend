import { Prisma, PaymentOrder, Transaction } from '@prisma/client';
import { env, paymentBaseUrl } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { newUpstreamOrderId } from '../lib/crypto';
import * as famPay from './famPayService';
import * as wallet from './walletService';
import { ReqCtx, securityEvent } from './auditService';

const isUnique = (e: unknown, field?: string) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  e.code === 'P2002' &&
  (!field || JSON.stringify(e.meta?.target ?? '').includes(field));

// Customers only ever see ShreePay's own domain; the upstream host never leaves the backend.
const publicPaymentUrl = (upstreamOrderId: string) => `${paymentBaseUrl}/pay/${upstreamOrderId}`;

export async function createPayment(p: { userId: string; orderId: string; amountPaise: bigint; ctx?: ReqCtx }) {
  if (p.amountPaise <= 0n || p.amountPaise > BigInt(env.MAX_PAYMENT_AMOUNT) * 100n) {
    throw new AppError(400, 'INVALID_AMOUNT', `Amount must be between 0.01 and ${env.MAX_PAYMENT_AMOUNT}`);
  }

  const existing = await prisma.paymentOrder.findUnique({ where: { userId_orderId: { userId: p.userId, orderId: p.orderId } } });
  if (existing) return replayExisting(existing, p.amountPaise);

  const upstreamOrderId = newUpstreamOrderId();
  let order: PaymentOrder;
  try {
    // Insert first: the unique(userId, orderId) constraint makes concurrent creates safe.
    order = await prisma.paymentOrder.create({
      data: {
        userId: p.userId,
        orderId: p.orderId,
        upstreamOrderId,
        amount: p.amountPaise,
        expiresAt: new Date(Date.now() + env.ORDER_EXPIRY_MINUTES * 60_000),
      },
    });
  } catch (e) {
    if (isUnique(e)) {
      const again = await prisma.paymentOrder.findUnique({ where: { userId_orderId: { userId: p.userId, orderId: p.orderId } } });
      if (again) return replayExisting(again, p.amountPaise);
    }
    throw e;
  }

  try {
    const up = await famPay.generatePayment(upstreamOrderId, p.amountPaise);
    order = await prisma.paymentOrder.update({
      where: { id: order.id },
      data: {
        paymentUrl: publicPaymentUrl(upstreamOrderId),
        upstreamResponse: { status: up.rawStatus, raw: (up.raw ?? null) as Prisma.InputJsonValue },
      },
    });
  } catch (err) {
    await prisma.paymentOrder.delete({ where: { id: order.id } }).catch(() => undefined); // nothing was issued
    throw err;
  }
  await securityEvent(p.userId, 'PAYMENT_CREATED', p.ctx, { orderId: p.orderId, amountPaise: Number(p.amountPaise) });
  return { order, created: true };
}

function replayExisting(o: PaymentOrder, amountPaise: bigint) {
  // Same reference + same amount while still usable: return the same link. Otherwise refuse.
  if (o.amount === amountPaise && o.paymentUrl && o.status === 'PENDING') return { order: o, created: false };
  throw conflict('An order with this orderId already exists', 'ORDER_EXISTS');
}

export async function getOrder(userId: string, orderId: string) {
  const order = await prisma.paymentOrder.findUnique({
    where: { userId_orderId: { userId, orderId } },
    include: { transaction: { include: { order: { select: { orderId: true } } } } },
  });
  if (!order) throw notFound('Order not found', 'ORDER_NOT_FOUND');
  return order;
}

export async function verifyPayment(p: { userId: string; orderId: string; ctx?: ReqCtx }) {
  // 1. Ownership: lookup is ALWAYS by (userId, orderId), never by orderId alone.
  const order = await prisma.paymentOrder.findUnique({ where: { userId_orderId: { userId: p.userId, orderId: p.orderId } } });
  if (!order) {
    // If the caller supplied another merchant's internal reference, say so (and record it).
    const foreign = await prisma.paymentOrder.findFirst({
      where: { upstreamOrderId: p.orderId, NOT: { userId: p.userId } },
      select: { id: true },
    });
    if (foreign) {
      await securityEvent(p.userId, 'ORDER_ACCESS_DENIED', p.ctx, { attempted: p.orderId.slice(0, 40) });
      throw forbidden('This order does not belong to you', 'ORDER_ACCESS_DENIED');
    }
    throw notFound('Order not found', 'ORDER_NOT_FOUND');
  }

  // 2. Already credited: return the existing transaction, no upstream call, no second credit.
  if (order.status === 'VERIFIED') return finish(order.id, true);

  // 3. Ask upstream (network I/O happens outside any DB transaction).
  const up = await famPay.verifyPayment(order.upstreamOrderId);

  if (up.status !== 'VERIFIED') {
    const next = up.status === 'FAILED' ? 'FAILED' : up.status === 'EXPIRED' ? 'EXPIRED' : null;
    if (next && next !== order.status) {
      await prisma.paymentOrder.updateMany({ where: { id: order.id, status: { not: 'VERIFIED' } }, data: { status: next } });
    }
    return finish(order.id, false);
  }

  // 4. Amount check against OUR stored amount (never client input).
  if (up.amountPaise === null && env.UPSTREAM_REQUIRE_AMOUNT) {
    await securityEvent(p.userId, 'UPSTREAM_AMOUNT_MISSING', p.ctx, { orderId: p.orderId });
    throw new AppError(502, 'UPSTREAM_AMOUNT_MISSING', 'Payment confirmed upstream but amount could not be validated; not credited');
  }
  if (up.amountPaise !== null && up.amountPaise !== order.amount) {
    await prisma.paymentOrder.updateMany({ where: { id: order.id, status: { not: 'VERIFIED' } }, data: { status: 'FAILED' } });
    await securityEvent(p.userId, 'AMOUNT_MISMATCH', p.ctx, {
      orderId: p.orderId,
      expectedPaise: Number(order.amount),
      upstreamPaise: Number(up.amountPaise),
    });
    throw conflict('Paid amount does not match the order amount; not credited', 'AMOUNT_MISMATCH');
  }

  // 5. Atomic credit. The compare-and-set on status makes the credit happen exactly once, even
  //    for concurrent verify calls; unique constraints on Transaction/LedgerEntry back it up.
  try {
    await prisma.$transaction(async (tx) => {
      const won = await tx.paymentOrder.updateMany({
        where: { id: order.id, userId: p.userId, status: { not: 'VERIFIED' } },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      });
      if (won.count === 0) return; // another request already credited it
      const t = await tx.transaction.create({
        data: {
          userId: p.userId,
          paymentOrderId: order.id,
          externalTransactionId: up.externalTransactionId,
          amount: order.amount,
          status: 'VERIFIED',
          upstreamStatus: up.rawStatus,
          verifiedAt: new Date(),
          metadata: { upstreamVerifiedAt: up.verifiedAt } as Prisma.InputJsonValue,
        },
      });
      await wallet.credit(tx, { userId: p.userId, transactionId: t.id, amount: order.amount, description: `Payment received for order ${order.orderId}` });
    });
  } catch (e) {
    if (isUnique(e, 'externalTransactionId')) {
      await securityEvent(p.userId, 'DUPLICATE_UPSTREAM_TRANSACTION', p.ctx, { orderId: p.orderId });
      throw conflict('This payment reference was already used for another order', 'DUPLICATE_TRANSACTION');
    }
    if (!isUnique(e)) throw e; // unique(userId, paymentOrderId) race: fall through and return the existing one
  }
  await securityEvent(p.userId, 'PAYMENT_VERIFIED', p.ctx, { orderId: p.orderId });
  return finish(order.id, true);
}

async function finish(orderPk: string, expectVerified: boolean) {
  const order = await prisma.paymentOrder.findUniqueOrThrow({
    where: { id: orderPk },
    include: { transaction: true },
  });
  return { order, transaction: (order.transaction as Transaction | null) ?? null, verified: expectVerified && order.status === 'VERIFIED' };
}
