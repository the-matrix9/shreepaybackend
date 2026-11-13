import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, lastOtp, mails, PASSWORD, post, registerMerchant, resetDb } from './helpers';
import { prisma } from '../src/lib/prisma';

beforeEach(resetDb);

const reg = (agent: ReturnType<typeof request.agent>, email: string, password = PASSWORD) =>
  post(agent, '/auth/register', { name: 'Otp User', email, password, businessName: 'Otp Biz' });

describe('email OTP signup', () => {
  it('blocks login until the email is verified', async () => {
    const agent = request.agent(app);
    await reg(agent, 'u1@example.com');
    const res = await post(agent, '/auth/login', { email: 'u1@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a wrong code and accepts the right one only once', async () => {
    const agent = request.agent(app);
    await reg(agent, 'u2@example.com');
    const code = lastOtp('u2@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await post(agent, '/auth/verify-email', { email: 'u2@example.com', code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_OTP');
    expect((await post(agent, '/auth/verify-email', { email: 'u2@example.com', code })).status).toBe(200);
    expect((await post(request.agent(app), '/auth/verify-email', { email: 'u2@example.com', code })).status).toBeGreaterThanOrEqual(400);
  });

  it('locks the code after too many wrong attempts, even for the right code', async () => {
    const agent = request.agent(app);
    await reg(agent, 'u3@example.com');
    const code = lastOtp('u3@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await post(agent, '/auth/verify-email', { email: 'u3@example.com', code: wrong });
    const res = await post(agent, '/auth/verify-email', { email: 'u3@example.com', code });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an expired code', async () => {
    const agent = request.agent(app);
    await reg(agent, 'u4@example.com');
    await prisma.emailOtp.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post(agent, '/auth/verify-email', { email: 'u4@example.com', code: lastOtp('u4@example.com') });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('enforces the resend cooldown and never reveals whether an email exists', async () => {
    const agent = request.agent(app);
    await reg(agent, 'u5@example.com');
    const before = mails().length;
    const again = await post(agent, '/auth/resend-otp', { email: 'u5@example.com' });
    const ghost = await post(agent, '/auth/resend-otp', { email: 'ghost@example.com' });
    expect(again.status).toBe(ghost.status);
    expect(mails().length).toBe(before); // cooldown: no second mail; unknown: no mail
  });

  it('does not let someone re-register a verified email', async () => {
    await registerMerchant('taken@example.com');
    expect((await reg(request.agent(app), 'taken@example.com')).status).toBe(409);
  });

  it('rejects common passwords and passwords containing the email name', async () => {
    const a = request.agent(app);
    expect((await reg(a, 'cp@example.com', 'Password123456')).status).toBe(400);
    expect((await reg(a, 'johnsmith@example.com', 'johnsmith-Secret9')).status).toBe(400);
  });
});
