import { connect } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import mcpServer, { buildMcpServer } from '../../packages/plugin-mcp-server/src/index.js';
import { parseConfig, validateConfig } from '../../packages/schema-config/src/index.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// toolGroups 是分组名的字符串数组（multiselect）。此前 schema 声明成对象数组 [{ name }]，
// 与文档的 string[] 不一致：按文档写的配置每次启动都报 invalid，WebUI 编辑会把字符串展开成对象；
// 空数组 = 全部暴露；null 按统一配置契约视为缺省，历史配置需人工确认暴露范围。
// 对象、布尔成员等非法形态必须拒绝启动，不能退化成空数组。
// 拒绝启动即激活失败、实例转 error：只记日志的话插件显示运行中、doctor 全绿，实际没有监听。
// ════════════════════════════════════════════════════════════

function captureLogger() {
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    debug() {},
    info: (...args: unknown[]) => void infos.push(args.map(String).join(' ')),
    warn() {},
    error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')),
    child: () => logger,
  };
  return { logger, errors, infos };
}

/** 端口上是否有人在监听 */
function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
  });
}

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop().catch(() => {});
});

async function start(toolGroups: unknown, port?: number) {
  const listenPort = port ?? (await freePort());
  const { logger, errors, infos } = captureLogger();
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  app.bind({ provide }).provide(tools, {
    getAll: () => [],
    getDefinitions: () => [],
    getSummaries: () => [],
    execute: async () => ({ content: '' }),
  } as never);
  await app.plugins.register(mcpServer, { port: listenPort, bind: '127.0.0.1', toolGroups, allowRestricted: false });
  await app.plugins.idle();
  const entry = app.plugins.getPlugin(mcpServer.name);
  return { port: listenPort, errors, infos, state: entry?.state, error: entry?.error };
}

describe('plugin-mcp-server toolGroups', () => {
  it('schema 接受文档写法：分组名字符串数组（含 *）', () => {
    const issues = validateConfig(mcpServer.configSchema, {
      port: 7861,
      bind: '127.0.0.1',
      toolGroups: ['search', '*'],
      allowRestricted: false,
    });
    expect(issues).toEqual([]);
  });

  it('字符串数组：正常监听', async () => {
    const r = await start(['search']);
    expect(r.errors).toEqual([]);
    expect(await isListening(r.port)).toBe(true);
  });

  for (const [label, value] of [
    ['旧版 WebUI 的 [{ name }]', [{ name: 'search' }]],
    ["裸字符串 '*'", '*'],
    ['含布尔元素', ['search', true]],
  ] as const) {
    it(`${label}：激活失败且不监听，不退化成全部暴露`, async () => {
      const r = await start(value);
      expect(r.state, '配置错误只记了日志，插件显示运行中').toBe('error');
      expect(r.error).toContain('toolGroups');
      expect(await isListening(r.port)).toBe(false);
    });
  }

  it('null 按缺省空白名单运行；旧配置需在离线迁移时人工确认暴露范围', async () => {
    const r = await start(null);
    expect(r.state).toBe('active');
    expect(await isListening(r.port)).toBe(true);
  });

  it('数字分组名转换为字符串，白名单不退化为全部暴露', async () => {
    const r = await start(['search', 1]);
    expect(r.state).toBe('active');
    expect(r.infos.some(info => info.includes('groups=search,1'))).toBe(true);
  });

  it('数字分组仅匹配同名字符串分组，不能打开其它分组', async () => {
    const parsed = parseConfig(mcpServer.configSchema!, { toolGroups: ['search', 1] });
    const execute = vi.fn(async () => ({ content: 'ok' }));
    const entries = [
      { name: 'search_tool', groups: ['search'] },
      { name: 'numeric_tool', groups: ['1'] },
      { name: 'secret_tool', groups: ['secret'] },
    ];
    const server = buildMcpServer(
      {
        getAll: () => entries.map(entry => ({ ...entry, description: entry.name, pluginName: 'test' })),
        getDefinitions: () =>
          entries.map(entry => ({
            type: 'function' as const,
            function: { name: entry.name, description: entry.name, parameters: { type: 'object', properties: {} } },
          })),
        execute,
      } as never,
      parsed as never,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['search_tool', 'numeric_tool']);
      expect((await client.callTool({ name: 'numeric_tool', arguments: {} })).isError).not.toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      execute.mockClear();
      const denied = await client.callTool({ name: 'secret_tool', arguments: {} });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([{ type: 'text', text: '工具不可用或未暴露: secret_tool' }]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('端口非法：激活失败，原因可见', async () => {
    const r = await start([], 0);
    expect(r.state, '配置错误只记了日志，插件显示运行中').toBe('error');
    expect(r.error).toContain('port');
  });
});
