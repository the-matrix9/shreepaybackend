import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, idParam, ok, pageArgs, pageResult } from '../lib/http';
import { AppError, notFound } from '../lib/errors';
import { ledgerDto, txDto, walletDto, withdrawalDto } from '../lib/dto';
import { paiseToRupeesNumber } from '../lib/money';
import { adminApproveBody, adminPaidBody, adminRejectBody, listQuery, settingsBody } from '../validators';
import * as withdrawals from '../services/withdrawalService';
import { adminAction } from '../services/auditService';
import { getSettings, setSetting } from '../services/settingsService';

const dateRange = (q: { from?: Date; to?: Date }) => (q.from || q.to ? { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) } : undefined);

export const dashboard = asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [merchants, active, txAgg, wPending, wPaid, volume, wSeries, growth] = await Promise.all([
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.user.count({ where: { role: 'USER', status: 'ACTIVE' } }),
    prisma.transaction.aggregate({ where: { status: 'VERIFIED' }, _count: true, _sum: { amount: true } }),
    prisma.withdrawal.aggregate({ where: { status: { in: ['PENDING', 'PROCESSING'] } }, _count: true, _sum: { amount: true } }),
    prisma.withdrawal.aggregate({ where: { status: 'PAID' }, _count: true, _sum: { amount: true } }),
    prisma.$queryRaw<{ day: Date; count: number; volume: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', "verifiedAt")::date AS day, count(*)::int AS count, COALESCE(sum(amount),0)::bigint AS volume
      FROM "Transaction" WHERE status = 'VERIFIED' AND "verifiedAt" >= ${since} GROUP BY 1 ORDER BY 1`),
    prisma.$queryRaw<{ day: Date; count: number; amount: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', "paidAt")::date AS day, count(*)::int AS count, COALESCE(sum(amount),0)::bigint AS amount
      FROM "Withdrawal" WHERE status = 'PAID' AND "paidAt" >= ${since} GROUP BY 1 ORDER BY 1`),
    prisma.$queryRaw<{ day: Date; count: number }[]>(Prisma.sql`
      SELECT date_trunc('day', "createdAt")::date AS day, count(*)::int AS count
      FROM "User" WHERE role = 'USER' AND "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`),
  ]);
  ok(res, {
    cards: {
      totalMerchants: merchants,
      activeMerchants: active,
      totalTransactions: txAgg._count,
      totalVolume: paiseToRupeesNumber(txAgg._sum.amount ?? 0n),
      pendingWithdrawals: wPending._count,
      pendingWithdrawalAmount: paiseToRupeesNumber(wPending._sum.amount ?? 0n),
      paidWithdrawals: wPaid._count,
      paidWithdrawalAmount: paiseToRupeesNumber(wPaid._sum.amount ?? 0n),
    },
    charts: {
      paymentVolume: volume.map((r) => ({ day: r.day, count: r.count, volume: paiseToRupeesNumber(r.volume) })),
      withdrawals: wSeries.map((r) => ({ day: r.day, count: r.count, amount: paiseToRupeesNumber(r.amount) })),
      merchantGrowth: growth,
    },
  });
});

