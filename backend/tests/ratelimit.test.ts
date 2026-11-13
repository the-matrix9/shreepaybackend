import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

// Must be set before the app module graph loads (env is parsed once at import time).
process.env.AUTH_RATE_LIMIT = '3';
process.env.VERIFY_RATE_LIMIT = '5';

let h: typeof import('./helpers');
beforeAll(async () => {
  h = await import('./helpers');
  await h.resetDb();
});

describe('rate limiting', () => {
  it('limits verification per API key without affecting other keys', async () => {
    const a = await h.registerMerchant('rl-a@example.com');
    const keyA = (await h.createApiKey(a.agent)).key;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await h.apiPost(keyA, '/api/v1/payments/verify', { orderId: 'NOPE' + i })).status);
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
    const limited = await h.apiPost(keyA, '/api/v1/payments/verify', { orderId: 'NOPE9' });
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['ratelimit-limit'] ?? limited.headers['ratelimit']).toBeDefined();

    const b = await h.registerMerchant('rl-b@example.com');
    const keyB = (await h.createApiKey(b.agent)).key;
    expect((await h.apiPost(keyB, '/api/v1/payments/verify', { orderId: 'NOPE' })).status).not.toBe(429);
    // other (non-verify) endpoints on the throttled key still work
    expect((await request(h.app).get('/api/v1/balance').set(h.bearer(keyA))).status).toBe(200);
  });

  it('throttles auth endpoints per IP', async () => {
    const agent = request.agent(h.app);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await h.post(agent, '/auth/login', { email: 'x@example.com', password: 'WrongPassword1' })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });
});
