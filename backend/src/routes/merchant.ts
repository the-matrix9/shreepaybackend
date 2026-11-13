import { Router } from 'express';
import * as pay from '../controllers/paymentController';
import * as acct from '../controllers/accountController';
import { authenticateAny, requireMerchant, requireSession } from '../middleware/auth';
import { apiIpLimiter, apiLimiter, verifyLimiter } from '../middleware/rateLimit';
import { idempotent } from '../middleware/idempotency';
import { apiRequestLogger } from '../middleware/requestLog';

/**
 * /api/v1  ->  Bearer API key (server-to-server) OR dashboard session cookie.
 * Key management, profile and withdrawals are session-only: a leaked API key can create/verify
 * payments but can never mint keys, change the payout UPI, or request a payout.
 */
const r = Router();
r.use(apiIpLimiter, authenticateAny, requireMerchant, apiRequestLogger, apiLimiter);

r.post('/payments/create', idempotent('payments.create'), pay.create);
r.post('/payments/verify', verifyLimiter, idempotent('payments.verify'), pay.verify);
r.get('/payments', pay.list);
r.get('/payments/:orderId', pay.get);

r.get('/balance', acct.balance);
r.get('/transactions', pay.listTransactions);
r.get('/transactions/:id', pay.getTransaction);

r.get('/withdrawals', acct.listWithdrawals);
r.post('/withdrawals', requireSession, acct.createWithdrawal);
r.delete('/withdrawals/:id', requireSession, acct.cancelWithdrawal);

r.get('/profile', requireSession, acct.getProfile);
r.put('/profile', requireSession, acct.updateProfile);

r.get('/api-keys', requireSession, acct.listKeys);
r.post('/api-keys', requireSession, acct.createKey);
r.delete('/api-keys/:id', requireSession, acct.revokeKey);

r.get('/api-usage', acct.apiUsage);
r.get('/analytics', acct.analytics);
export default r;
