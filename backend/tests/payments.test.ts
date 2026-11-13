import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as fam from '../src/services/famPayService';
import { prisma } from '../src/lib/prisma';
import { sha256 } from '../src/lib/crypto';
import { apiPost, app, bearer, createApiKey, paid, registerMerchant, resetDb, unpaid, upstreamRef, del } from './helpers';
import { AppError } from '../src/lib/errors';

beforeEach(resetDb);

async function merchant(email = 'm1@example.com') {
  const m = await registerMerchant(email);
  const { key } = await createApiKey(m.agent);
  return { ...m, key };
}

describe('API keys', () => {
  it('shows the key once, stores only a hash, and authenticates with it', async () => {
    const m = await registerMerchant('k@example.com');
    const { key, res } = await createApiKey(m.agent);
    expect(key).toMatch(/^sk_live_[A-Za-z0-9_-]{32,}$/);
    expect(res.body.data.notice).toMatch(/only be shown once/);
    const rec = await prisma.apiKey.findFirstOrThrow();
    expect(rec.keyHash).toBe(sha256(key));
    expect(JSON.stringify(rec)).not.toContain(key);
    const list = await m.agent.get('/api/v1/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect((await request(app).get('/api/v1/balance').set(bearer(key))).status).toBe(200);
  });

  it('rejects malformed, unknown and revoked keys', async () => {
    const m = await merchant();
    expect((await request(app).get('/api/v1/balance')).status).toBe(401);
    expect((await request(app).get('/api/v1/balance').set(bearer('sk_live_nope'))).status).toBe(401);
    expect((await request(app).get('/api/v1/balance').set(bearer('sk_live_' + 'a'.repeat(32)))).status).toBe(401);
    const id = (await prisma.apiKey.findFirstOrThrow()).id;
    expect((await del(m.agent, `/api/v1/api-keys/${id}`)).status).toBe(200);
    const revoked = await request(app).get('/api/v1/balance').set(bearer(m.key));
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('API_KEY_REVOKED');
  });

  it('API keys cannot manage keys, profile or withdrawals', async () => {
    const m = await merchant();
    expect((await request(app).post('/api/v1/api-keys').set(bearer(m.key)).send({ name: 'sneaky' })).status).toBe(403);
    expect((await request(app).get('/api/v1/profile').set(bearer(m.key))).status).toBe(403);
    const w = await request(app).post('/api/v1/withdrawals').set(bearer(m.key)).send({ amount: 100, upiId: 'a@upi' });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe('SESSION_REQUIRED');
  });
});

describe('payment creation', () => {
  it('creates an order, calls upstream with a unique upstream id (not the merchant orderId) and returns a ShreePay link', async () => {
    const m = await merchant();
    const res = await apiPost(m.key, '/api/v1/payments/create', { orderId: 'ORDER123', amount: 500 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ orderId: 'ORDER123', amount: 500, status: 'PENDING' });
    const ref = await upstreamRef('ORDER123', m.userId);
    expect(ref).toMatch(/^SP[0-9A-F]{24}$/);
    expect(res.body.data.paymentUrl).toBe(`http://localhost:4000/pay/${ref}`);
    expect(fam.generatePayment).toHaveBeenCalledWith(ref, 50000n);
  });

  it('validates amounts without floating point surprises', async () => {
    const m = await merchant();
    for (const amount of [0, -5, 1.005, 1e21, '1e3', 'abc', 1_000_000_000, null]) {
      const r = await apiPost(m.key, '/api/v1/payments/create', { orderId: 'BAD' + String(Math.random()).slice(2, 8), amount });
      expect(r.status, `amount=${String(amount)}`).toBe(400);
    }
    const ok = await apiPost(m.key, '/api/v1/payments/create', { orderId: 'DEC1', amount: 19.99 });
    expect(ok.status).toBe(201);
    expect((await prisma.paymentOrder.findFirstOrThrow({ where: { orderId: 'DEC1' } })).amount).toBe(1999n);
    expect((await apiPost(m.key, '/api/v1/payments/create', { orderId: 'X1', amount: 5, userId: 'other' })).status).toBe(400); // unknown field
  });

  it('same orderId + same amount returns the same link; a different amount is a conflict; merchants can reuse each other\'s ids', async () => {
    const a = await merchant('a@example.com');
    const b = await merchant('b@example.com');
    const r1 = await apiPost(a.key, '/api/v1/payments/create', { orderId: 'ORDER1', amount: 100 });
    const r2 = await apiPost(a.key, '/api/v1/payments/create', { orderId: 'ORDER1', amount: 100 });
    expect(r2.status).toBe(200);
    expect(r2.body.data.paymentUrl).toBe(r1.body.data.paymentUrl);
    expect((await apiPost(a.key, '/api/v1/payments/create', { orderId: 'ORDER1', amount: 200 })).status).toBe(409);
    const other = await apiPost(b.key, '/api/v1/payments/create', { orderId: 'ORDER1', amount: 100 });
    expect(other.status).toBe(201);
    expect(other.body.data.paymentUrl).not.toBe(r1.body.data.paymentUrl);
  });

  it('returns UPSTREAM_UNAVAILABLE and leaves no orphan order when upstream is down', async () => {
    const m = await merchant();
    vi.mocked(fam.generatePayment).mockRejectedValueOnce(new AppError(502, 'UPSTREAM_UNAVAILABLE', 'Payment service temporarily unavailable'));
    const r = await apiPost(m.key, '/api/v1/payments/create', { orderId: 'DOWN1', amount: 50 });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Payment service temporarily unavailable' } });
    expect(await prisma.paymentOrder.count()).toBe(0);
  });
});

describe('payment verification + ledger', () => {
  it('does not credit while upstream says pending', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'P1', amount: 500 });
    vi.mocked(fam.verifyPayment).mockResolvedValue(unpaid(await upstreamRef('P1', m.userId)));
    const r = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'P1' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('PENDING');
    expect(r.body.data.verified).toBe(false);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: m.userId } })).available).toBe(0n);
  });

  it('credits exactly once: verifying twice (and 10x in parallel) creates ONE transaction and ONE ledger credit', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'ORDER123', amount: 500 });
    vi.mocked(fam.verifyPayment).mockResolvedValue(paid(await upstreamRef('ORDER123', m.userId), 500));

    const first = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'ORDER123' });
    const second = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'ORDER123' });
    expect(first.body.data).toMatchObject({ orderId: 'ORDER123', amount: 500, status: 'VERIFIED' });
    expect(second.body.data.status).toBe('VERIFIED');
    expect(second.body.data.transaction.id).toBe(first.body.data.transaction.id);

    await Promise.all(Array.from({ length: 10 }, () => apiPost(m.key, '/api/v1/payments/verify', { orderId: 'ORDER123' })));

    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { type: 'CREDIT' } })).toBe(1);
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: m.userId } });
    expect(w.available).toBe(50000n);
    expect(w.totalReceived).toBe(50000n);
    const ledger = await prisma.ledgerEntry.findFirstOrThrow();
    expect(ledger.balanceAfter).toBe(50000n);
  });

  it('parallel verification of many orders credits each exactly once and balances reconcile with the ledger', async () => {
    const m = await merchant();
    for (let i = 0; i < 5; i++) await apiPost(m.key, '/api/v1/payments/create', { orderId: `BULK${i}`, amount: 100 + i });
    vi.mocked(fam.verifyPayment).mockImplementation(async (ref: string) => {
      const o = await prisma.paymentOrder.findUniqueOrThrow({ where: { upstreamOrderId: ref } });
      return paid(ref, Number(o.amount) / 100);
    });
    await Promise.all(Array.from({ length: 15 }, (_, i) => apiPost(m.key, '/api/v1/payments/verify', { orderId: `BULK${i % 5}` })));
    const w = await prisma.wallet.findUniqueOrThrow({ where: { userId: m.userId } });
    const sum = await prisma.ledgerEntry.aggregate({ where: { type: 'CREDIT' }, _sum: { amount: true }, _count: true });
    expect(sum._count).toBe(5);
    expect(w.available).toBe(sum._sum.amount);
    expect(w.available).toBe(BigInt((100 + 101 + 102 + 103 + 104) * 100));
  });

  it('refuses to credit when the upstream amount differs from the order amount', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'MIS1', amount: 500 });
    vi.mocked(fam.verifyPayment).mockResolvedValue(paid(await upstreamRef('MIS1', m.userId), 1));
    const r = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'MIS1' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(await prisma.ledgerEntry.count()).toBe(0);
    expect((await prisma.paymentOrder.findFirstOrThrow()).status).toBe('FAILED');
  });

  it('refuses to credit when upstream confirms payment but gives no amount (default strict mode)', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'NOAMT', amount: 500 });
    vi.mocked(fam.verifyPayment).mockResolvedValue({ ...paid(await upstreamRef('NOAMT', m.userId), 500), amountPaise: null });
    const r = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'NOAMT' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('UPSTREAM_AMOUNT_MISSING');
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it('does not credit the same upstream transaction reference to a second order', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'T1', amount: 100 });
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'T2', amount: 100 });
    vi.mocked(fam.verifyPayment).mockImplementation(async (ref) => paid(ref, 100, 'UTR_SAME_REF_1'));
    expect((await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'T1' })).body.data.status).toBe('VERIFIED');
    const second = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'T2' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_TRANSACTION');
    expect(await prisma.ledgerEntry.count({ where: { type: 'CREDIT' } })).toBe(1);
  });

  it('maps upstream outages to UPSTREAM_UNAVAILABLE without changing state', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'U1', amount: 100 });
    vi.mocked(fam.verifyPayment).mockRejectedValue(new AppError(502, 'UPSTREAM_UNAVAILABLE', 'Payment service temporarily unavailable'));
    const r = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'U1' });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect((await prisma.paymentOrder.findFirstOrThrow()).status).toBe('PENDING');
  });
});

