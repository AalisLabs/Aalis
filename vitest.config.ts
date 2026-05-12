import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 10_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // 仅纳入当前真实被测试覆盖的模块（避免把大体量未测代码拉低门槛）。
      // 新增测试覆盖到的源码文件，请在此处显式加入。
      include: [
        'packages/core/src/disposable-chain.ts',
        'packages/core/src/events.ts',
        'packages/core/src/hooks.ts',
        'packages/core/src/logger.ts',
        'packages/core/src/service.ts',
        'packages/core/src/context.ts',
        'packages/core/src/config.ts',
        'packages/core/src/plugin.ts',
        'packages/plugin-agent-default/src/helpers.ts',
      ],
      exclude: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
  resolve: {
    // 让 vitest 直接吃 TS 源，避免依赖 build 产物
    conditions: ['source', 'import', 'node', 'default'],
  },
});
