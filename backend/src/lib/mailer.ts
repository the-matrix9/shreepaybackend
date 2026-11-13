import nodemailer from 'nodemailer';
import { env, isProd } from '../config/env';
import { logger } from './logger';

/**
 * Works with any SMTP provider. Gmail:  SMTP_HOST=smtp.gmail.com  SMTP_PORT=465
 * SMTP_USER=<gmail address>  SMTP_PASSWORD=<16-char app password>.
 */
const transport =
  env.SMTP_HOST && env.SMTP_PORT
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      })
    : null;

const from = env.SMTP_FROM ?? (env.SMTP_USER ? `ShreePay <${env.SMTP_USER}>` : 'ShreePay <no-reply@shreepay.local>');

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  if (!transport) {
    if (isProd) throw new Error('SMTP is not configured');
    // Dev convenience only: print the mail (including OTP) to the console.
    logger.info({ to, subject, text }, 'SMTP not configured: mail printed (dev only)');
    return;
  }
  await transport.sendMail({ from, to, subject, text, html });
}
