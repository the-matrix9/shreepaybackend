import { Router } from 'express';
import * as c from '../controllers/adminController';
import { authenticateSession, requireAdmin } from '../middleware/auth';
import { adminLimiter } from '../middleware/rateLimit';
import { adminIpAllowlist } from '../middleware/adminIp';

const r = Router();
r.use(adminIpAllowlist, authenticateSession, requireAdmin, adminLimiter);

r.get('/dashboard', c.dashboard);
r.get('/merchants', c.listMerchants);
r.get('/merchants/:id', c.getMerchant);
r.post('/merchants/:id/suspend', c.suspend);
r.post('/merchants/:id/activate', c.activate);
r.get('/transactions', c.transactions);
r.get('/withdrawals', c.listWithdrawals);
r.post('/withdrawals/:id/approve', c.approve);
r.post('/withdrawals/:id/reject', c.reject);
r.post('/withdrawals/:id/mark-paid', c.markPaid);
r.get('/api-keys', c.listApiKeys);
r.post('/api-keys/:id/revoke', c.revokeApiKey);
r.get('/security-events', c.securityEvents);
r.get('/audit-logs', c.auditLogs);
r.get('/api-logs', c.apiLogs);
r.get('/settings', c.getPlatformSettings);
r.put('/settings', c.updatePlatformSettings);
export default r;
