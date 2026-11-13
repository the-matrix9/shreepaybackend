import { execSync } from 'child_process';

/** Pushes the Prisma schema to the TEST database. Refuses to touch any database not named *test*. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://shreepay:shreepay@localhost:5432/shreepay_test';
  const dbName = new URL(url).pathname.replace('/', '');
  if (!/test/i.test(dbName)) throw new Error(`Refusing to run tests against "${dbName}": database name must contain "test"`);
  execSync('npx prisma db push --force-reset --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
