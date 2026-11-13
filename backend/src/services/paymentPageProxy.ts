import { env, paymentBaseUrl } from '../config/env';
import { AppError, notFound } from '../lib/errors';
import { logger } from '../lib/logger';

/**
 * Serves the customer-facing payment page THROUGH ShreePay's own domain so the upstream host is never
 * visible in the address bar, links, redirects or response headers.
 *
 *  - only GET, only the paths below, only the configured upstream origin (no open proxy / SSRF)
 *  - upstream response headers are dropped (server, x-powered-by, platform headers, set-cookie, ...); only content-type is kept
 *  - text bodies (HTML/JS/JSON/CSS/SVG) have every occurrence of the upstream host rewritten to ours
 *  - upstream redirects are rewritten onto our domain; redirects elsewhere are refused
 */
export const REF_RE = /^SP[0-9A-F]{24}$/;
const TEXTUAL = /^(text\/|application\/(json|javascript|x-javascript|xml)|image\/svg)/i;
const MAX_BYTES = 5 * 1024 * 1024;
const RESERVED = ['/auth/', '/admin/', '/api/', '/pay/', '/health', '/gen/'];

const upstreamBase = () => new URL(env.UPSTREAM_PAYMENT_API_URL.replace(/\/+$/, '') + '/');

/** Extra upstream path prefixes (assets, status polling) the payment page may need. Never includes /gen/. */
export const passthroughPrefixes = env.UPSTREAM_PASSTHROUGH_PREFIXES.split(',')
  .map((s) => s.trim())
  .filter((p) => p.length > 1 && p.startsWith('/') && p.endsWith('/') && !RESERVED.some((r) => p.startsWith(r) || r.startsWith(p)));

export const isPaymentPath = (path: string) => path.startsWith('/pay/') || passthroughPrefixes.some((p) => path.startsWith(p));

/** Strict path hygiene: no traversal, no encoded slashes/dots, no backslashes, bounded length. */
export function isSafeUrl(raw: string): boolean {
  if (raw.length > 2048 || /[\s\\#]/.test(raw)) return false;
  const path = raw.split('?', 1)[0];
  if (!/^\/[A-Za-z0-9._~\-/%]*$/.test(path)) return false;
  return !/\.\.|\/\/|%2e|%2f|%5c|%00/i.test(path);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function rewrite(body: string): string {
  const up = upstreamBase();
  const ours = new URL(paymentBaseUrl);
  return body
    .replace(new RegExp(`https?:(?:\\\\?/){2}${esc(up.host)}`, 'gi'), ours.origin) // https://host and https:\/\/host
    .replace(new RegExp(esc(up.host), 'gi'), ours.host); // bare host mentions
}

export interface ProxyResult {
  status: number;
  contentType: string | null;
  body: string | Buffer;
  location?: string;
}

export async function fetchResource(raw: string): Promise<ProxyResult> {
  const base = upstreamBase();
  const url = new URL(raw, base);
  if (url.origin !== base.origin) throw notFound();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*', 'user-agent': 'ShreePay/1.0' },
      signal: AbortSignal.timeout(env.UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'payment page proxy failed');
    throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'Payment service temporarily unavailable');
  }

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    let target: URL | null = null;
    try { target = loc ? new URL(loc, url) : null; } catch { target = null; }
    if (!target || target.origin !== base.origin) throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Unexpected payment service response');
    return { status: res.status, contentType: null, body: '', location: paymentBaseUrl + target.pathname + target.search };
  }
  if (res.status >= 500) throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'Payment service temporarily unavailable');

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new AppError(502, 'UPSTREAM_INVALID_RESPONSE', 'Unexpected payment service response');
  const contentType = res.headers.get('content-type');
  if (contentType && TEXTUAL.test(contentType)) return { status: res.status, contentType, body: rewrite(buf.toString('utf8')) };
  return { status: res.status, contentType, body: buf };
}
