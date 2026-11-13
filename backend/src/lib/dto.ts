import type { PaymentOrder, Transaction, Withdrawal, Wallet, LedgerEntry } from '@prisma/client';
import { paiseToNumber, paiseToRupeesNumber } from './money';

const money = (p: bigint) => ({ amount: paiseToRupeesNumber(p), amountPaise: paiseToNumber(p) });

export const orderDto = (o: PaymentOrder) => ({
  orderId: o.orderId,
  ...money(o.amount),
  currency: o.currency,
  status: o.status,
  paymentUrl: o.paymentUrl,
  createdAt: o.createdAt,
  expiresAt: o.expiresAt,
  verifiedAt: o.verifiedAt,
});

export const txDto = (t: Transaction & { order?: { orderId: string } | null }) => ({
  id: t.id,
  orderId: t.order?.orderId,
  externalTransactionId: t.externalTransactionId,
  ...money(t.amount),
  currency: t.currency,
  status: t.status,
  upstreamStatus: t.upstreamStatus,
  verifiedAt: t.verifiedAt,
  createdAt: t.createdAt,
});

export const withdrawalDto = (w: Withdrawal) => ({
  id: w.id,
  ...money(w.amount),
  upiId: w.upiIdSnapshot,
  status: w.status,
  adminNote: w.adminNote,
  requestedAt: w.requestedAt,
  processedAt: w.processedAt,
  paidAt: w.paidAt,
  rejectedAt: w.rejectedAt,
  cancelledAt: w.cancelledAt,
});

export const walletDto = (w: Wallet | null) => {
  const z = { available: 0n, reserved: 0n, totalReceived: 0n, totalWithdrawn: 0n };
  const x = w ?? z;
  return {
    available: paiseToRupeesNumber(x.available),
    reserved: paiseToRupeesNumber(x.reserved),
    totalReceived: paiseToRupeesNumber(x.totalReceived),
    totalWithdrawn: paiseToRupeesNumber(x.totalWithdrawn),
    currency: 'INR',
  };
};

export const ledgerDto = (l: LedgerEntry) => ({
  id: l.id,
  type: l.type,
  ...money(l.amount),
  balanceAfter: paiseToRupeesNumber(l.balanceAfter),
  description: l.description,
  createdAt: l.createdAt,
});