export const listMerchants = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.UserWhereInput = { role: 'USER' };
  if (q.q) where.OR = [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }, { profile: { businessName: { contains: q.q, mode: 'insensitive' } } }];
  if (q.status && ['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(q.status)) where.status = q.status as Prisma.UserWhereInput['status'];
  const [rows, total] = await Promise.all([
    prisma.user.findMany({ where, include: { profile: true, wallet: true, _count: { select: { transactions: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.user.count({ where }),
  ]);
  ok(res, pageResult(rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, status: u.status, businessName: u.profile?.businessName, upiId: u.profile?.upiId ?? null,
    balance: walletDto(u.wallet), transactions: u._count.transactions, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
  })), total, q));
});

export const getMerchant = asyncHandler(async (req, res) => {
  const id = idParam(req);
  const u = await prisma.user.findFirst({ where: { id, role: 'USER' }, include: { profile: true, wallet: true } });
  if (!u) throw notFound('Merchant not found');
  const [txs, ws, keys, events, ledger] = await Promise.all([
    prisma.transaction.findMany({ where: { userId: id }, include: { order: { select: { orderId: true } } }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.withdrawal.findMany({ where: { userId: id }, orderBy: { requestedAt: 'desc' }, take: 20 }),
    prisma.apiKey.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.securityEvent.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, eventType: true, metadata: true, createdAt: true } }),
    prisma.ledgerEntry.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  ok(res, {
    profile: { id: u.id, name: u.name, email: u.email, phone: u.phone, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, businessName: u.profile?.businessName, upiId: u.profile?.upiId ?? null, upiVerified: u.profile?.upiVerified ?? false },
    balance: walletDto(u.wallet),
    transactions: txs.map(txDto),
    withdrawals: ws.map(withdrawalDto),
    apiKeys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.keyPrefix, status: k.status, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt })),
    securityEvents: events,
    ledger: ledger.map(ledgerDto),
  });
});

async function setMerchantStatus(adminId: string, id: string, status: 'ACTIVE' | 'SUSPENDED') {
  await prisma.$transaction(async (tx) => {
    const u = await tx.user.findFirst({ where: { id, role: 'USER' } }); // admins can never be suspended through this path
    if (!u) throw notFound('Merchant not found');
    await tx.user.update({ where: { id }, data: { status } });
    if (status === 'SUSPENDED') await tx.session.deleteMany({ where: { userId: id } }); // kick them out now
    await adminAction(adminId, id, status === 'SUSPENDED' ? 'MERCHANT_SUSPENDED' : 'MERCHANT_ACTIVATED', undefined, tx);
  });
}
export const suspend = asyncHandler(async (req, res) => { await setMerchantStatus(req.user!.id, idParam(req), 'SUSPENDED'); ok(res, {}, 'Merchant suspended'); });
export const activate = asyncHandler(async (req, res) => { await setMerchantStatus(req.user!.id, idParam(req), 'ACTIVE'); ok(res, {}, 'Merchant activated'); });

