import type { CookieOptions, Request } from 'express';
import { env, isProd } from '../config/env';
import { prisma } from '../lib/prisma';
import { asyncHandler, ok } from '../lib/http';
import { forgotBody, loginBody, registerBody, resendOtpBody, resetBody, verifyEmailBody } from '../validators';
import * as auth from '../services/authService';
import { reqCtx, securityEvent } from '../services/auditService';

const cookieOpts: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  signed: true,
  path: '/', // required by the __Host- prefix
  maxAge: env.SESSION_TTL_HOURS * 3_600_000,
};

const publicUser = async (userId: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    status: u.status,
    emailVerified: u.emailVerified,
    createdAt: u.createdAt,
    profile: u.profile && { businessName: u.profile.businessName, upiId: u.profile.upiId, upiVerified: u.profile.upiVerified, upiUpdatedAt: u.profile.upiUpdatedAt },
  };
};

/** Step 1 of signup: creates the unverified account and emails a code. No session yet. */
export const register = asyncHandler(async (req, res) => {
  const body = registerBody.parse(req.body);
  const { user, emailSent } = await auth.register(body, reqCtx(req));
  ok(res, { verificationRequired: true, email: user.email, emailSent, resendAfter: env.OTP_RESEND_COOLDOWN_SEC }, 'Account created. Enter the code we emailed you.', 201);
});

/** Step 2: proves inbox ownership, then signs the user in. */
export const verifyEmail = asyncHandler(async (req, res) => {
  const body = verifyEmailBody.parse(req.body);
  const { user, token } = await auth.verifyEmail(body.email, body.code, reqCtx(req));
  res.cookie(auth.SESSION_COOKIE, token, cookieOpts);
  ok(res, { user: await publicUser(user.id) }, 'Email verified');
});

export const resendOtp = asyncHandler(async (req, res) => {
  const body = resendOtpBody.parse(req.body);
  await auth.resendOtp(body.email, reqCtx(req));
  ok(res, { resendAfter: env.OTP_RESEND_COOLDOWN_SEC }, 'If the account is awaiting verification, a new code has been sent');
});

export const login = asyncHandler(async (req, res) => {
  const body = loginBody.parse(req.body);
  const { user, token } = await auth.login(body.email, body.password, reqCtx(req));
  res.cookie(auth.SESSION_COOKIE, token, cookieOpts);
  ok(res, { user: await publicUser(user.id) }, 'Logged in');
});

export const logout = asyncHandler(async (req: Request, res) => {
  const token = req.signedCookies?.[auth.SESSION_COOKIE];
  if (typeof token === 'string') {
    const s = await auth.resolveSession(token);
    await auth.destroySession(token);
    if (s) await securityEvent(s.userId, 'LOGOUT', reqCtx(req));
  }
  res.clearCookie(auth.SESSION_COOKIE, { ...cookieOpts, maxAge: undefined });
  ok(res, {}, 'Logged out');
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = forgotBody.parse(req.body);
  await auth.forgotPassword(email, reqCtx(req));
  ok(res, {}, 'If that email exists, a reset link has been sent');
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = resetBody.parse(req.body);
  await auth.resetPassword(token, password, reqCtx(req));
  ok(res, {}, 'Password updated. Please log in.');
});

export const me = asyncHandler(async (req, res) => {
  ok(res, { user: await publicUser(req.user!.id) });
});
