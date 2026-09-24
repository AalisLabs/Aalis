import { defineConfig } from 'vitest/config';

// ════════════════════════════════════════════════════════════
// core 覆盖率门禁（preflight 跑）：只跑 test/core，只统计 packages/core/src。
//
// core 的每条行为都应由 core 自己的测试守住，不靠插件测试顺带覆盖，所以分母与测试集都限定在 core。
// 四项阈值都是 100：覆盖不到的分支只有两条出路，补测试，或证明走不到后删掉。core 源码禁用
// v8 / c8 / istanbul 的 ignore 注释（test/core/architecture.test.ts 守），门槛不能靠跳过统计达成。
// 与 vitest.config.ts 同一源码映射（@aalis/* 指向 src），不合并那份配置：合并会把两边的 include 拼在一起。
// ════════════════════════════════════════════════════════════

export default defineConfig({
  test: {
    include: ['test/core/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 15_000,
    pool: 'forks',
    coverage: {
      enabled: true,
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage/core',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
  resolve: {
    alias: [{ find: /^@aalis\/([a-z0-9-]+)$/, replacement: `${import.meta.dirname}/packages/$1/src/index.ts` }],
  },
});
