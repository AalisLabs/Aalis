import { afterEach, describe, expect, it, vi } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import mcpClient from '../../packages/plugin-mcp-client/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { validateConfig } from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// mcp-client 的 configSchema 迁到 definePlugin 时漏挂：WebUI 表单、默认值、校验全部失效。
// 挂回后 args / env 用中立类型 list / map（与文档、MCP 生态的数组 + 映射写法一致）；
// 条目按 schema 逐项解析：旧版 WebUI 存下的多行文本不能安全转换，该条 server 不启动。
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
  const registry = new ToolRegistry(logger);
  app.bind({ provide }).provide(tools, registry);
  await app.plugin(mcpClient, { servers });
  await app.plugins.idle();
  return { warns, registry };
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
  it('数组参数原样传递，包括带空格和空字符串；缺省 args/env 补默认值', async () => {
    await start([
      { id: 'fs', command: 'npx', args: ['-y', '', 'pkg', '/p with space'], env: { TOKEN: 'x y' } },
      { id: 'defaults', command: 'node' },
    ]);
    expect(spawned).toEqual([
      { command: 'npx', args: ['-y', '', 'pkg', '/p with space'], env: { TOKEN: 'x y' } },
      { command: 'node', args: [], env: {} },
    ]);
  });

  it('旧版多行文本或空字符串 args/env：整条 server 拒绝，其它 server 照常', async () => {
    const { warns } = await start([
      { id: 'old-args', command: 'npx', args: '-y\npkg' },
      { id: 'old-env', command: 'npx', env: 'TOKEN=x' },
      { id: 'empty-args', command: 'npx', args: '' },
      { id: 'empty-env', command: 'npx', env: '' },
      { id: 'ok', command: 'npx', args: ['-y'] },
    ]);
    expect(spawned).toEqual([{ command: 'npx', args: ['-y'], env: {} }]);
    expect(warns.filter(w => w.includes('已忽略'))).toHaveLength(4);
  });

  it('坏 args/env 成员不能静默截短后启动，数值成员按 schema 转成字符串', async () => {
    const { warns } = await start([
      { id: 'bad-arg', command: 'npx', args: ['-y', false, 'pkg'] },
      { id: 'bad-env', command: 'npx', env: { TOKEN: 'x', BAD: {} } },
      { id: 'ok', command: 'npx', args: [7], env: { PORT: 8080 } },
    ]);
    expect(spawned).toEqual([{ command: 'npx', args: ['7'], env: { PORT: '8080' } }]);
    expect(warns.filter(w => w.includes('已忽略'))).toHaveLength(2);
  });

  it('无效 enabled/visibility 拒绝条目，禁止回退到启用或 auto', async () => {
    const { warns, registry } = await start([
      { id: 'bad-enabled', command: 'npx', enabled: 'false' },
      { id: 'bad-tier', command: 'npx', visibility: 'bogus' },
      { id: 'off', command: 'npx', enabled: false },
      { id: 'good', command: 'npx', visibility: 'restricted' },
    ]);
    expect(spawned).toEqual([{ command: 'npx', args: [], env: {} }]);
    expect(warns.filter(w => w.includes('已忽略'))).toHaveLength(2);
    const out = await registry.execute('mcp_list_servers', {}, { sessionId: 't' });
    expect(JSON.parse(out.content).map((s: { id: string }) => s.id)).toEqual(['off', 'good']);
  });

  it('id / command 去掉首尾空白；缺字段或只有空白的条目告警跳过，其它 server 照常', async () => {
    const { warns, registry } = await start([
      { command: 'npx' },
      { id: '  ', command: 'npx' },
      { id: ' fs ', command: ' npx ', args: ['-y', '', 'pkg'] },
    ]);
    expect(spawned).toEqual([{ command: 'npx', args: ['-y', '', 'pkg'], env: {} }]);
    expect(registry.getGroups().map(g => g.name)).toContain('mcp:fs');
    expect(warns).toContain('配置项 servers[0] 已忽略：id 必填字段缺失');
    expect(warns).toContain('servers 中有一条 id 或 command 只有空白（id「」，command「npx」），跳过');
  });
});

describe('plugin-mcp-client mcp_list_servers', () => {
  it('列出与连接一致的 trim/numeric ID 和缺省值', async () => {
    const { registry } = await start([
      { id: ' x ', command: ' npx ', enabled: false },
      { id: 7, command: 'node' },
    ]);
    const out = await registry.execute('mcp_list_servers', {}, { sessionId: 't' });
    expect(JSON.parse(out.content)).toEqual([
      { index: 0, id: 'x', command: 'npx', enabled: false, visibility: 'auto' },
      { index: 1, id: '7', command: 'node', enabled: true, visibility: 'auto' },
    ]);
  });
});