describe('ownership + merchant isolation', () => {
  it('merchant B cannot verify, read or list merchant A\'s orders and transactions', async () => {
    const a = await merchant('a@example.com');
    const b = await merchant('b@example.com');
    await apiPost(a.key, '/api/v1/payments/create', { orderId: 'SECRET1', amount: 250 });
    const ref = await upstreamRef('SECRET1', a.userId);
    vi.mocked(fam.verifyPayment).mockResolvedValue(paid(ref, 250));
    await apiPost(a.key, '/api/v1/payments/verify', { orderId: 'SECRET1' });

    // B tries A's internal reference -> 403 ORDER_ACCESS_DENIED, no credit for B
    const steal = await apiPost(b.key, '/api/v1/payments/verify', { orderId: ref });
    expect(steal.status).toBe(403);
    expect(steal.body.error.code).toBe('ORDER_ACCESS_DENIED');
    // B tries A's orderId string -> not found in B's namespace
    expect((await apiPost(b.key, '/api/v1/payments/verify', { orderId: 'SECRET1' })).status).toBe(404);
    expect((await request(app).get('/api/v1/payments/SECRET1').set(bearer(b.key))).status).toBe(404);
    expect((await request(app).get('/api/v1/payments').set(bearer(b.key))).body.data.total).toBe(0);
    expect((await request(app).get('/api/v1/transactions').set(bearer(b.key))).body.data.total).toBe(0);
    const txId = (await prisma.transaction.findFirstOrThrow()).id;
    expect((await request(app).get(`/api/v1/transactions/${txId}`).set(bearer(b.key))).status).toBe(404);
    expect((await request(app).get('/api/v1/balance').set(bearer(b.key))).body.data.available).toBe(0);
    expect((await request(app).get('/api/v1/balance').set(bearer(a.key))).body.data.available).toBe(250);
    expect(await prisma.securityEvent.count({ where: { eventType: 'ORDER_ACCESS_DENIED', userId: b.userId } })).toBe(1);
    // B cannot see or revoke A's API keys
    const aKey = (await prisma.apiKey.findFirstOrThrow({ where: { userId: a.userId } })).id;
    expect((await b.agent.get('/api/v1/api-keys')).body.data).toHaveLength(1);
    expect((await del(b.agent, `/api/v1/api-keys/${aKey}`)).status).toBe(404);
  });
});

