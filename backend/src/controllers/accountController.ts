import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { asyncHandler, ok, pageArgs, pageResult, idParam } from '../lib/http';
import { AppError, notFound } from '../lib/errors';
import { generateApiKey } from '../lib/crypto';
import { ledgerDto, walletDto, withdrawalDto } from '../lib/dto';
import { paiseToRupeesNumber } from '../lib/money';
import { apiKeyBody, pageQuery, profileBody, rangeQuery, withdrawalBody } from '../validators';
import * as withdrawals from '../services/withdrawalService';
import { reqCtx, securityEvent } from '../services/auditService';
import { getSettings } from '../services/settingsService';

/* ---------- balance ---------- */
export const balance = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const [w, ledger, settings] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId } }),
    prisma.ledgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    getSettings(),
  ]);
  ok(res, { ...walletDto(w), minWithdrawal: settings.min_withdrawal, recentLedger: ledger.map(ledgerDto) });
});

/* ---------- withdrawals ---------- */
export const listWithdrawals = asyncHandler(async (req, res) => {
  const q = pageQuery.parse(req.query);
  const where = { userId: req.user!.id };
  const [items, total] = await Promise.all([
    prisma.withdrawal.findMany({ where, orderBy: { requestedAt: 'desc' }, ...pageArgs(q) }),
    prisma.withdrawal.count({ where }),
  ]);
  ok(res, pageResult(items.map(withdrawalDto), total, q));
});

export const createWithdrawal = asyncHandler(async (req, res) => {
  const body = withdrawalBody.parse(req.body);
  const w = await withdrawals.requestWithdrawal({ userId: req.user!.id, amountPaise: body.amount, upiId: body.upiId, ctx: reqCtx(req) });
  ok(res, withdrawalDto(w), 'Withdrawal requested. It will be reviewed and paid manually by an admin.', 201);
});

export const cancelWithdrawal = asyncHandler(async (req, res) => {
  const w = await withdrawals.cancelWithdrawal({ userId: req.user!.id, id: idParam(req), ctx: reqCtx(req) });
  ok(res, withdrawalDto(w), 'Withdrawal cancelled');
});

/* ---------- profile ---------- */
export const getProfile = asyncHandler(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, include: { profile: true } });
  ok(res, { name: u.name, email: u.email, phone: u.phone, businessName: u.profile?.businessName, upiId: u.profile?.upiId ?? null, upiVerified: u.profile?.upiVerified ?? false, upiUpdatedAt: u.profile?.upiUpdatedAt ?? null });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const body = profileBody.parse(req.body);
  const userId = req.user!.id;
  await prisma.$transaction(async (tx) => {
    if (body.name !== undefined || body.phone !== undefined) {
      await tx.user.update({ where: { id: userId }, data: { ...(body.name !== undefined && { name: body.name }), ...(body.phone !== undefined && { phone: body.phone }) } });
    }
    const profile = await tx.merchantProfile.findUniqueOrThrow({ where: { userId } });
    const data: Prisma.MerchantProfileUpdateInput = {};
    if (body.businessName !== undefined) data.businessName = body.businessName;
    if (body.upiId !== undefined && body.upiId !== profile.upiId) {
      data.upiId = body.upiId;
      data.upiVerified = false; // we have no real ownership verification: never claim otherwise
      data.upiUpdatedAt = new Date();
      await securityEvent(userId, 'UPI_CHANGED', reqCtx(req), undefined, tx);
    }
    if (Object.keys(data).length) await tx.merchantProfile.update({ where: { userId }, data });
  });
  return getProfile(req, res, () => undefined);
});

/* ---------- API keys ---------- */
const keyDto = (k: { id: string; name: string; keyPrefix: string; status: string; lastUsedAt: Date | null; createdAt: Date; revokedAt: Date | null }) => ({
  id: k.id, name: k.name, prefix: k.keyPrefix, status: k.status, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt, revokedAt: k.revokedAt,
});

export const listKeys = asyncHandler(async (req, res) => {
  const keys = await prisma.apiKey.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
  ok(res, keys.map(keyDto));
});

