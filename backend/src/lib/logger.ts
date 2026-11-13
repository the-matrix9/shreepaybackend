import pino from 'pino';
import { env, isProd, isTest } from '../config/env';

export const logger = pino({
  level: isTest ? 'silent' : isProd ? 'info' : 'debug',
  // Defense in depth: never let secrets reach logs.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.apiKey',
      '*.key',
    ],
    censor: '[REDACTED]',
  },
  transport: !isProd && !isTest && env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