describe('idempotency', () => {
  it('replays the original response for the same Idempotency-Key and rejects a different payload', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'IDEM1', amount: 300 });
    vi.mocked(fam.verifyPayment).mockResolvedValue(paid(await upstreamRef('IDEM1', m.userId), 300));
    const h = { 'Idempotency-Key': 'abc12345-key' };
    const r1 = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'IDEM1' }, h);
    const r2 = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'IDEM1' }, h);
    expect(r2.status).toBe(r1.status);
    expect(r2.body).toEqual(r1.body);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(fam.verifyPayment).toHaveBeenCalledTimes(1);
    const diff = await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'OTHER' }, h);
    expect(diff.status).toBe(422);
    expect(diff.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'IDEM1' }, { 'Idempotency-Key': 'x' })).status).toBe(400);
  });

  it('does not store 5xx results so the client can retry with the same key', async () => {
    const m = await merchant();
    await apiPost(m.key, '/api/v1/payments/create', { orderId: 'IDEM2', amount: 10 });
    vi.mocked(fam.verifyPayment).mockRejectedValueOnce(new AppError(502, 'UPSTREAM_UNAVAILABLE', 'x'));
    const h = { 'Idempotency-Key': 'retry-key-0001' };
    expect((await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'IDEM2' }, h)).status).toBe(502);
    vi.mocked(fam.verifyPayment).mockResolvedValue(paid(await upstreamRef('IDEM2', m.userId), 10));
    expect((await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'IDEM2' }, h)).body.data.status).toBe('VERIFIED');
  });
});