export const createKey = asyncHandler(async (req, res) => {
  const { name } = apiKeyBody.parse(req.body);
  const userId = req.user!.id;
  if ((await prisma.apiKey.count({ where: { userId, status: 'ACTIVE' } })) >= 10) {
    throw new AppError(400, 'KEY_LIMIT', 'Maximum of 10 active API keys');
  }
  const { key, keyPrefix, keyHash } = generateApiKey();
  const rec = await prisma.apiKey.create({ data: { userId, name, keyPrefix, keyHash } });
  await securityEvent(userId, 'API_KEY_CREATED', reqCtx(req), { apiKeyId: rec.id });
  // The ONLY time the plaintext key exists outside the merchant's hands.
  ok(res, { ...keyDto(rec), key, notice: 'This key will only be shown once. Store it securely.' }, 'API key created', 201);
});

export const revokeKey = asyncHandler(async (req, res) => {
  const id = idParam(req);
  const r = await prisma.apiKey.updateMany({ where: { id, userId: req.user!.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
  if (r.count !== 1) throw notFound('Active API key not found');
  await securityEvent(req.user!.id, 'API_KEY_REVOKED', reqCtx(req), { apiKeyId: id });
  ok(res, {}, 'API key revoked');
});

/* ---------- usage + analytics ---------- */
function range(q: { days?: number; from?: Date; to?: Date }) {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - (q.days ?? 30) * 86_400_000);
  return { from, to };
}

export const apiUsage = asyncHandler(async (req, res) => {
  const { from, to } = range(rangeQuery.parse(req.query));
  const userId = req.user!.id;
  const [daily, byEndpoint, totals] = await Promise.all([
    prisma.$queryRaw<{ day: Date; requests: number; errors: number }[]>(Prisma.sql`
      SELECT date_trunc('day', "createdAt")::date AS day, count(*)::int AS requests, count(*) FILTER (WHERE "statusCode" >= 400)::int AS errors
      FROM "ApiRequestLog" WHERE "userId" = ${userId} AND "createdAt" >= ${from} AND "createdAt" <= ${to} GROUP BY 1 ORDER BY 1`),
    prisma.$queryRaw<{ endpoint: string; method: string; requests: number; avgMs: number }[]>(Prisma.sql`
      SELECT endpoint, method, count(*)::int AS requests, round(avg("responseTime"))::int AS "avgMs"
      FROM "ApiRequestLog" WHERE "userId" = ${userId} AND "createdAt" >= ${from} AND "createdAt" <= ${to} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`),
    prisma.apiRequestLog.count({ where: { userId, createdAt: { gte: from, lte: to } } }),
  ]);
  ok(res, { totalRequests: totals, rateLimits: { api: env.API_RATE_LIMIT, verify: env.VERIFY_RATE_LIMIT, windowSeconds: 60 }, daily, byEndpoint });
});

export const analytics = asyncHandler(async (req, res) => {
  const { from, to } = range(rangeQuery.parse(req.query));
  const userId = req.user!.id;
  const rows = await prisma.$queryRaw<{ day: Date; created: number; verified: number; revenue: bigint }[]>(Prisma.sql`
    SELECT date_trunc('day', "createdAt")::date AS day, count(*)::int AS created,
           count(*) FILTER (WHERE status = 'VERIFIED')::int AS verified,
           COALESCE(sum(amount) FILTER (WHERE status = 'VERIFIED'), 0)::bigint AS revenue
    FROM "PaymentOrder" WHERE "userId" = ${userId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
    GROUP BY 1 ORDER BY 1`);
  const series = rows.map((r) => ({
    day: r.day, created: r.created, verified: r.verified, revenue: paiseToRupeesNumber(r.revenue),
    successRate: r.created ? Math.round((r.verified / r.created) * 1000) / 10 : 0,
  }));
  const created = rows.reduce((a, r) => a + r.created, 0);
  const verified = rows.reduce((a, r) => a + r.verified, 0);
  const revenue = rows.reduce((a, r) => a + r.revenue, 0n);
  ok(res, { from, to, series, totals: { created, verified, revenue: paiseToRupeesNumber(revenue), successRate: created ? Math.round((verified / created) * 1000) / 10 : 0 } });
});