export const transactions = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.TransactionWhereInput = {};
  if (q.userId) where.userId = q.userId;
  if (q.q) where.order = { orderId: { contains: q.q, mode: 'insensitive' } };
  const range = dateRange(q);
  if (range) where.createdAt = range;
  const [rows, total] = await Promise.all([
    prisma.transaction.findMany({ where, include: { order: { select: { orderId: true } }, user: { select: { email: true, name: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.transaction.count({ where }),
  ]);
  ok(res, pageResult(rows.map((t) => ({ ...txDto(t), merchant: t.user.name, merchantEmail: t.user.email })), total, q));
});

export const listWithdrawals = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.WithdrawalWhereInput = {};
  if (q.status && ['PENDING', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED'].includes(q.status)) where.status = q.status as Prisma.WithdrawalWhereInput['status'];
  if (q.userId) where.userId = q.userId;
  const [rows, total] = await Promise.all([
    prisma.withdrawal.findMany({ where, include: { user: { select: { name: true, email: true } } }, orderBy: { requestedAt: 'desc' }, ...pageArgs(q) }),
    prisma.withdrawal.count({ where }),
  ]);
  ok(res, pageResult(rows.map((w) => ({ ...withdrawalDto(w), merchant: w.user.name, merchantEmail: w.user.email, userId: w.userId })), total, q));
});

export const approve = asyncHandler(async (req, res) => {
  const { note } = adminApproveBody.parse(req.body ?? {});
  ok(res, withdrawalDto(await withdrawals.adminApprove(req.user!.id, idParam(req), note)), 'Withdrawal approved: now PROCESSING');
});
export const reject = asyncHandler(async (req, res) => {
  const { note } = adminRejectBody.parse(req.body ?? {});
  ok(res, withdrawalDto(await withdrawals.adminReject(req.user!.id, idParam(req), note)), 'Withdrawal rejected and balance released');
});
export const markPaid = asyncHandler(async (req, res) => {
  const { note } = adminPaidBody.parse(req.body ?? {});
  ok(res, withdrawalDto(await withdrawals.adminMarkPaid(req.user!.id, idParam(req), note)), 'Withdrawal marked as paid');
});

export const listApiKeys = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.ApiKeyWhereInput = q.userId ? { userId: q.userId } : {};
  const [rows, total] = await Promise.all([
    prisma.apiKey.findMany({ where, include: { user: { select: { name: true, email: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.apiKey.count({ where }),
  ]);
  ok(res, pageResult(rows.map((k) => ({ id: k.id, name: k.name, prefix: k.keyPrefix, status: k.status, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt, merchant: k.user.name, merchantEmail: k.user.email })), total, q));
});

export const revokeApiKey = asyncHandler(async (req, res) => {
  const id = idParam(req);
  await prisma.$transaction(async (tx) => {
    const k = await tx.apiKey.findUnique({ where: { id } });
    if (!k) throw notFound('API key not found');
    await tx.apiKey.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    await adminAction(req.user!.id, k.userId, 'API_KEY_REVOKED', { apiKeyId: id }, tx);
  });
  ok(res, {}, 'API key revoked');
});

export const securityEvents = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.SecurityEventWhereInput = {};
  if (q.userId) where.userId = q.userId;
  if (q.q) where.eventType = { contains: q.q.toUpperCase() };
  const [rows, total] = await Promise.all([
    prisma.securityEvent.findMany({ where, include: { user: { select: { email: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.securityEvent.count({ where }),
  ]);
  ok(res, pageResult(rows.map((e) => ({ id: e.id, eventType: e.eventType, userEmail: e.user?.email ?? null, metadata: e.metadata, createdAt: e.createdAt })), total, q));
});

export const auditLogs = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.AdminActionLogWhereInput = q.userId ? { targetUserId: q.userId } : {};
  const [rows, total] = await Promise.all([
    prisma.adminActionLog.findMany({ where, include: { admin: { select: { email: true } }, target: { select: { email: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.adminActionLog.count({ where }),
  ]);
  ok(res, pageResult(rows.map((a) => ({ id: a.id, action: a.action, admin: a.admin.email, target: a.target?.email ?? null, metadata: a.metadata, createdAt: a.createdAt })), total, q));
});

export const apiLogs = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.ApiRequestLogWhereInput = q.userId ? { userId: q.userId } : {};
  const [rows, total] = await Promise.all([
    prisma.apiRequestLog.findMany({ where, include: { user: { select: { email: true } }, apiKey: { select: { keyPrefix: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.apiRequestLog.count({ where }),
  ]);
  ok(res, pageResult(rows.map((l) => ({ id: l.id, merchantEmail: l.user?.email ?? null, keyPrefix: l.apiKey?.keyPrefix ?? null, method: l.method, endpoint: l.endpoint, statusCode: l.statusCode, responseTime: l.responseTime, createdAt: l.createdAt })), total, q));
});

export const getPlatformSettings = asyncHandler(async (_req, res) => ok(res, await getSettings()));
export const updatePlatformSettings = asyncHandler(async (req, res) => {
  const body = settingsBody.parse(req.body);
  if (Object.keys(body).length === 0) throw new AppError(400, 'INVALID_REQUEST', 'No settings provided');
  if (body.min_withdrawal !== undefined) await setSetting('min_withdrawal', String(body.min_withdrawal));
  if (body.registrations_open !== undefined) await setSetting('registrations_open', String(body.registrations_open));
  await adminAction(req.user!.id, null, 'SETTINGS_UPDATED', body);
  ok(res, await getSettings(), 'Settings updated');
});
