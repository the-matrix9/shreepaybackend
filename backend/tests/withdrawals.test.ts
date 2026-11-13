import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma';
import { app, apiPost, bearer, del, fundMerchant, loginAdmin, post, put, registerMerchant, resetDb } from './helpers';

beforeEach(resetDb);

const UPI = 'john@upi';
async function fundedMerchant(amount = 1000) {
  const m = await registerMerchant(`m${Math.random().toString(36).slice(2, 7)}@example.com`, { upi: UPI });
  const key = await fundMerchant(m, amount);
  return { ...m, key };
}
const wallet = (userId: string) => prisma.wallet.findUniqueOrThrow({ where: { userId } });

describe('withdrawal requests', () => {
  it('reserves balance atomically and records a RESERVE ledger entry + UPI snapshot', async () => {
    const m = await fundedMerchant(1000);
    const r = await post(m.agent, '/api/v1/withdrawals', { amount: 300, upiId: UPI });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ amount: 300, status: 'PENDING', upiId: UPI });
    const w = await wallet(m.userId);
    expect([w.available, w.reserved, w.totalReceived, w.totalWithdrawn]).toEqual([70000n, 30000n, 100000n, 0n]);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { type: 'RESERVE' } });
    expect(entry.amount).toBe(30000n);
    expect(entry.balanceAfter).toBe(70000n);
    // later UPI change never rewrites history
    await put(m.agent, '/api/v1/profile', { upiId: 'new@upi' });
    expect((await prisma.withdrawal.findFirstOrThrow()).upiIdSnapshot).toBe(UPI);
  });

  it('validates minimum, balance, UPI presence/match and unknown fields', async () => {
    const m = await fundedMerchant(1000);
    const code = async (body: object) => (await post(m.agent, '/api/v1/withdrawals', body)).body.error?.code;
    expect(await code({ amount: 50, upiId: UPI })).toBe('BELOW_MINIMUM');
    expect(await code({ amount: 5000, upiId: UPI })).toBe('INSUFFICIENT_BALANCE');
    expect(await code({ amount: 200, upiId: 'attacker@upi' })).toBe('UPI_MISMATCH');
    expect(await code({ amount: -200, upiId: UPI })).toBe('INVALID_REQUEST');
    expect(await code({ amount: 200, upiId: 'not-a-upi' })).toBe('INVALID_REQUEST');
    expect(await code({ amount: 200, upiId: UPI, balance: 99999 })).toBe('INVALID_REQUEST');
    const noUpi = await registerMerchant('noupi@example.com');
    expect((await post(noUpi.agent, '/api/v1/withdrawals', { amount: 200, upiId: UPI })).body.error.code).toBe('UPI_REQUIRED');
    expect(await prisma.withdrawal.count()).toBe(0);
    expect((await wallet(m.userId)).available).toBe(100000n);
  });

  it('prevents double withdrawal of the same balance under concurrency', async () => {
    const m = await fundedMerchant(1000);
    const results = await Promise.all(Array.from({ length: 6 }, () => post(m.agent, '/api/v1/withdrawals', { amount: 1000, upiId: UPI })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.error?.code === 'INSUFFICIENT_BALANCE')).toHaveLength(5);
    const w = await wallet(m.userId);
    expect([w.available, w.reserved]).toEqual([0n, 100000n]);
    expect(await prisma.ledgerEntry.count({ where: { type: 'RESERVE' } })).toBe(1);
  });

  it('merchant can cancel a pending withdrawal (RELEASE) but not a processing one', async () => {
    const m = await fundedMerchant(1000);
    const id = (await post(m.agent, '/api/v1/withdrawals', { amount: 400, upiId: UPI })).body.data.id;
    expect((await del(m.agent, `/api/v1/withdrawals/${id}`)).status).toBe(200);
    expect((await wallet(m.userId)).available).toBe(100000n);
    const id2 = (await post(m.agent, '/api/v1/withdrawals', { amount: 400, upiId: UPI })).body.data.id;
    const admin = await loginAdmin();
    await post(admin, `/admin/withdrawals/${id2}/approve`);
    expect((await del(m.agent, `/api/v1/withdrawals/${id2}`)).status).toBe(409);
  });

  it("merchants cannot see or cancel each other's withdrawals", async () => {
    const a = await fundedMerchant(1000);
    const b = await fundedMerchant(1000);
    const id = (await post(a.agent, '/api/v1/withdrawals', { amount: 400, upiId: UPI })).body.data.id;
    expect((await b.agent.get('/api/v1/withdrawals')).body.data.total).toBe(0);
    expect((await del(b.agent, `/api/v1/withdrawals/${id}`)).status).toBe(404);
  });
});

