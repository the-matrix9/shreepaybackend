# ShreePay

Payment-verification SaaS and merchant ledger. Merchants create payment links through the ShreePay API, customers pay on a ShreePay-hosted payment page, ShreePay verifies the payment server-side against a private upstream verification API and credits the merchant's ledger. Withdrawals are **requested by merchants and paid manually by an admin**. ShreePay never moves money automatically.

```
Merchant ──API key──▶ ShreePay backend ──▶ upstream /gen/pay, /verify   (private; backend only)
Browser (React) ─────▶ ShreePay backend                                   (never talks to upstream)
Customer ────────────▶ <PAYMENT_PAGE_BASE_URL>/pay/<ref>  (backend proxies the page; upstream domain is never exposed)
```

## Layout

```
shreepay/
├─ backend/   Express + TypeScript + Prisma (PostgreSQL)
│  ├─ prisma/schema.prisma
│  ├─ src/{config,controllers,services,middleware,routes,validators,lib,jobs,scripts}
│  └─ tests/  (Vitest + Supertest, real Postgres)
├─ frontend/  React + Vite + Tailwind + TanStack Query
├─ docker-compose.yml   .env.example
```

Key files: `backend/src/services/famPayService.ts` (upstream adapter), `paymentService.ts` (create/verify + exactly-once credit), `walletService.ts` (atomic balance changes), `withdrawalService.ts` (reserve/release/paid state machine).

## Setup

Requirements: Node 20+, PostgreSQL 14+ (or Docker).

**A. Start PostgreSQL**
```bash
cp .env.example .env     # set POSTGRES_PASSWORD, then use the same password in DATABASE_URL
docker compose up -d postgres
```

**B. Configure and run migrations**
```bash
cp .env.example backend/.env
# edit backend/.env: DATABASE_URL, SESSION_SECRET, COOKIE_SECRET (openssl rand -base64 48), ADMIN_EMAIL, ADMIN_PASSWORD
cd backend && npm install
npx prisma migrate dev --name init     # first time only: creates + commits the initial migration (see prisma/migrations/README.md)
# later / production:  npx prisma migrate deploy
```

**C. Start the backend** (`http://localhost:4000`, health: `GET /health`)
```bash
npm run dev                            # development
npm run build && npm start             # production
```

**D. Start the frontend** (`http://localhost:5173`)
```bash
cd frontend && cp .env.example .env && npm install && npm run dev
```

**E. Create the first admin**
```bash
cd backend && npm run create-admin     # uses ADMIN_EMAIL / ADMIN_PASSWORD (12+ chars, upper+lower+digit)
```
Then sign in at `http://localhost:5173/admin/login` and remove `ADMIN_PASSWORD` from your environment. In production: `npm run create-admin:prod`.

## Merchant walkthrough

**F. Register**: `http://localhost:5173/register`. A 6-digit code is emailed (Gmail SMTP or any SMTP); entering it on `/verify-email` activates the account, creates the session, merchant profile and an empty wallet. Codes are HMAC-hashed, expire in `OTP_TTL_MIN`, allow `OTP_MAX_ATTEMPTS` tries, resend cooldown `OTP_RESEND_COOLDOWN_SEC`; unverified accounts are purged after 24h. Add your UPI ID under *Settings*.

**G. Create an API key**: *API Keys → Create API key*. The full `sk_live_…` key is shown **once**; only its SHA-256 hash is stored.

**H. Create a payment**
```bash
curl -X POST http://localhost:4000/api/v1/payments/create \
  -H "Authorization: Bearer sk_live_xxxxx" -H "Content-Type: application/json" \
  -d '{"orderId":"ORDER123","amount":500}'
```
The backend calls the upstream `/gen/pay` with a unique internal reference and returns `paymentUrl` (`<PAYMENT_PAGE_BASE_URL>/pay/<ref>`). That URL is served by ShreePay itself (reverse proxy: GET only, allowlisted paths, headers scrubbed, upstream host rewritten), so the upstream domain never reaches the customer's browser.

**I. Customer pays**: they open `paymentUrl` and complete the payment on that page.

**J. Verify**
```bash
curl -X POST http://localhost:4000/api/v1/payments/verify \
  -H "Authorization: Bearer sk_live_xxxxx" -H "Content-Type: application/json" \
  -d '{"orderId":"ORDER123"}'
```
The backend calls upstream `/verify/<ref>`, validates the response (status, order id, amount) and returns `status: "VERIFIED"` only if it is genuinely paid.

**K. Balance credit**: in one DB transaction the order flips to `VERIFIED` (compare-and-set), a `Transaction` row is created, a `CREDIT` ledger entry is written and the wallet is incremented. Verifying again, even 10 times in parallel, returns the same transaction and never credits twice (unique constraints + the compare-and-set).

**L. Request a withdrawal**: *Withdrawals* page (session login only, API keys cannot do this). The amount is moved from available to reserved (`RESERVE`), the UPI ID is snapshotted.

**M. Admin pays**: *Admin → Withdrawals*: **Approve** (→ `PROCESSING`), transfer the money yourself via your bank/UPI app, then **Mark as paid** and confirm *"Confirm that ₹500 has been manually transferred to john@upi."* (→ `PAID`, reserved → withdrawn, `DEBIT` entry, admin ID + time + note stored). **Reject** releases the reserved amount (`RELEASE`). Every action writes an `AdminActionLog`.

