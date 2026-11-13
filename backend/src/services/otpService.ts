import { randomInt, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/errors';
import { hmac } from '../lib/crypto';
import { logger } from '../lib/logger';
import { sendMail } from '../lib/mailer';
import { ReqCtx, securityEvent } from './auditService';

const hashCode = (userId: string, code: string) => hmac(`otp:${userId}:${code}`);

/** Throws if a code was sent too recently, or too many were requested this hour. Call BEFORE mutating anything. */
export async function assertCanSend(userId: string) {
  const last = await prisma.emailOtp.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  if (last) {
    const waitMs = env.OTP_RESEND_COOLDOWN_SEC * 1000 - (Date.now() - last.createdAt.getTime());
    if (waitMs > 0) {
      const retryAfter = Math.ceil(waitMs / 1000);
      throw new AppError(429, 'OTP_COOLDOWN', `Please wait ${retryAfter}s before requesting another code`, { retryAfter });
    }
  }
  const lastHour = await prisma.emailOtp.count({ where: { userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (lastHour >= env.OTP_HOURLY_LIMIT) throw new AppError(429, 'OTP_LIMIT', 'Too many codes requested. Please try again later.');
}

const emailHtml = (name: string, code: string) => `<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:Segoe UI,Arial,sans-serif;color:#14120f">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="480" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #e6e3dd" cellpadding="0" cellspacing="0"><tr><td style="padding:32px">
<div style="font-size:18px;font-weight:700;color:#0f766e">ShreePay</div>
<p style="font-size:15px;margin:24px 0 8px">Hi ${name.replace(/[<>&"]/g, '')},</p>
<p style="font-size:15px;margin:0 0 20px;color:#6b6760">Use this code to verify your email address:</p>
<div style="font-size:34px;letter-spacing:10px;font-weight:700;background:#f2f0ec;border-radius:12px;text-align:center;padding:16px 0">${code}</div>
<p style="font-size:13px;color:#6b6760;margin:20px 0 0">This code expires in ${env.OTP_TTL_MIN} minutes. If you didn't create a ShreePay account, you can ignore this email. Never share this code with anyone.</p>
</td></tr></table></td></tr></table></body></html>`;

/** Creates a fresh code (invalidating older ones) and emails it. Returns false if the email could not be sent. */
export async function sendOtp(user: { id: string; email: string; name: string }, ctx?: ReqCtx): Promise<boolean> {
  await assertCanSend(user.id);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await prisma.$transaction([
    prisma.emailOtp.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } }),
    prisma.emailOtp.create({ data: { userId: user.id, codeHash: hashCode(user.id, code), expiresAt: new Date(Date.now() + env.OTP_TTL_MIN * 60_000) } }),
  ]);
  try {
    await sendMail(
      user.email,
      `${code} is your ShreePay verification code`,
      `Your ShreePay verification code is ${code}. It expires in ${env.OTP_TTL_MIN} minutes. If you didn't request it, ignore this email.`,
      emailHtml(user.name, code),
    );
    await securityEvent(user.id, 'EMAIL_OTP_SENT', ctx);
    return true;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'failed to send OTP email');
    await securityEvent(user.id, 'EMAIL_OTP_SEND_FAILED', ctx);
    return false;
  }
}

/** Validates and consumes the newest code. Attempts are counted atomically BEFORE comparing (no parallel brute force). */
export async function consumeOtp(userId: string, code: string) {
  const otp = await prisma.emailOtp.findFirst({ where: { userId, consumedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!otp || otp.expiresAt <= new Date()) throw new AppError(400, 'OTP_EXPIRED', 'This code has expired. Request a new one.');

  const bumped = await prisma.emailOtp.updateMany({
    where: { id: otp.id, consumedAt: null, attempts: { lt: env.OTP_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (bumped.count !== 1) throw new AppError(429, 'OTP_LOCKED', 'Too many wrong attempts. Request a new code.');

  const a = Buffer.from(hashCode(userId, code), 'hex');
  const b = Buffer.from(otp.codeHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(400, 'INVALID_OTP', 'Incorrect code');

  const used = await prisma.emailOtp.updateMany({ where: { id: otp.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (used.count !== 1) throw new AppError(400, 'INVALID_OTP', 'Incorrect code');
}
