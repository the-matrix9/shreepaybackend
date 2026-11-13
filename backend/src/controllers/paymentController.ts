import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, ok, pageArgs, pageResult, idParam } from '../lib/http';
import { notFound } from '../lib/errors';
import { orderDto, txDto } from '../lib/dto';
import { parseRupeesToPaise } from '../lib/money';
import { createPaymentBody, listQuery, orderIdSchema, verifyPaymentBody } from '../validators';
import * as payments from '../services/paymentService';
import { reqCtx } from '../services/auditService';

export const create = asyncHandler(async (req, res) => {
  const body = createPaymentBody.parse(req.body);
  const { order, created } = await payments.createPayment({ userId: req.user!.id, orderId: body.orderId, amountPaise: body.amount, ctx: reqCtx(req) });
  ok(res, orderDto(order), created ? 'Payment created' : 'Payment already exists', created ? 201 : 200);
});

export const verify = asyncHandler(async (req, res) => {
  const body = verifyPaymentBody.parse(req.body);
  const r = await payments.verifyPayment({ userId: req.user!.id, orderId: body.orderId, ctx: reqCtx(req) });
  ok(res, { ...orderDto(r.order), verified: r.verified, transaction: r.transaction ? txDto({ ...r.transaction, order: { orderId: r.order.orderId } }) : null }, r.verified ? 'Payment verified' : 'Payment not verified yet');
});

export const get = asyncHandler(async (req, res) => {
  const order = await payments.getOrder(req.user!.id, orderIdSchema.parse(req.params.orderId));
  ok(res, { ...orderDto(order), transaction: order.transaction ? txDto(order.transaction) : null });
});

const orderStatuses = ['PENDING', 'VERIFIED', 'FAILED', 'EXPIRED'] as const;

export const list = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.PaymentOrderWhereInput = { userId: req.user!.id }; // always scoped to the caller
  if (q.q) where.orderId = { contains: q.q, mode: 'insensitive' };
  if (q.status && (orderStatuses as readonly string[]).includes(q.status)) where.status = q.status as (typeof orderStatuses)[number];
  if (q.from || q.to) where.createdAt = { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) };
  const min = q.minAmount ? parseRupeesToPaise(q.minAmount) : null;
  const max = q.maxAmount ? parseRupeesToPaise(q.maxAmount) : null;
  if (min !== null || max !== null) where.amount = { ...(min !== null && { gte: min }), ...(max !== null && { lte: max }) };
  const [items, total] = await Promise.all([
    prisma.paymentOrder.findMany({ where, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.paymentOrder.count({ where }),
  ]);
  ok(res, pageResult(items.map(orderDto), total, q));
});

export const listTransactions = asyncHandler(async (req, res) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.TransactionWhereInput = { userId: req.user!.id };
  if (q.q) where.order = { orderId: { contains: q.q, mode: 'insensitive' } };
  if (q.status && ['PENDING', 'VERIFIED', 'FAILED', 'EXPIRED', 'DUPLICATE'].includes(q.status)) where.status = q.status as Prisma.TransactionWhereInput['status'];
  if (q.from || q.to) where.createdAt = { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) };
  const min = q.minAmount ? parseRupeesToPaise(q.minAmount) : null;
  const max = q.maxAmount ? parseRupeesToPaise(q.maxAmount) : null;
  if (min !== null || max !== null) where.amount = { ...(min !== null && { gte: min }), ...(max !== null && { lte: max }) };
  const [items, total] = await Promise.all([
    prisma.transaction.findMany({ where, include: { order: { select: { orderId: true } } }, orderBy: { createdAt: 'desc' }, ...pageArgs(q) }),
    prisma.transaction.count({ where }),
  ]);
  ok(res, pageResult(items.map(txDto), total, q));
});

export const getTransaction = asyncHandler(async (req, res) => {
  const t = await prisma.transaction.findFirst({
    where: { id: idParam(req), userId: req.user!.id }, // IDOR-safe: id AND owner
    include: { order: { select: { orderId: true } } },
  });
  if (!t) throw notFound('Transaction not found');
  ok(res, txDto(t));
});
