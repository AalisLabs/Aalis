import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import mcpClient from '../../packages/plugin-mcp-client/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// mcp-client 连不上某个 MCP 服务器时发 error 提示（标题写哪个服务器，detail 写原因，跳转去配置），出现在「需要处理」
// 与插件详情；提示归属这次激活，改好配置重载后连上了，提示随旧激活撤回、新激活不再发。
//
// MCP 服务器用测试替身：node -e 起的 stdio 进程，按行收 JSON-RPC，答 initialize 与 tools/list；连不上的替身一启动就退出。
// 提示收在 webui-server 的真实登记表里（page-host），不起端口
// ════════════════════════════════════════════════════════════

const DOUBLE = `
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result =
    message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'double', version: '0.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;
const BROKEN = 'process.exit(3)';

const server = (id: string, script: string) => ({ id, command: process.execPath, args: ['-e', script] });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('plugin-mcp-client 连不上时发提示', () => {
  it('连不上的发 error 提示、连上的不发；改好配置重载后连上，提示撤回，它的工具注册上', async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')),
      child: () => logger,
    };
    const host = pageHost();
    const app = new App({ name: 'T', logLevel: 'error', logger });
    apps.push(app);
    const registry = new ToolRegistry(logger);
    app.bind({ provide }).provide(tools, registry);
    app.bind({ provide }).provide(webuiServer, host.service);

    await app.plugin(mcpClient, { servers: [server('flaky', BROKEN), server('steady', DOUBLE)] });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(mcpClient.name)?.state).toBe('active');
    const [notice] = host.notices();
    expect(host.notices()).toEqual([
      {
        instance: mcpClient.name,
        id: 'connect:flaky',
        level: 'error',
        title: 'MCP 服务器「flaky」连不上',
        detail: expect.stringMatching(/\S/),
        open: 'config',
      },
    ]);
    expect(errors).toEqual([`连接 MCP server "flaky" 失败: ${notice.detail}`]);
    const names = () => registry.getAll().map(tool => tool.name);
    expect(names()).toContain('mcp_steady_echo');
    expect(names()).not.toContain('mcp_flaky_echo');

    await app.plugins.updateConfig(mcpClient.name, { servers: [server('flaky', DOUBLE), server('steady', DOUBLE)] });
    await app.plugins.idle();
    expect(host.notices()).toEqual([]);
    expect(names()).toEqual(expect.arrayContaining(['mcp_flaky_echo', 'mcp_steady_echo']));
    expect(errors).toHaveLength(1);
  });
});
