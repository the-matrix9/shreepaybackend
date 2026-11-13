import { env } from '../config/env';
import { AppError, upstreamUnavailable } from '../lib/errors';
import { logger } from '../lib/logger';
import { paiseToRupeesString, parseRupeesToPaise } from '../lib/money';

/**
 * Adapter for the upstream payment verification API.
 * Only the backend talks to it. Every upstream field is treated as untrusted input.
 *
 *   generate:     GET /gen/pay?orderid=&amount=
 *   verify:       GET /verify/:orderId
 *   payment page: GET /pay/:orderId
 */
const UPSTREAM_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_BODY_CHARS = 100_000;

const base = () => env.UPSTREAM_PAYMENT_API_URL.replace(/\/+$/, '');
const upstreamOrigin = () => new URL(base()).origin;

export type NormalizedStatus = 'VERIFIED' | 'PENDING' | 'FAILED' | 'EXPIRED' | 'NOT_FOUND' | 'UNKNOWN';

export interface NormalizedPayment {
  success: boolean; // upstream replied sanely (NOT "payment paid")
  orderId: string | null;
  amountPaise: bigint | null;
  status: NormalizedStatus;
  rawStatus: string | null;
  externalTransactionId: string | null;
  verifiedAt: string | null;
  paymentUrl: string | null;
  raw: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url: string, retries: number): Promise<{ status: number; body: unknown }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'ShreePay/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(env.UPSTREAM_TIMEOUT_MS),
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`upstream_status_${res.status}`);
      const text = (await res.text()).slice(0, MAX_BODY_CHARS);
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null; // non-JSON (HTML error page etc.) is never trusted
      }
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 150)); // exponential backoff + jitter
    }
  }
  logger.warn({ err: (lastErr as Error)?.message }, 'upstream request failed');
  throw upstreamUnavailable();
}

/* ---------- normalization helpers ---------- */

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Merge top-level + nested data/result objects into one lowercase-keyed view. */
function flatten(body: unknown): Dict {
  const out: Dict = {};
  if (!isDict(body)) return out;
  const add = (o: Dict) => {
    for (const [k, v] of Object.entries(o)) if (!(k.toLowerCase() in out)) out[k.toLowerCase()] = v;
  };
  add(body);
  for (const k of ['data', 'result', 'payment', 'transaction']) {
    const nested = body[k];
    if (isDict(nested)) add(nested);
  }
  return out;
}

