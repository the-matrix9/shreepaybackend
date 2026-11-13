import { Router } from 'express';
import * as c from '../controllers/authController';
import { authLimiter, otpLimiter } from '../middleware/rateLimit';
import { authenticateSession } from '../middleware/auth';

const r = Router();
r.post('/register', authLimiter, c.register);
r.post('/verify-email', otpLimiter, c.verifyEmail);
r.post('/resend-otp', otpLimiter, c.resendOtp);
r.post('/login', authLimiter, c.login);
r.post('/forgot-password', authLimiter, c.forgotPassword);
r.post('/reset-password', authLimiter, c.resetPassword);
r.post('/logout', c.logout);
r.get('/me', authenticateSession, c.me);
export default r;
