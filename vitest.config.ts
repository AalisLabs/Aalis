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
      ],
      // 契约包不再排除：曾有一条 `packages/*-api/**`，理由写的是「类型定义包（无运行时代码）」
      // —— 两半都不成立。契约包各自带 `useXxx(ctx)` 访问器等运行时代码；且 25 包改名
      // （plugin-X-api → api-X）之后那条 glob 一个目录都匹配不上，早已是死配置，
      // 分母里其实一直算着它们。连同指向不存在目录的 `packages/plugin-sdk/**` 一并删掉，
      // 让配置说的和实际做的一致。要重新排除的话补 `packages/api-*/**` 即可。
      //
      // 当前实际覆盖率（含契约包）：lines/statements ≈ 36.7%，functions ≈ 55.1%，branches ≈ 72.6%。
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