describe('admin withdrawal flow', () => {
  it('approve -> mark paid: reserved becomes withdrawn, one DEBIT, admin logs written', async () => {
    const m = await fundedMerchant(1000);
    const id = (await post(m.agent, '/api/v1/withdrawals', { amount: 500, upiId: UPI })).body.data.id;
    const admin = await loginAdmin();

    expect((await post(admin, `/admin/withdrawals/${id}/mark-paid`, { confirm: true })).status).toBe(409); // must be approved first
    expect((await post(admin, `/admin/withdrawals/${id}/approve`, { note: 'ok' })).body.data.status).toBe('PROCESSING');
    expect((await post(admin, `/admin/withdrawals/${id}/mark-paid`, {})).status).toBe(400); // explicit confirmation required
    const paid = await post(admin, `/admin/withdrawals/${id}/mark-paid`, { confirm: true, note: 'UTR 123' });
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe('PAID');
    expect((await post(admin, `/admin/withdrawals/${id}/mark-paid`, { confirm: true })).status).toBe(409); // never twice

    const w = await wallet(m.userId);
    expect([w.available, w.reserved, w.totalReceived, w.totalWithdrawn]).toEqual([50000n, 0n, 100000n, 50000n]);
    expect(await prisma.ledgerEntry.count({ where: { type: 'DEBIT' } })).toBe(1);
    const row = await prisma.withdrawal.findUniqueOrThrow({ where: { id } });
    expect(row.paidAt).not.toBeNull();
    expect(row.adminId).not.toBeNull();
    expect(row.adminNote).toBe('UTR 123');
    const actions = (await prisma.adminActionLog.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['WITHDRAWAL_APPROVED', 'WITHDRAWAL_PAID']);
  });

  it('reject releases the reserved balance exactly once and needs a reason', async () => {
    const m = await fundedMerchant(1000);
    const id = (await post(m.agent, '/api/v1/withdrawals', { amount: 300, upiId: UPI })).body.data.id;
    const admin = await loginAdmin();
    expect((await post(admin, `/admin/withdrawals/${id}/reject`, {})).status).toBe(400);
    expect((await post(admin, `/admin/withdrawals/${id}/reject`, { note: 'UPI looks wrong' })).body.data.status).toBe('REJECTED');
    expect((await post(admin, `/admin/withdrawals/${id}/reject`, { note: 'again please' })).status).toBe(409);
    const w = await wallet(m.userId);
    expect([w.available, w.reserved]).toEqual([100000n, 0n]);
    expect(await prisma.ledgerEntry.count({ where: { type: 'RELEASE' } })).toBe(1);
    expect((await post(admin, `/admin/withdrawals/${id}/approve`)).status).toBe(409);
  });

  it('concurrent approve + reject + mark-paid leave a consistent ledger', async () => {
    const m = await fundedMerchant(1000);
    const id = (await post(m.agent, '/api/v1/withdrawals', { amount: 500, upiId: UPI })).body.data.id;
    const admin = await loginAdmin();
    await post(admin, `/admin/withdrawals/${id}/approve`);
    await Promise.all([
      post(admin, `/admin/withdrawals/${id}/mark-paid`, { confirm: true }),
      post(admin, `/admin/withdrawals/${id}/mark-paid`, { confirm: true }),
      post(admin, `/admin/withdrawals/${id}/reject`, { note: 'race test' }),
    ]);
    const w = await wallet(m.userId);
    expect(w.reserved).toBe(0n);
    expect(w.available + w.totalWithdrawn).toBe(100000n); // money is neither created nor destroyed
    const settled = (await prisma.ledgerEntry.count({ where: { type: 'DEBIT' } })) + (await prisma.ledgerEntry.count({ where: { type: 'RELEASE' } }));
    expect(settled).toBe(1);
  });

  it('only admins can run withdrawal actions; merchants and API keys get 401/403', async () => {
    const m = await fundedMerchant(1000);
    const id = (await post(m.agent, '/api/v1/withdrawals', { amount: 300, upiId: UPI })).body.data.id;
    expect((await post(m.agent, `/admin/withdrawals/${id}/approve`)).status).toBe(403);
    expect((await request(app).post(`/admin/withdrawals/${id}/approve`).set(bearer(m.key)).send({})).status).toBe(401);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
    const admin = await loginAdmin();
    const list = await admin.get('/admin/withdrawals?status=PENDING');
    expect(list.body.data.items[0]).toMatchObject({ upiId: UPI, amount: 300, status: 'PENDING' });
  });
});

describe('ledger integrity', () => {
  it('wallet balances always equal the replay of the ledger', async () => {
    const m = await fundedMerchant(1000);
    const admin = await loginAdmin();
    const w1 = (await post(m.agent, '/api/v1/withdrawals', { amount: 300, upiId: UPI })).body.data.id;
    const w2 = (await post(m.agent, '/api/v1/withdrawals', { amount: 200, upiId: UPI })).body.data.id;
    await post(admin, `/admin/withdrawals/${w1}/approve`);
    await post(admin, `/admin/withdrawals/${w1}/mark-paid`, { confirm: true });
    await post(admin, `/admin/withdrawals/${w2}/reject`, { note: 'nope nope' });
    const entries = await prisma.ledgerEntry.findMany({ where: { userId: m.userId } });
    let available = 0n, reserved = 0n, withdrawn = 0n;
    for (const e of entries) {
      if (e.type === 'CREDIT') available += e.amount;
      if (e.type === 'RESERVE') { available -= e.amount; reserved += e.amount; }
      if (e.type === 'RELEASE') { available += e.amount; reserved -= e.amount; }
      if (e.type === 'DEBIT') { reserved -= e.amount; withdrawn += e.amount; }
    }
    const w = await wallet(m.userId);
    expect([w.available, w.reserved, w.totalWithdrawn]).toEqual([available, reserved, withdrawn]);
    const bal = await request(app).get('/api/v1/balance').set(bearer(m.key));
    expect(bal.body.data).toMatchObject({ available: 700, reserved: 0, totalReceived: 1000, totalWithdrawn: 300 });
    expect((await apiPost(m.key, '/api/v1/payments/verify', { orderId: 'nothing' })).status).toBe(404);
  });
});
