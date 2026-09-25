import { afterEach, describe, expect, it, vi } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import mcpClient from '../../packages/plugin-mcp-client/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { validateConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// mcp-client 的 configSchema 迁到 definePlugin 时漏挂：WebUI 表单、默认值、校验全部失效。
// 挂回后 args / env 用中立类型 list / map（与文档、MCP 生态的数组 + 映射写法一致）；
// 旧版 WebUI 存下的多行文本不再解析（按空白切分会拆坏带空格的参数），该 server 告警不启动。
// ════════════════════════════════════════════════════════════

const spawned = vi.hoisted(() => [] as Array<{ command: string; args?: string[]; env?: Record<string, string> }>);

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(params: { command: string; args?: string[]; env?: Record<string, string> }) {
      spawned.push(params);
    }
    async start(): Promise<void> {
      throw new Error('测试桩：不启动子进程');
    }
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

function captureLogger() {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  return { logger, warns };
}

const apps: App[] = [];
afterEach(async () => {
  spawned.length = 0;
  for (const a of apps.splice(0)) await a.stop().catch(() => {});
});

async function start(servers: unknown[]) {
  const { logger, warns } = captureLogger();
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  app.bind({ provide }).provide(tools, new ToolRegistry(logger));
  await app.plugin(mcpClient, { servers });
  await app.plugins.idle();
  return { warns };
}

/** 文档与 README 的配置示例 */
const DOC_EXAMPLE = {
  servers: [
    {
      id: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' },
      enabled: true,
      visibility: 'auto',
    },
    {
      id: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
      visibility: 'restricted',
    },
  ],
};

describe('plugin-mcp-client configSchema', () => {
  it('挂在插件定义上，文档示例配置校验无问题', () => {
    expect(mcpClient.configSchema, 'runtime 与 WebUI 只读插件定义上的 configSchema').toBeDefined();
    expect(validateConfig(mcpClient.configSchema, DOC_EXAMPLE)).toEqual([]);
  });
});

describe('plugin-mcp-client args / env', () => {
  it('数组参数原样传给子进程（带空格的参数不被拆开），映射作为环境变量', async () => {
    await start([{ id: 'fs', command: 'npx', args: ['-y', 'pkg', '/p with space'], env: { TOKEN: 'x y' } }]);
    expect(spawned).toEqual([{ command: 'npx', args: ['-y', 'pkg', '/p with space'], env: { TOKEN: 'x y' } }]);
  });

  it('旧版多行文本的 args / env：告警且不启动该 server，其它 server 照常', async () => {
    const { warns } = await start([
      { id: 'old-args', command: 'npx', args: '-y\npkg' },
      { id: 'old-env', command: 'npx', env: 'TOKEN=x' },
      { id: 'ok', command: 'npx', args: ['-y'] },
    ]);
    expect(spawned.map(s => s.args)).toEqual([['-y']]);
    expect(warns.join('\n')).toContain('servers[0]（old-args）的 args 必须是字符串数组');
    expect(warns.join('\n')).toContain('servers[1]（old-env）的 env 必须是 KEY: VALUE 映射');
  });
});
