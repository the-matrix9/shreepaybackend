import express from 'express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { bigintReplacer } from './lib/http';
import { corsMiddleware, csrfOriginCheck, securityHeaders } from './middleware/security';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import merchantRoutes from './routes/merchant';
import adminRoutes from './routes/admin';
import publicRoutes from './routes/public';
import payRoutes, { hostGuard } from './routes/pay';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY); // set to the number of proxies in front (needed for correct client IPs / rate limits)
  app.set('json replacer', bigintReplacer);

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (r) => ({ method: r.method, url: String(r.url).split('?')[0] }), // no query strings, no headers
        res: (r) => ({ statusCode: r.statusCode }),
      },
    }),
  );
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '20kb', strict: true }));
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(csrfOriginCheck);

  app.use(publicRoutes);
  app.use(hostGuard);
  app.use(payRoutes); // customer payment pages, served from our own domain
  app.use('/auth', authRoutes);
  app.use('/api/v1', merchantRoutes);
  app.use('/admin', adminRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
