import { describe, expect, it } from 'vitest';

/**
 * 全插件 smoke import 测试
 *
 * 每个生产插件都应该：
 * 1. 能被 import 成功（编译/依赖链路 OK）
 * 2. 导出 `name: string`（PluginManager 用作 ID）
 * 3. 导出 `apply: function`（PluginManager 用作激活入口）
 *
 * 目的不是验证业务行为，而是防止破坏性重构悄无声息地把插件搞坏：
 * 编译过 ≠ 模块能被 ESM 加载 ≠ 入口契约还在。
 *
 * 跳过名单：
 * - plugin-computer-use：依赖系统级原生绑定（X11/CoreGraphics/Win32）
 * - plugin-vectorstore-lancedb：原生 lance 绑定，CI 镜像不一定可用
 * - plugin-webui-client：纯前端 React 包，不在 node 环境里跑
 * - plugin-sdk：模板库，不是可加载插件
 * - 所有 *-api：纯类型/契约包，不导出 apply
 */

const PLUGIN_DIRS = [
  'plugin-adapter-onebot',
  'plugin-agent-default',
  'plugin-agent-tools',
  'plugin-authority',
  'plugin-checkpoint',
  'plugin-cli',
  'plugin-commands',
  'plugin-deepseek',
  'plugin-embedding-ollama',
  'plugin-embedding-openai',
  'plugin-file-reader',
  'plugin-flow-control',
  'plugin-game-activity',
  'plugin-gateway',
  'plugin-image-recognition',
  'plugin-llm-router',
  'plugin-maimai',
  'plugin-mcp-client',
  'plugin-mcp-server',
  'plugin-memory-inmemory',
  'plugin-memory-mongodb',
  'plugin-memory-sqlite',
  'plugin-memory-summary',
  'plugin-memory-vector',
  'plugin-message-archive',
  'plugin-office',
  'plugin-okx-trading',
  'plugin-ollama',
  'plugin-onebot-tools',
  'plugin-openai',
  'plugin-persona',
  'plugin-platform',
  'plugin-prompt-budget',
  'plugin-scheduler',
  'plugin-session-channel',
  'plugin-session-manager',
  'plugin-session-tools',
  'plugin-skills',
  'plugin-slay-spire-agent',
  'plugin-storage-local',
  'plugin-storage-router',
  'plugin-todo-list',
  'plugin-tool-browser',
  'plugin-tool-code-runner',
  'plugin-tool-math',
  'plugin-tool-search',
  'plugin-tools',
  'plugin-trigger-policy',
  'plugin-user-profile',
  'plugin-vectorstore-flat',
  'plugin-websearch-serper',
  'plugin-webui-server',
] as const;

describe('全插件 smoke import 契约', () => {
  for (const dir of PLUGIN_DIRS) {
    it(`${dir} 导出 name + apply`, async () => {
      const mod = await import(`../../packages/${dir}/src/index.ts`);
      expect(typeof mod.name).toBe('string');
      expect(mod.name.length).toBeGreaterThan(0);
      expect(typeof mod.apply).toBe('function');
    });
  }
});