## Security model (summary)

- Upstream URL only from `UPSTREAM_PAYMENT_API_URL`; only the backend calls it. Responses are untrusted: strict status mapping, order-id echo check, amount comparison, same-origin URL check, non-JSON ignored, timeouts + bounded retries (verify: 1 retry).
- Orders are looked up by `(userId, orderId)`. The id sent upstream is a random per-order reference, so merchants can't collide or verify each other's orders; foreign references return `403 ORDER_ACCESS_DENIED`.
- Money is `BigInt` paise end to end; amounts are parsed from decimal strings (no floats). Balance changes use conditional `UPDATE … WHERE balance >= amount` inside transactions; DB unique constraints back up the one-credit-per-order and one-ledger-entry-per-event rules.
- Web auth: Argon2id, opaque server-side sessions in an HttpOnly + signed + SameSite=Lax cookie (Secure in production), no JWT in browser storage, per-account lockout, per-IP rate limits, strict Origin check on cookie-authenticated writes (CSRF). Key management, profile and withdrawals are session-only, so a leaked API key can't redirect payouts.
- Helmet (CSP, frame, nosniff, referrer, HSTS in prod), CORS allowlist from `FRONTEND_URL`, Zod `.strict()` validation, 20 KB body limit, generic 500s, pino redaction of auth headers/cookies, IPs and user-agents stored as keyed hashes.
- Upstream domain is hidden: payment pages are proxied; set `PAYMENT_PAGE_BASE_URL` to a separate host (e.g. `https://pay.example.com`) so upstream-rendered HTML never shares an origin with API cookies.
- Scale hardening: Argon2 concurrency limiter (`HASH_CONCURRENCY`), session cap per user, buffered API-log writes, DB advisory-lock maintenance job, optional Redis-backed rate limits (`REDIS_URL`), admin IP allowlist (`ADMIN_ALLOWED_IPS`), common-password rejection, server timeouts, extra DB indexes.
- All limits are configurable via env (`AUTH_RATE_LIMIT`, `API_RATE_LIMIT`, `VERIFY_RATE_LIMIT`, `ADMIN_RATE_LIMIT`, …).

## Things you must decide / verify before going live

1. **Upstream response shape.** The adapter recognises common status names (`paid`, `success`, `verified`, `completed`, …) and amount/reference fields, but it was written without a sample of the real `/verify` output. Call your upstream's `/verify/<some-order>` once and, if the field names differ, adjust the maps at the top of `famPayService.ts` (and `tests/upstream.test.ts`). Unknown responses are treated as **not paid**, never as paid.
2. **Payment page proxy.** It was written without seeing the upstream page's HTML. If the page loads assets/APIs from other paths, add their prefixes to `UPSTREAM_PASSTHROUGH_PREFIXES`.
3. **Amount confirmation.** By default (`UPSTREAM_REQUIRE_AMOUNT=true`) a payment is credited only if upstream returns an amount equal to the order amount. Set `false` only if upstream never returns an amount.
4. **UPI IDs** are format-checked only (`upiVerified` stays `false`); changing the UPI pauses withdrawals for `UPI_CHANGE_COOLDOWN_HOURS`.
5. **Rate limiting** is in-memory unless `REDIS_URL` is set. Use Redis for more than one instance. Set `TRUST_PROXY` to the number of proxies in front of the API.
6. Serve frontend and API on the same registrable domain (e.g. `app.example.com` / `api.example.com`) so the SameSite=Lax cookie is sent, over HTTPS in production.
7. **Email OTP** needs SMTP. Gmail: 2-Step Verification → App Password → `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER`, `SMTP_PASSWORD`. **Gmail caps at ~500 mails/day (~2000 Workspace)**, far below 1 lakh signups: switch to SES / Brevo / Resend / Mailgun SMTP (same variables) before launch. Not included: CAPTCHA (add Cloudflare Turnstile on register/login) and admin 2FA.
8. **Migrations.** Models changed (EmailOtp etc.). Delete any old `prisma/migrations` folder from dev and run `npx prisma migrate dev --name init` on a fresh, dedicated database.

## Tests

```bash
cd backend
# needs a Postgres reachable at TEST_DATABASE_URL (database name must contain "test"; it is wiped)
export TEST_DATABASE_URL=postgresql://shreepay:CHANGE_ME@localhost:5432/shreepay_test
npm test
```
Covers registration/login/logout, lockout, CSRF/CORS, API key creation + auth + revocation, payment creation, verification, duplicate/parallel verification (exactly one credit), amount mismatch, order ownership, merchant isolation, ledger reconciliation, withdrawal request/reserve/cancel/reject/paid, concurrent double-withdrawal, admin authorization, rate limiting, upstream adapter + failure handling, idempotency. The upstream is mocked; the adapter itself is tested against a stubbed `fetch`.

## Deployment

```bash
docker compose up -d --build           # postgres + redis + backend (:4000) + frontend (:5173)
```
Or deploy each part separately: backend `npm install && npm run build && npm start` (run `npx prisma migrate deploy` first); frontend `npm install && npm run build` and serve `frontend/dist` as a static SPA (rewrite all routes to `index.html`; set `VITE_API_URL` at build time). Update the `connect-src` in `frontend/nginx.conf` to your API origin.
