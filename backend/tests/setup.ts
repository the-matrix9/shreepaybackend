import { vi } from 'vitest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://shreepay:shreepay@localhost:5432/shreepay_test',
  FRONTEND_URL: 'http://localhost:5173',
  BACKEND_URL: 'http://localhost:4000',
  UPSTREAM_PAYMENT_API_URL: 'https://upstream.test',
  SESSION_SECRET: 'test-session-secret-test-session-secret',
  COOKIE_SECRET: 'test-cookie-secret-test-cookie-secret-x',
  MIN_WITHDRAWAL: '100',
  AUTH_RATE_LIMIT: process.env.AUTH_RATE_LIMIT ?? '1000',
  API_RATE_LIMIT: '1000',
  VERIFY_RATE_LIMIT: process.env.VERIFY_RATE_LIMIT ?? '30',
  ADMIN_RATE_LIMIT: '1000',
  UPI_CHANGE_COOLDOWN_HOURS: '0',
  OTP_RESEND_COOLDOWN_SEC: '60',
  OTP_MAX_ATTEMPTS: '5',
  OTP_RATE_LIMIT: '1000',
  PAY_RATE_LIMIT: '1000',
});

// The real upstream is never contacted in tests. (famPayService itself is unit-tested in upstream.test.ts via importActual.)
vi.mock('../src/services/famPayService', () => ({
  getPaymentPage: (id: string) => `https://upstream.test/pay/${id}`,
  generatePayment: vi.fn(async (id: string) => ({
    success: true, orderId: id, amountPaise: null, status: 'PENDING', rawStatus: 'pending',
    externalTransactionId: null, verifiedAt: null, paymentUrl: `https://upstream.test/pay/${id}`, raw: {},
  })),
  verifyPayment: vi.fn(),
}));

// Mail is captured in memory instead of being sent.
(globalThis as any).__mails = [] as { to: string; subject: string; text: string }[];
vi.mock('../src/lib/mailer', () => ({
  sendMail: vi.fn(async (to: string, subject: string, text: string) => { (globalThis as any).__mails.push({ to, subject, text }); }),
}));
