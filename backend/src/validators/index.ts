import { z } from 'zod';
import { parseRupeesToPaise } from '../lib/money';

const COMMON_PASSWORDS = new Set([
  'password123', 'password1234', 'password12345', 'qwerty12345', 'qwertyuiop1', 'welcome123', 'welcome1234',
  'admin12345', 'admin123456', 'letmein1234', 'iloveyou123', 'changeme123', 'passw0rd123', 'abcd123456', '1234567890a',
  'india123456', 'shreepay123', 'test1234567',
]);
export const emailSchema =z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/[0-9]/, 'Password needs a digit')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'That password is too common');
export const phoneSchema = z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Invalid phone number');
export const orderIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{3,64}$/, 'orderId must be 3-64 characters: letters, digits, "_" or "-"');
export const upiSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{1,32}$/, 'Invalid UPI ID (expected name@bank)');

/** Rupees as number or decimal string -> BigInt paise. Max 2 decimals, no exponents, no negatives. */
export const amountSchema = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const p = parseRupeesToPaise(v);
  if (p === null || p <= 0n) {
    ctx.addIssue({ code: 'custom', message: 'Amount must be a positive number with at most 2 decimals' });
    return z.NEVER;
  }
  return p;
});

export const registerBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    password: passwordSchema,
    phone: phoneSchema.optional(),
    businessName: z.string().trim().min(2).max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    const local = v.email.split('@')[0];
    if (local.length >= 4 && v.password.toLowerCase().includes(local)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: 'Password must not contain your email name' });
    }
  });
export const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
export const forgotBody = z.object({ email: emailSchema }).strict();
export const resetBody = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict();
export const verifyEmailBody = z.object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict();
export const resendOtpBody = z.object({ email: emailSchema }).strict();

export const createPaymentBody = z.object({ orderId: orderIdSchema, amount: amountSchema }).strict();
export const verifyPaymentBody = z.object({ orderId: z.string().trim().min(3).max(64) }).strict();
export const withdrawalBody = z.object({ amount: amountSchema, upiId: upiSchema }).strict();
export const profileBody = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: phoneSchema.nullable().optional(),
    businessName: z.string().trim().min(2).max(100).optional(),
    upiId: upiSchema.nullable().optional(),
  })
  .strict();
export const apiKeyBody = z.object({ name: z.string().trim().min(2).max(60) }).strict();

export const adminApproveBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
export const adminRejectBody = z.object({ note: z.string().trim().min(3).max(500) }).strict();
export const adminPaidBody = z.object({ confirm: z.literal(true), note: z.string().trim().max(500).optional() }).strict();
export const settingsBody = z
  .object({ min_withdrawal: z.number().int().min(1).max(1_000_000).optional(), registrations_open: z.boolean().optional() })
  .strict();

const date = z.coerce.date();
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const listQuery = pageQuery.extend({
  q: z.string().trim().max(64).optional(),
  status: z.string().trim().max(20).optional(),
  from: date.optional(),
  to: date.optional(),
  minAmount: z.string().trim().max(14).optional(),
  maxAmount: z.string().trim().max(14).optional(),
  userId: z.string().uuid().optional(),
});
export const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(366).optional(),
  from: date.optional(),
  to: date.optional(),
});
export const uuidParam = z.string().uuid();
