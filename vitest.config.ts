import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 10_000,
    pool: 'forks',
  },
  resolve: {
    // 让 vitest 直接吃 TS 源，避免依赖 build 产物
    conditions: ['source', 'import', 'node', 'default'],
  },
});
