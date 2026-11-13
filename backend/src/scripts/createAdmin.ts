/**
 * Creates (or promotes + resets the password of) the first admin from ADMIN_EMAIL / ADMIN_PASSWORD.
 *   npm run create-admin
 * Admins have no merchant profile, wallet or API keys.
 */
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { hashPassword } from '../services/authService';
import { emailSchema, passwordSchema } from '../validators';

async function main() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in your environment first');
  const email = emailSchema.parse(env.ADMIN_EMAIL);
  passwordSchema.parse(env.ADMIN_PASSWORD);
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
  const admin = await prisma.user.upsert({
    where: { email },
    create: { name: 'Administrator', email, passwordHash, role: 'ADMIN', status: 'ACTIVE', emailVerified: true },
    update: { passwordHash, role: 'ADMIN', status: 'ACTIVE', failedLogins: 0, lockedUntil: null },
  });
  await prisma.session.deleteMany({ where: { userId: admin.id } });
  console.log(`Admin ready: ${email}. Remove ADMIN_PASSWORD from your environment now.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
