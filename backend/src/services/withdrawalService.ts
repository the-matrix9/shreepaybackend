import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import * as wallet from './walletService';
import { adminAction, ReqCtx, securityEvent } from './auditService';
import { getMinWithdrawalPaise } from './settingsService';
import { paiseToRupeesString } from '../lib/money';

/** Merchant requests a withdrawal: reserve balance atomically. No money moves automatically. */
export async function requestWithdrawal(p: { userId: string; amountPaise: bigint; upiId: string; ctx?: ReqCtx }) {
  const min = await getMinWithdrawalPaise();
  if (p.amountPaise <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive');
  if (p.amountPaise < min) {
    throw new AppError(400, 'BELOW_MINIMUM', `Minimum withdrawal is ₹${paiseToRupeesString(min)}`);
  }

  const w = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: p.userId }, include: { profile: true } });
    if (user.status !== 'ACTIVE') throw forbidden('Account is not active', 'ACCOUNT_INACTIVE');

    const saved = user.profile?.upiId;
    if (!saved) throw new AppError(400, 'UPI_REQUIRED', 'Save your UPI ID in Settings before withdrawing');
    // Payout destination must equal the saved UPI (limits damage if a session is hijacked)
    if (saved.toLowerCase() !== p.upiId.toLowerCase()) {
      throw new AppError(400, 'UPI_MISMATCH', 'UPI ID differs from the one saved in Settings');
    }
    const cooldownMs = env.UPI_CHANGE_COOLDOWN_HOURS * 3_600_000;
    if (user.profile?.upiUpdatedAt && Date.now() - user.profile.upiUpdatedAt.getTime() < cooldownMs) {
      throw new AppError(400, 'UPI_RECENTLY_CHANGED', `Withdrawals are paused for ${env.UPI_CHANGE_COOLDOWN_HOURS}h after changing your UPI ID`);
    }

    const created = await tx.withdrawal.create({
      data: { userId: p.userId, amount: p.amountPaise, upiIdSnapshot: saved },
    });
    await wallet.reserve(tx, { userId: p.userId, withdrawalId: created.id, amount: p.amountPaise });
    return created;
  });
  await securityEvent(p.userId, 'WITHDRAWAL_REQUESTED', p.ctx, { withdrawalId: w.id, amountPaise: Number(w.amount) });
  return w;
}

export async function cancelWithdrawal(p: { userId: string; id: string; ctx?: ReqCtx }) {
  const w = await prisma.$transaction(async (tx) => {
    const found = await tx.withdrawal.findFirst({ where: { id: p.id, userId: p.userId } });
    if (!found) throw notFound('Withdrawal not found');
    const r = await tx.withdrawal.updateMany({
      where: { id: p.id, userId: p.userId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    if (r.count !== 1) throw conflict('Only pending withdrawals can be cancelled', 'INVALID_STATE');
    await wallet.release(tx, { userId: p.userId, withdrawalId: p.id, amount: found.amount, reason: 'Withdrawal cancelled by merchant: balance released' });
    return tx.withdrawal.findUniqueOrThrow({ where: { id: p.id } });
  });
  await securityEvent(p.userId, 'WITHDRAWAL_CANCELLED', p.ctx, { withdrawalId: p.id });
  return w;
}

/* ---------------- admin actions (state machine: PENDING -> PROCESSING -> PAID, or -> REJECTED) ---------------- */

export async function adminApprove(adminId: string, id: string, note?: string) {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawal.findUnique({ where: { id } });
    if (!w) throw notFound('Withdrawal not found');
    const r = await tx.withdrawal.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PROCESSING', processedAt: new Date(), adminId, adminNote: note ?? null },
    });
    if (r.count !== 1) throw conflict('Withdrawal is not pending', 'INVALID_STATE');
    await adminAction(adminId, w.userId, 'WITHDRAWAL_APPROVED', { withdrawalId: id, amountPaise: Number(w.amount) }, tx);
    return tx.withdrawal.findUniqueOrThrow({ where: { id } });
  });
}

export async function adminReject(adminId: string, id: string, note: string) {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawal.findUnique({ where: { id } });
    if (!w) throw notFound('Withdrawal not found');
    const r = await tx.withdrawal.updateMany({
      where: { id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'REJECTED', rejectedAt: new Date(), adminId, adminNote: note },
    });
    if (r.count !== 1) throw conflict('Withdrawal can no longer be rejected', 'INVALID_STATE');
    await wallet.release(tx, { userId: w.userId, withdrawalId: id, amount: w.amount, reason: 'Withdrawal rejected: balance released' });
    await adminAction(adminId, w.userId, 'WITHDRAWAL_REJECTED', { withdrawalId: id, amountPaise: Number(w.amount) }, tx);
    return tx.withdrawal.findUniqueOrThrow({ where: { id } });
  });
}

/** Admin confirms they transferred the money MANUALLY. The system never moves money itself. */
export async function adminMarkPaid(adminId: string, id: string, note?: string) {
  return prisma.$transaction(async (tx) => {
    const w = await tx.withdrawal.findUnique({ where: { id } });
    if (!w) throw notFound('Withdrawal not found');
    const r = await tx.withdrawal.updateMany({
      where: { id, status: 'PROCESSING' },
      data: { status: 'PAID', paidAt: new Date(), adminId, ...(note ? { adminNote: note } : {}) },
    });
    if (r.count !== 1) throw conflict('Only approved (PROCESSING) withdrawals can be marked paid', 'INVALID_STATE');
    await wallet.settlePaid(tx, { userId: w.userId, withdrawalId: id, amount: w.amount });
    await adminAction(adminId, w.userId, 'WITHDRAWAL_PAID', { withdrawalId: id, amountPaise: Number(w.amount), upi: w.upiIdSnapshot }, tx);
    return tx.withdrawal.findUniqueOrThrow({ where: { id } });
  });
}
