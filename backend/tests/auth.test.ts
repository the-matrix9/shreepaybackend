import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, lastOtp, loginAdmin, ORIGIN, PASSWORD, post, registerMerchant, resetDb } from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(resetDb);

describe('registration / login / logout', () => {
  it('register sends an OTP and gives no session; verifying creates profile, wallet and an HttpOnly cookie', async () => {
    const agent = request.agent(app);
    const res = await post(agent, '/auth/register', { name: 'Asha', email: 'Asha@Example.com', password: PASSWORD, businessName: 'Asha Co' });
    expect(res.status).toBe(201);
    expect(res.body.data.verificationRequired).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await agent.get('/auth/me')).status).toBe(401);
    const ver = await post(agent, '/auth/verify-email', { email: 'asha@example.com', code: lastOtp('asha@example.com') });
    expect(ver.status).toBe(200);
    expect(ver.body.data.user.email).toBe('asha@example.com');
    expect(ver.body.data.user).not.toHaveProperty('passwordHash');
    const cookie = String(ver.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: ver.body.data.user.id } });
    expect(wallet.available).toBe(0n);
    expect((await prisma.user.findFirstOrThrow()).passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects weak passwords, unknown fields and duplicate emails', async () => {
    const agent = request.agent(app);
    expect((await post(agent, '/auth/register', { name: 'A B', email: 'a@b.co', password: 'short', businessName: 'X Y' })).status).toBe(400);
    expect((await post(agent, '/auth/register', { name: 'A B', email: 'a@b.co', password: PASSWORD, businessName: 'X Y', role: 'ADMIN' })).status).toBe(400);
    await registerMerchant('dup@example.com');
    const dup = await post(agent, '/auth/register', { name: 'A B', email: 'dup@example.com', password: PASSWORD, businessName: 'X Y' });
    expect(dup.status).toBe(409);
  });

  it('logs in, serves /auth/me, then logout destroys the session', async () => {
    await registerMerchant('login@example.com');
    const agent = request.agent(app);
    expect((await post(agent, '/auth/login', { email: 'login@example.com', password: PASSWORD })).status).toBe(200);
    expect((await agent.get('/auth/me')).body.data.user.email).toBe('login@example.com');
    expect((await post(agent, '/auth/logout')).status).toBe(200);
    expect((await agent.get('/auth/me')).status).toBe(401);
    expect(await prisma.session.count({ where: { user: { email: 'login@example.com' } } })).toBe(1); // only the register session remains
  });

  it('gives the same error for unknown email and wrong password, and locks after repeated failures', async () => {
    await registerMerchant('lock@example.com');
    const agent = request.agent(app);
    const a = await post(agent, '/auth/login', { email: 'nobody@example.com', password: PASSWORD });
    const b = await post(agent, '/auth/login', { email: 'lock@example.com', password: 'WrongPassword1' });
    expect(a.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
    for (let i = 0; i < 5; i++) await post(agent, '/auth/login', { email: 'lock@example.com', password: 'WrongPassword1' });
    const locked = await post(agent, '/auth/login', { email: 'lock@example.com', password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('blocks cookie-authenticated writes without a trusted Origin (CSRF)', async () => {
    const { agent } = await registerMerchant('csrf@example.com');
    const bad = await agent.post('/api/v1/api-keys').set('Origin', 'https://evil.example').send({ name: 'x1' });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('CSRF_BLOCKED');
    const none = await agent.post('/api/v1/api-keys').send({ name: 'x1' });
    expect(none.status).toBe(403);
  });

  it('sends CORS only for the allowlisted origin and never "*"', async () => {
    const good = await request(app).options('/auth/login').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'POST');
    expect(good.headers['access-control-allow-origin']).toBe(ORIGIN);
    const bad = await request(app).options('/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('admin authorization', () => {
  it('rejects anonymous and merchant callers, allows admins', async () => {
    expect((await request(app).get('/admin/dashboard')).status).toBe(401);
    const { agent } = await registerMerchant('m@example.com');
    const asMerchant = await agent.get('/admin/dashboard');
    expect(asMerchant.status).toBe(403);
    expect(asMerchant.body.error.code).toBe('ADMIN_ONLY');
    const admin = await loginAdmin();
    const ok = await admin.get('/admin/dashboard');
    expect(ok.status).toBe(200);
    expect(ok.body.data.cards.totalMerchants).toBe(1);
  });

  it('suspending a merchant ends their sessions and blocks API keys', async () => {
    const m = await registerMerchant('victim@example.com');
    const keyRes = await post(m.agent, '/api/v1/api-keys', { name: 'k1' });
    const admin = await loginAdmin();
    expect((await post(admin, `/admin/merchants/${m.userId}/suspend`)).status).toBe(200);
    expect((await m.agent.get('/auth/me')).status).toBe(401);
    const api = await request(app).get('/api/v1/balance').set('Authorization', `Bearer ${keyRes.body.data.key}`);
    expect(api.status).toBe(403);
    expect(await prisma.adminActionLog.count({ where: { action: 'MERCHANT_SUSPENDED' } })).toBe(1);
  });
});
