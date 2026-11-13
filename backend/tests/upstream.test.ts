import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRupeesToPaise, paiseToRupeesString } from '../src/lib/money';

// The global setup mocks famPayService; here we want the REAL adapter with a stubbed network.
type Fam = typeof import('../src/services/famPayService');
let fam: Fam;
beforeAll(async () => {
  fam = await vi.importActual<Fam>('../src/services/famPayService');
});
afterEach(() => vi.unstubAllGlobals());

const ID = 'SP0123456789ABCDEF01234567';
const reply = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const stubFetch = (...responses: Array<Response | Error>) => {
  const f = vi.fn();
  responses.forEach((r) => (r instanceof Error ? f.mockRejectedValueOnce(r) : f.mockResolvedValueOnce(r)));
  vi.stubGlobal('fetch', f);
  return f;
};

describe('money', () => {
  it('parses rupees to paise without floating point', () => {
    expect(parseRupeesToPaise(500)).toBe(50000n);
    expect(parseRupeesToPaise('19.99')).toBe(1999n);
    expect(parseRupeesToPaise(0.1)).toBe(10n);
    expect(parseRupeesToPaise('0.07')).toBe(7n);
    for (const bad of [-1, '-1', 1.234, 1e21, NaN, Infinity, '', ' ', '1,000', '1e3', '12345678901']) expect(parseRupeesToPaise(bad as never)).toBeNull();
    expect(paiseToRupeesString(1999n)).toBe('19.99');
    expect(paiseToRupeesString(5n)).toBe('0.05');
  });
});

describe('Upstream adapter', () => {
  it('builds the generate URL from UPSTREAM_PAYMENT_API_URL and falls back to the upstream payment page', async () => {
    const f = stubFetch(reply({ status: 'created' }));
    const r = await fam.generatePayment(ID, 50000n);
    expect(String(f.mock.calls[0][0])).toBe(`https://upstream.test/gen/pay?orderid=${ID}&amount=500`);
    expect(r.paymentUrl).toBe(`https://upstream.test/pay/${ID}`);
  });

  it('ignores payment URLs that point outside the upstream origin', async () => {
    stubFetch(reply({ status: 'created', payment_url: 'https://evil.example/pay' }));
    expect((await fam.generatePayment(ID, 10000n)).paymentUrl).toBe(`https://upstream.test/pay/${ID}`);
  });

  it('rejects malformed order ids before any request is made', async () => {
    const f = stubFetch();
    await expect(fam.verifyPayment('../../admin')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(f).not.toHaveBeenCalled();
  });

  it('normalizes a paid response', async () => {
    stubFetch(reply({ status: 'PAID', orderId: ID, amount: '500.00', utr: 'UTR1234567890' }));
    const r = await fam.verifyPayment(ID);
    expect(r).toMatchObject({ status: 'VERIFIED', amountPaise: 50000n, externalTransactionId: 'UTR1234567890', rawStatus: 'PAID' });
  });

  it('understands nested data envelopes', async () => {
    stubFetch(reply({ success: true, data: { payment_status: 'success', amount: 12.5 } }));
    const r = await fam.verifyPayment(ID);
    expect(r.status).toBe('VERIFIED');
    expect(r.amountPaise).toBe(1250n);
  });

  it('never treats a bare success:true, an unknown status or a non-JSON body as paid', async () => {
    stubFetch(reply({ success: true }), reply({ status: 'something-new' }), reply('<html>oops</html>'));
    expect((await fam.verifyPayment(ID)).status).toBe('UNKNOWN');
    expect((await fam.verifyPayment(ID)).status).toBe('UNKNOWN');
    expect((await fam.verifyPayment(ID)).status).not.toBe('VERIFIED');
  });

  it('does not accept a "paid" envelope that reports an error or success:false', async () => {
    stubFetch(reply({ success: false, status: 'paid' }));
    expect((await fam.verifyPayment(ID)).status).not.toBe('VERIFIED');
  });

  it('rejects responses that answer for a different order', async () => {
    stubFetch(reply({ status: 'paid', orderId: 'SOMEONEELSE123', amount: 500 }));
    await expect(fam.verifyPayment(ID)).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });

  it('maps 404 to NOT_FOUND and failures to FAILED', async () => {
    stubFetch(reply({ error: 'order not found' }, 404), reply({ status: 'failed' }));
    expect((await fam.verifyPayment(ID)).status).toBe('NOT_FOUND');
    expect((await fam.verifyPayment(ID)).status).toBe('FAILED');
  });

  it('retries a limited number of times with backoff, then reports UPSTREAM_UNAVAILABLE', async () => {
    const f = stubFetch(reply('boom', 503), reply('boom', 503), reply('boom', 503), reply('boom', 503));
    await expect(fam.verifyPayment(ID)).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_UNAVAILABLE' });
    expect(f).toHaveBeenCalledTimes(2); // UPSTREAM_VERIFY_RETRIES=1 -> 1 try + 1 retry, never indefinite
  });

  it('treats timeouts / network errors as UPSTREAM_UNAVAILABLE', async () => {
    stubFetch(new Error('network down'), new Error('network down'));
    await expect(fam.verifyPayment(ID)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('refuses generate responses that report failure', async () => {
    stubFetch(reply({ success: false, error: 'bad amount' }));
    await expect(fam.generatePayment(ID, 100n)).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED' });
  });
});
