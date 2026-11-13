import { Tx } from '../lib/prisma';
import { AppError } from '../lib/errors';

/**
 * Wallet mutations. EVERY function must be called inside prisma.$transaction.
 * Debits use conditional UPDATE ... WHERE balance >= amount, so Postgres row-locks the wallet and
 * a concurrent request can never overdraw (no read-modify-write races, no client-supplied balances).
 * LedgerEntry has unique(transactionId,type) / unique(withdrawalId,type) as a second safety net.
 */

export async function credit(tx: Tx, p: { userId: string; transactionId: string; amount: bigint; description: string }) {
  const w = await tx.wallet.update({
    where: { userId: p.userId },
    data: { available: { increment: p.amount }, totalReceived: { increment: p.amount } },
  });
  await tx.ledgerEntry.create({
    data: { userId: p.userId, transactionId: p.transactionId, type: 'CREDIT', amount: p.amount, balanceAfter: w.available, description: p.description },
  });
}

export async function reserve(tx: Tx, p: { userId: string; withdrawalId: string; amount: bigint }) {
  const r = await tx.wallet.updateMany({
    where: { userId: p.userId, available: { gte: p.amount } },
    data: { available: { decrement: p.amount }, reserved: { increment: p.amount } },
  });
  if (r.count !== 1) throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Amount exceeds available balance');
  const w = await tx.wallet.findUniqueOrThrow({ where: { userId: p.userId } });
  await tx.ledgerEntry.create({
    data: { userId: p.userId, withdrawalId: p.withdrawalId, type: 'RESERVE', amount: p.amount, balanceAfter: w.available, description: 'Withdrawal requested: balance reserved' },
  });
}

export async function release(tx: Tx, p: { userId: string; withdrawalId: string; amount: bigint; reason: string }) {
  const r = await tx.wallet.updateMany({
    where: { userId: p.userId, reserved: { gte: p.amount } },
    data: { reserved: { decrement: p.amount }, available: { increment: p.amount } },
  });
  if (r.count !== 1) throw new AppError(500, 'LEDGER_INCONSISTENT', 'Reserved balance mismatch');
  const w = await tx.wallet.findUniqueOrThrow({ where: { userId: p.userId } });
  await tx.ledgerEntry.create({
    data: { userId: p.userId, withdrawalId: p.withdrawalId, type: 'RELEASE', amount: p.amount, balanceAfter: w.available, description: p.reason },
  });
}

/** Withdrawal marked PAID by an admin after a manual transfer: reserved -> withdrawn. */
export async function settlePaid(tx: Tx, p: { userId: string; withdrawalId: string; amount: bigint }) {
  const r = await tx.wallet.updateMany({
    where: { userId: p.userId, reserved: { gte: p.amount } },
    data: { reserved: { decrement: p.amount }, totalWithdrawn: { increment: p.amount } },
  });
  if (r.count !== 1) throw new AppError(500, 'LEDGER_INCONSISTENT', 'Reserved balance mismatch');
  const w = await tx.wallet.findUniqueOrThrow({ where: { userId: p.userId } });
  await tx.ledgerEntry.create({
    data: { userId: p.userId, withdrawalId: p.withdrawalId, type: 'DEBIT', amount: p.amount, balanceAfter: w.available, description: 'Withdrawal paid manually by admin' },
  });
}