const first = (o: Dict, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

const SUCCESS = new Set(['success', 'succeeded', 'successful', 'paid', 'verified', 'completed', 'complete', 'captured', 'credited', 'received', 'settled']);
const FAILED = new Set(['failed', 'failure', 'declined', 'cancelled', 'canceled', 'rejected', 'error']);
const EXPIRED = new Set(['expired', 'timeout', 'timed_out']);
const PENDING = new Set(['pending', 'created', 'initiated', 'processing', 'unpaid', 'waiting', 'open', 'awaiting_payment', 'not_paid']);
const NOT_FOUND = new Set(['not_found', 'notfound', 'invalid_order', 'unknown_order']);

function mapStatus(v: Dict): { status: NormalizedStatus; raw: string | null } {
  const rawVal = first(v, ['status', 'payment_status', 'paymentstatus', 'txn_status', 'transaction_status', 'state']);
  if (typeof rawVal === 'string') {
    const s = rawVal.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const raw = rawVal.slice(0, 64);
    if (SUCCESS.has(s)) return { status: 'VERIFIED', raw };
    if (FAILED.has(s)) return { status: 'FAILED', raw };
    if (EXPIRED.has(s)) return { status: 'EXPIRED', raw };
    if (PENDING.has(s)) return { status: 'PENDING', raw };
    if (NOT_FOUND.has(s)) return { status: 'NOT_FOUND', raw };
    return { status: 'UNKNOWN', raw };
  }
  // No status string: accept ONLY explicit paid/verified booleans. A bare `success: true` means
  // "request ok", not "money received", so it never verifies a payment.
  const flag = first(v, ['paid', 'is_paid', 'verified', 'payment_verified']);
  if (flag === true) return { status: 'VERIFIED', raw: 'flag:true' };
  if (flag === false) return { status: 'PENDING', raw: 'flag:false' };
  return { status: 'UNKNOWN', raw: null };
}

function normalize(body: unknown, httpStatus: number): NormalizedPayment {
  const v = flatten(body);
  const { status, raw } = mapStatus(v);

  // Prefer the amount actually RECEIVED (received_amount); fall back to the order amount.
  const amountRaw = first(v, ['received_amount', 'amount_paid', 'paid_amount', 'txn_amount', 'amount', 'total']);
  const amountPaise =
    typeof amountRaw === 'number' || typeof amountRaw === 'string' ? parseRupeesToPaise(amountRaw) : null;

  const idRaw = first(v, ['orderid', 'order_id']);
  const orderId = typeof idRaw === 'string' && UPSTREAM_ID_RE.test(idRaw) ? idRaw : null;

  const txnRaw = first(v, ['utr', 'rrn', 'transaction_id', 'transactionid', 'txn_id', 'txnid', 'reference_id', 'reference', 'upi_ref']);
  const externalTransactionId =
    (typeof txnRaw === 'string' || typeof txnRaw === 'number') && /^[A-Za-z0-9_-]{6,64}$/.test(String(txnRaw))
      ? String(txnRaw)
      : null;

  const tRaw = first(v, ['verified_at', 'verifiedat', 'paid_at', 'paidat', 'timestamp', 'time']);
  const d = typeof tRaw === 'string' || typeof tRaw === 'number' ? new Date(tRaw) : null;
  const verifiedAt = d && !isNaN(d.getTime()) ? d.toISOString() : null;

  const urlRaw = first(v, ['payment_url', 'paymenturl', 'payment_link', 'url', 'link']);
  let paymentUrl: string | null = null;
  if (typeof urlRaw === 'string') {
    try {
      const u = new URL(urlRaw);
      if (u.origin === upstreamOrigin()) paymentUrl = u.toString(); // only ever our upstream's origin
    } catch {
      /* ignore */
    }
  }

  const explicitFailure = v['success'] === false || v['error'] !== undefined;
  return {
    success: httpStatus >= 200 && httpStatus < 300 && !explicitFailure && isDict(body),
    orderId,
    amountPaise,
    status: httpStatus === 404 ? 'NOT_FOUND' : status,
    rawStatus: raw,
    externalTransactionId,
    verifiedAt,
    paymentUrl,
    raw: isDict(body) ? body : null,
  };
}

/* ---------- public API ---------- */

const assertUpstreamId = (id: string) => {
  if (!UPSTREAM_ID_RE.test(id)) throw new AppError(400, 'INVALID_REQUEST', 'Invalid order id');
};

export function getPaymentPage(orderId: string): string {
  assertUpstreamId(orderId);
  return `${base()}/pay/${encodeURIComponent(orderId)}`;
}

export async function generatePayment(orderId: string, amountPaise: bigint): Promise<NormalizedPayment> {
  assertUpstreamId(orderId);
  const amount = amountPaise % 100n === 0n ? String(amountPaise / 100n) : paiseToRupeesString(amountPaise);
  const qs = new URLSearchParams({ orderid: orderId, amount });
  const { status, body } = await httpGet(`${base()}/gen/pay?${qs.toString()}`, env.UPSTREAM_GENERATE_RETRIES);
  const n = normalize(body, status);
  // Generation succeeded if upstream answered 2xx with a sane body that doesn't report failure.
  if (!n.success || n.status === 'FAILED') {
    throw new AppError(502, 'UPSTREAM_REJECTED', 'Payment service could not create this order');
  }
  if (n.orderId && n.orderId !== orderId) {
    throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Unexpected payment service response');
  }
  return { ...n, paymentUrl: n.paymentUrl ?? getPaymentPage(orderId) };
}

export async function verifyPayment(orderId: string): Promise<NormalizedPayment> {
  assertUpstreamId(orderId);
  const { status, body } = await httpGet(`${base()}/verify/${encodeURIComponent(orderId)}`, env.UPSTREAM_VERIFY_RETRIES);
  const n = normalize(body, status);
  if (n.orderId && n.orderId !== orderId) {
    // Upstream answered about a different order: never trust it.
    throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Unexpected payment service response');
  }
  if (!n.success && n.status !== 'NOT_FOUND' && n.status !== 'FAILED') {
    return { ...n, status: n.status === 'VERIFIED' ? 'UNKNOWN' : n.status }; // never verify from a failed envelope
  }
  return n;
}
