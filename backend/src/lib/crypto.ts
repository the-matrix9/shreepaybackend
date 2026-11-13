import { createHash, createHmac, randomBytes } from 'crypto';
import { env } from '../config/env';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Keyed hash for session tokens, IPs, user agents (so DB leaks don't expose raw values). */
export const hmac = (s: string) => createHmac('sha256', env.SESSION_SECRET).update(s).digest('hex');

export const API_KEY_PREFIX = 'sk_live_';
export const API_KEY_RE = /^sk_live_[A-Za-z0-9_-]{32,64}$/;

export function generateApiKey() {
  const key = API_KEY_PREFIX + randomBytes(24).toString('base64url'); // 192 bits of entropy
  return { key, keyPrefix: key.slice(0, API_KEY_PREFIX.length + 6), keyHash: sha256(key) };
}

/** Public-facing unique order id sent upstream. Merchant order ids never leave our DB namespace. */
export const newUpstreamOrderId = () => 'SP' + randomBytes(12).toString('hex').toUpperCase();
