import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .test.tsx：WebUI 组件测试（含 `// @vitest-environment jsdom` 文件级覆盖 node 默认环境）
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/fixtures/**'],
    environment: 'node',
    testTimeout: 15_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      // 全工程纳入覆盖率统计（含所有插件源码）。
      // 门槛按当前实际可达数值设置，后续随测试新增逐步抬升。
      include: ['packages/*/src/**/*.ts', 'src/**/*.ts'],
      exclude: [
        '**/dist/**',
        '**/node_modules/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/test/**',
        '**/tests/**',
        // UI / WebUI 客户端代码不在 node 环境内测试
        'packages/plugin-webui-client/**',
        // 类型定义包（无运行时代码）
        'packages/*-api/**',
        'packages/plugin-sdk/**',
      ],
      // 当前实际覆盖率：lines/statements ≈ 15.8%，functions ≈ 23.7%，branches ≈ 63%。
      // 门槛设在实际值之下并允许少量回退缓冲，避免无关 PR 误报；
      // 新插件/新 runtime 增加测试后应主动抬升此处数值。
      thresholds: {
        lines: 15,
        functions: 22,
        statements: 15,
        branches: 60,
      },
    },
  },
  // React 19 自动运行时：.tsx 组件测试无需显式 import React
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    conditions: ['source', 'import', 'node', 'default'],
  },
});
