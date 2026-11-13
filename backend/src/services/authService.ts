import argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { env, isProd } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { hmac, randomToken, sha256 } from '../lib/crypto';
import { Semaphore } from '../lib/semaphore';
import { ReqCtx, securityEvent } from './auditService';
import { getSettings } from './settingsService';
import { sendMail } from '../lib/mailer';
import * as otp from './otpService';

// "__Host-" prefix (production): browser enforces Secure + Path=/ + no Domain, so the cookie can't be
// overwritten by sibling subdomains or sent to the separate payment-page host.
export const SESSION_COOKIE = isProd ? '__Host-sp_session' : 'sp_session';

// Argon2 is deliberately expensive; cap parallelism so a login/register flood can't exhaust CPU/RAM.
const hasher = new Semaphore(env.HASH_CONCURRENCY);
export const hashPassword = (pw: string) =>
  hasher.run(() => argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }));
const verifyPassword = (hash: string, pw: string) => hasher.run(() => argon2.verify(hash, pw).catch(() => false));

// Verified against when the email is unknown, so response time doesn't reveal which emails exist.
let dummyHash: string | null = null;
async function dummyVerify(pw: string) {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(dummyHash, pw);
}

const emailTaken = () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');

/**
 * Creates an UNVERIFIED account and emails a 6-digit code. No session is issued until the code is verified.
 * Re-registering an email that was never verified replaces the pending details (latest submission wins),
 * but only if a new code may be sent, so it can't be used to silently swap the password.
 */
export async function register(p: { name: string; email: string; password: string; phone?: string; businessName: string }, ctx: ReqCtx) {
  const settings = await getSettings();
  if (!settings.registrations_open) throw forbidden('Registrations are currently closed', 'REGISTRATIONS_CLOSED');
  const email = p.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing && (existing.emailVerified || existing.role !== 'USER')) throw emailTaken();
  if (existing) await otp.assertCanSend(existing.id);

  const passwordHash = await hashPassword(p.password);
  let user;
  try {
    user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            name: p.name, passwordHash, phone: p.phone ?? null,
            profile: { upsert: { create: { businessName: p.businessName }, update: { businessName: p.businessName } } },
          },
        })
      : await prisma.user.create({
          data: { name: p.name, email, passwordHash, phone: p.phone, profile: { create: { businessName: p.businessName } }, wallet: { create: {} } },
        });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw emailTaken();
    throw e;
  }
  await securityEvent(user.id, existing ? 'REGISTER_RESUBMIT' : 'REGISTER', ctx);
  const emailSent = await otp.sendOtp(user, ctx);
  return { user, emailSent };
}

export async function verifyEmail(email: string, code: string, ctx: ReqCtx) {
  const invalid = () => new AppError(400, 'INVALID_OTP', 'Incorrect or expired code');
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.emailVerified || user.status !== 'ACTIVE') throw invalid();
  try {
    await otp.consumeOtp(user.id, code);
  } catch (e) {
    await securityEvent(user.id, 'EMAIL_OTP_FAILED', ctx, { code: e instanceof AppError ? e.code : 'ERROR' });
    throw e;
  }
  const verified = await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, lastLoginAt: new Date() } });
  const token = await createSession(user.id, ctx);
  await securityEvent(user.id, 'EMAIL_VERIFIED', ctx);
  return { user: verified, token };
}

/** Always succeeds from the caller's view (no account enumeration); the frontend runs its own cooldown timer. */
export async function resendOtp(email: string, ctx: ReqCtx) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.emailVerified || user.status !== 'ACTIVE') return;
  try {
    await otp.sendOtp(user, ctx);
  } catch (e) {
    if (!(e instanceof AppError)) throw e; // cooldown / hourly limit: silently ignored
  }
}

export async function login(email: string, password: string, ctx: ReqCtx) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    await dummyVerify(password);
    await securityEvent(null, 'LOGIN_FAILED_UNKNOWN_EMAIL', ctx);
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await securityEvent(user.id, 'LOGIN_BLOCKED_LOCKED', ctx);
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const failures = user.failedLogins + 1;
    const lock = failures >= env.LOGIN_MAX_FAILURES;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: lock ? 0 : failures, lockedUntil: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : null },
    });
    await securityEvent(user.id, lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED', ctx);
    throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status !== 'ACTIVE') {
    await securityEvent(user.id, 'LOGIN_BLOCKED_INACTIVE', ctx);
    throw forbidden('This account is not active', 'ACCOUNT_SUSPENDED');
  }
  if (!user.emailVerified) {
    // Correct password but unverified: send a fresh code (if allowed) and make the client open the OTP screen.
    try { await otp.sendOtp(user, ctx); } catch (e) { if (!(e instanceof AppError)) throw e; }
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email. We sent you a code.');
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const token = await createSession(user.id, ctx);
  await securityEvent(user.id, 'LOGIN', ctx);
  return { user, token };
}

export async function createSession(userId: string, ctx: ReqCtx) {
  const token = randomToken(32);
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hmac(token),
      ipHash: ctx.ipHash,
      userAgentHash: ctx.uaHash,
      expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000),
    },
  });
  // Cap concurrent sessions per account: oldest sessions beyond the limit are revoked.
  const extra = await prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, skip: env.MAX_SESSIONS_PER_USER, select: { id: true } });
  if (extra.length) await prisma.session.deleteMany({ where: { id: { in: extra.map((s) => s.id) } } });
  return token;
}

export async function resolveSession(token: string) {
  const s = await prisma.session.findUnique({ where: { tokenHash: hmac(token) }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt <= new Date()) {
    await prisma.session.delete({ where: { id: s.id } }).catch(() => undefined);
    return null;
  }
  return s;
}

export const destroySession = (token: string) => prisma.session.deleteMany({ where: { tokenHash: hmac(token) } });

export async function forgotPassword(email: string, ctx: ReqCtx) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.status === 'DISABLED') return; // same response either way (no enumeration)
  // Per-account throttle so the inbox can't be flooded through this endpoint.
  const recent = await prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
  if (recent >= 3) return;
  const token = randomToken(32);
  await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
  await securityEvent(user.id, 'PASSWORD_RESET_REQUESTED', ctx);
  const link = `${env.FRONTEND_URL.replace(/\/+$/, '')}/reset-password?token=${token}`;
  try {
    await sendMail(user.email, 'Reset your ShreePay password', `Use this link within 30 minutes:\n${link}\n\nIf you didn't request this, ignore this email.`);
  } catch {
    /* logged by mailer callers; never reveal delivery problems */
  }
}

export async function resetPassword(token: string, newPassword: string, ctx: ReqCtx) {
  const r = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!r || r.usedAt || r.expiresAt <= new Date()) throw new AppError(400, 'INVALID_TOKEN', 'Reset link is invalid or expired');
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.passwordReset.update({ where: { id: r.id }, data: { usedAt: new Date() } }),
    // Receiving the reset email proves control of the inbox, so the address counts as verified.
    prisma.user.update({ where: { id: r.userId }, data: { passwordHash, emailVerified: true, failedLogins: 0, lockedUntil: null } }),
    prisma.session.deleteMany({ where: { userId: r.userId } }), // log out everywhere
  ]);
  await securityEvent(r.userId, 'PASSWORD_RESET', ctx);
}
