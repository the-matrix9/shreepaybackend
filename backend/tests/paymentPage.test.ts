import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app, apiPost, createApiKey, registerMerchant, resetDb, upstreamRef } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

async function makeRef() {
  const m = await registerMerchant('pay@example.com');
  const { key } = await createApiKey(m.agent);
  await apiPost(key, '/api/v1/payments/create', { orderId: 'PG1', amount: 100 });
  return upstreamRef('PG1', m.userId);
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html', server: 'Vercel', 'x-vercel-id': 'abc', 'set-cookie': 'a=b', ...(init.headers as object) }, ...init });

describe('payment page proxy', () => {
  it('serves the upstream page without leaking the upstream host or headers', async () => {
    const ref = await makeRef();
    vi.stubGlobal('fetch', vi.fn(async () => html('<a href="https://upstream.test/verify/x">pay</a><img src="//upstream.test/a.png">')));
    const res = await request(app).get(`/pay/${ref}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('upstream.test');
    expect(res.headers['server']).toBeUndefined();
    expect(res.headers['x-vercel-id']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rewrites upstream redirects to our own host', async () => {
    const ref = await makeRef();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: `https://upstream.test/pay/${ref}?x=1` } })));
    const res = await request(app).get(`/pay/${ref}`);
    expect(res.status).toBeLessThan(400);
    if (res.headers.location) expect(res.headers.location).not.toContain('upstream.test');
  });

  it('404s unknown, malformed and non-payment paths without calling upstream', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await request(app).get('/pay/SP000000000000000000000000')).status).toBe(404);
    expect((await request(app).get('/pay/not-a-ref')).status).toBe(404);
    expect((await request(app).get('/gen/pay')).status).toBe(404);
    expect((await request(app).get('/verify/SP000000000000000000000000')).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects path traversal', async () => {
    const ref = await makeRef();
    const f = vi.fn(async () => html('ok'));
    vi.stubGlobal('fetch', f);
    const res = await request(app).get(`/pay/${ref}/..%2f..%2fgen%2fpay`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
