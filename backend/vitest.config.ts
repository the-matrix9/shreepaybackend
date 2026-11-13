import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // all files share one Postgres test database
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
