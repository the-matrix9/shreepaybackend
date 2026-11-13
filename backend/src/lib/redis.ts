import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/** Optional. When REDIS_URL is set, rate limits are shared across all backend instances. */
export const redis: Redis | null = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
  : null;

redis?.on('error', (err) => logger.error({ err: err.message }, 'redis error'));
