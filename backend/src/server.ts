import { createApp } from './app';
import { env, isProd, paymentBaseUrl, splitPaymentHost } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { startMaintenance } from './jobs/maintenance';
import { startAutoVerify } from './services/autoVerifyService';
import { flushApiLogs, startApiLogFlusher } from './middleware/requestLog';

const app = createApp();
const server = app.listen(env.PORT, () => logger.info(`ShreePay API listening on :${env.PORT} (${env.NODE_ENV})`));

// Slow-client / connection-exhaustion protection, and keep-alive longer than typical load balancers (60s).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

if (isProd) {
  if (!splitPaymentHost) {
    logger.warn(`PAYMENT_PAGE_BASE_URL (${paymentBaseUrl}) shares a host with the API. Use a separate host such as https://pay.<your-domain> so upstream-rendered pages never share an origin with sessions.`);
  }
  if (!redis) logger.warn('REDIS_URL not set: rate limits are per-process. Set it before running more than one instance.');
  if (!env.SMTP_HOST) logger.error('SMTP is not configured: signup OTP emails cannot be sent.');
}

const timers = [startMaintenance(), startApiLogFlusher(), startAutoVerify()].filter((t): t is NodeJS.Timeout => !!t);

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  timers.forEach(clearInterval);
  server.close(async () => {
    await flushApiLogs();
    await prisma.$disconnect();
    redis?.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: String(err) }, 'unhandledRejection'));
