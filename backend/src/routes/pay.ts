import { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/http';
import { notFound } from '../lib/errors';
import { paymentHostname, splitPaymentHost } from '../config/env';
import { payLimiter } from '../middleware/rateLimit';
import { kickAutoVerify } from '../services/autoVerifyService';
import { fetchResource, isPaymentPath, isSafeUrl, passthroughPrefixes, REF_RE } from '../services/paymentPageProxy';

/**
 * When PAYMENT_PAGE_BASE_URL uses a different host than the API (recommended), each host only serves its
 * own routes: the payment host serves nothing but payment pages, the API host serves no payment pages.
 * Cookies (host-only, __Host- prefixed) are therefore never sent to the origin that renders upstream content.
 */
export function hostGuard(req: Request, res: Response, next: NextFunction) {
  if (!splitPaymentHost) return next();
  const onPayHost = req.hostname === paymentHostname;
  const payPath = isPaymentPath(req.path);
  if (onPayHost !== payPath) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  }
  next();
}

// The payment page needs inline scripts/styles and https assets. This relaxed policy applies ONLY to these routes.
const PAGE_CSP =
  "default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; " +
  "img-src 'self' data: blob: https:; font-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/** Only orders that exist in OUR database (unguessable 96-bit reference) can be opened. */
const gate = asyncHandler(async (req, _res, next) => {
  const ref = String(req.params.ref);
  if (!REF_RE.test(ref)) throw notFound('Payment not found');
  const order = await prisma.paymentOrder.findUnique({ where: { upstreamOrderId: ref }, select: { id: true } });
  if (!order) throw notFound('Payment not found');
  next();
});

/** The customer's page polls /verify/<ref>; use that as a trigger to credit the merchant immediately. */
const autoVerify = (req: Request, res: Response, next: NextFunction) => {
  const ref = String(req.params.ref ?? '');
  if (REF_RE.test(ref)) res.on('finish', () => void kickAutoVerify(ref).catch(() => undefined));
  next();
};

const serve = asyncHandler(async (req, res) => {
  const raw = req.originalUrl;
  if (!isSafeUrl(raw)) throw notFound();
  const r = await fetchResource(raw);
  if (r.location) {
    res.redirect(r.status, r.location);
    return;
  }
  const ct = r.contentType ?? '';
  const isHtml = /html/i.test(ct);
  res.status(r.status);
  if (r.contentType) res.setHeader('Content-Type', r.contentType);
  res.setHeader('Cache-Control', isHtml || /json/i.test(ct) ? 'no-store' : 'public, max-age=300');
  if (isHtml) res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.send(r.body);
});

const router = Router();
router.get('/pay/:ref', payLimiter, gate, serve);
router.get('/pay/:ref/*', payLimiter, gate, serve);
if (passthroughPrefixes.includes('/verify/')) router.get('/verify/:ref', payLimiter, gate, autoVerify, serve);
for (const p of passthroughPrefixes.filter((x) => x !== '/verify/')) router.get(`${p}*`, payLimiter, serve);

export default router;
