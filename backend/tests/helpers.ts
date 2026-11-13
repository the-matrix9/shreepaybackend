import request from 'supertest';
import { vi } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { hashPassword } from '../src/services/authService';
import * as fam from '../src/services/famPayService';

export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'CorrectHorse9Battery';
export const app = createApp();

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ApiRequestLog","AdminActionLog","SecurityEvent","IdempotencyKey","Session","PasswordReset","EmailOtp","LedgerEntry","Transaction","PaymentOrder","Withdrawal","ApiKey","Wallet","MerchantProfile","PlatformSetting","User" RESTART IDENTITY CASCADE',
  );
  vi.mocked(fam.verifyPayment).mockReset();
  (globalThis as any).__mails.length = 0;
}

export const mails = (): { to: string; subject: string; text: string }[] => (globalThis as any).__mails;
/** Newest OTP emailed to this address. */
export function lastOtp(email: string): string {
  const m = [...mails()].reverse().find((x) => x.to === email.toLowerCase() && /verification code/.test(x.subject));
  const code = m?.text.match(/code is (\d{6})/)?.[1];
  if (!code) throw new Error('no OTP mail for ' + email);
  return code;
}

export type Agent = ReturnType<typeof request.agent>;
export const post = (a: Agent, url: string, body?: object) => a.post(url).set('Origin', ORIGIN).send(body ?? {});
export const put = (a: Agent, url: string, body?: object) => a.put(url).set('Origin', ORIGIN).send(body ?? {});
export const del = (a: Agent, url: string) => a.delete(url).set('Origin', ORIGIN);

export async function registerMerchant(email: string, extra: { upi?: string } = {}) {
  const agent = request.agent(app);
  const res = await post(agent, '/auth/register', { name: 'Test Merchant', email, password: PASSWORD, businessName: 'Test Biz' });
  if (res.status !== 201) throw new Error('register failed: ' + JSON.stringify(res.body));
  const ver = await post(agent, '/auth/verify-email', { email, code: lastOtp(email) });
  if (ver.status !== 200) throw new Error('verify failed: ' + JSON.stringify(ver.body));
  if (extra.upi) await put(agent, '/api/v1/profile', { upiId: extra.upi }).set('Origin', ORIGIN);
  return { agent, userId: ver.body.data.user.id as string };
}

export async function createApiKey(agent: Agent, name = 'test key') {
  const res = await post(agent, '/api/v1/api-keys', { name });
  return { key: res.body.data.key as string, id: res.body.data.id as string, res };
}

export const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });
export const apiPost = (key: string, url: string, body: object, headers: Record<string, string> = {}) =>
  request(app).post(url).set(bearer(key)).set(headers).send(body);

export async function loginAdmin(email = 'admin@shreepay.test') {
  await prisma.user.create({ data: { name: 'Admin', email, passwordHash: await hashPassword(PASSWORD), role: 'ADMIN', emailVerified: true } });
  const agent = request.agent(app);
  const res = await post(agent, '/auth/login', { email, password: PASSWORD });
  if (res.status !== 200) throw new Error('admin login failed');
  return agent;
}

/** What the upstream returns once a customer has paid. */
export const paid = (upstreamOrderId: string, amountRupees: number, txn = 'UTR' + upstreamOrderId.slice(2, 12)) => ({
  success: true, orderId: upstreamOrderId, amountPaise: BigInt(Math.round(amountRupees * 100)), status: 'VERIFIED' as const,
  rawStatus: 'paid', externalTransactionId: txn, verifiedAt: new Date().toISOString(), paymentUrl: null, raw: {},
});
export const unpaid = (upstreamOrderId: string) => ({
  success: true, orderId: upstreamOrderId, amountPaise: null, status: 'PENDING' as const,
  rawStatus: 'pending', externalTransactionId: null, verifiedAt: null, paymentUrl: null, raw: {},
});

export async function upstreamRef(orderId: string, userId: string) {
  return (await prisma.paymentOrder.findUniqueOrThrow({ where: { userId_orderId: { userId, orderId } } })).upstreamOrderId;
}

/** Credit a merchant by creating + verifying an order. Returns the merchant's key. */
export async function fundMerchant(m: { agent: Agent; userId: string }, amount: number, orderId = 'FUND' + Math.random().toString(36).slice(2, 8)) {
  const { key } = await createApiKey(m.agent, 'fund');
  await apiPost(key, '/api/v1/payments/create', { orderId, amount });
  const ref = await upstreamRef(orderId, m.userId);
  vi.mocked(fam.verifyPayment).mockResolvedValue(paid(ref, amount));
  const res = await apiPost(key, '/api/v1/payments/verify', { orderId });
  if (res.body.data?.status !== 'VERIFIED') throw new Error('fund failed: ' + JSON.stringify(res.body));
  return key;
}
