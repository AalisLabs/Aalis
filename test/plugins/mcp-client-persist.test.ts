import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AalisConfig, ConfigSaveRefusedError } from '../../packages/api-host-config/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import mcpClient from '../../packages/plugin-mcp-client/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';

// mcp_set_server_enabled 改的是 mcp-client 自己的配置：updateConfig 只改运行态并 bounce 本插件，
// 工具随后自己写配置文档并落盘，重启后开关不回退。

const NAME = '@aalis/plugin-mcp-client';
// 启用后也只观察 Transport 构造，绝不启动真实命令或连接外部服务。
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    async start(): Promise<void> {
      throw new Error('测试桩：不启动子进程');
    }
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

type Servers = { servers: Array<{ id: string; enabled?: boolean }> };

describe('mcp-client 自服务开关落盘', () => {
  it('切换 enabled：bounce 自己后运行态与配置文档一致，且落盘一次', async () => {
    const saved: AalisConfig[] = [];
    // enabled=true 的条目 bounce 后会尝试连接；Transport 测试桩直接拒绝
    const server = { id: 'a', command: 'aalis-test-missing-mcp-command', enabled: false };
    const { app, store } = hostedApp(
      { plugins: { [NAME]: { servers: [server] } } },
      {
        logger: silent,
        provider: {
          save: snapshot => {
            saved.push(structuredClone(snapshot));
          },
        },
      },
    );
    apps.push(app);
    const registry = new ToolRegistry(silent);
    // 测的是工具自身行为而非鉴权：放行守卫代替 plugin-authority（没有守卫时需要鉴权的工具一律被拒）
    registry.setExecutionGuard(async () => null);
    app.bind({ provide }).provide(tools, registry);
    await registerFromDoc(app, store, mcpClient);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(NAME)?.state).toBe('active');

    const out = await registry.execute('mcp_set_server_enabled', { id: 'a', enabled: true }, { sessionId: 't' });
    expect(out.content).toContain('已将 server "a" 设置为 enabled=true');
    await app.plugins.idle();

    expect((app.plugins.getPlugin(NAME)?.config as Servers).servers[0].enabled).toBe(true);
    expect((store.getPluginConfig(NAME) as Servers).servers[0].enabled).toBe(true);
    expect(saved).toHaveLength(1);
    // 以配置文档为底改写：解析时补上的 args / env / visibility 默认值不写进文件
    expect((saved[0].plugins[NAME] as Servers).servers[0]).toEqual({ ...server, enabled: true });

    // 按落盘文档重建：开关不回退
    const rebuilt = hostedApp(structuredClone(saved[0]), { logger: silent });
    apps.push(rebuilt.app);
    rebuilt.app.bind({ provide }).provide(tools, new ToolRegistry(silent));
    await registerFromDoc(rebuilt.app, rebuilt.store, mcpClient);
    await rebuilt.app.plugins.idle();
    expect((rebuilt.app.plugins.getPlugin(NAME)?.config as Servers).servers[0].enabled).toBe(true);
  });

  it('不加引号的数字 id：解析按字符串收，开关按同一口径找到条目，文档里的原值不动', async () => {
    const server = { id: 7, command: 'aalis-test-missing-mcp-command', enabled: false };
    const { app, store } = hostedApp({ plugins: { [NAME]: { servers: [server] } } }, { logger: silent });
    apps.push(app);
    const registry = new ToolRegistry(silent);
    registry.setExecutionGuard(async () => null);
    app.bind({ provide }).provide(tools, registry);
    await registerFromDoc(app, store, mcpClient);
    await app.plugins.idle();

    const out = await registry.execute('mcp_set_server_enabled', { id: '7', enabled: true }, { sessionId: 't' });
    expect(out.content).toContain('已将 server "7" 设置为 enabled=true');
    await app.plugins.idle();
    expect((store.getPluginConfig(NAME) as { servers: unknown[] }).servers[0]).toEqual({ ...server, enabled: true });
  });

  it('trim 后的 id 能找到文档原条目，写回只改变 enabled', async () => {
    const server = { id: '  fs  ', command: 'node', args: [''], env: { TOKEN: 'x' }, enabled: false, extra: 42 };
    const { app, store } = hostedApp(
      { plugins: { [NAME]: { servers: [server], extraTop: true } } },
      { logger: silent },
    );
    apps.push(app);
    const registry = new ToolRegistry(silent);
    registry.setExecutionGuard(async () => null);
    app.bind({ provide }).provide(tools, registry);
    await registerFromDoc(app, store, mcpClient);
    await app.plugins.idle();

    const listed = await registry.execute('mcp_list_servers', {}, { sessionId: 't' });
    expect(JSON.parse(listed.content)[0].id).toBe('fs');
    const out = await registry.execute('mcp_set_server_enabled', { id: 'fs', enabled: true }, { sessionId: 't' });
    expect(out.content).toContain('enabled=true');
    await app.plugins.idle();
    expect(store.getPluginConfig(NAME)).toEqual({ servers: [{ ...server, enabled: true }], extraTop: true });
  });

  it('落盘被拒：回执说明运行态已切换、配置文件未写入，而不是只报错', async () => {
    const server = { id: 'a', command: 'aalis-test-missing-mcp-command', enabled: false };
    const { app, store } = hostedApp(
      { plugins: { [NAME]: { servers: [server] } } },
      {
        logger: silent,
        provider: {
          save: () => {
            throw new ConfigSaveRefusedError('配置文件有尚未生效的外部修改，为免覆盖已拒绝本次保存');
          },
        },
      },
    );
    apps.push(app);
    const registry = new ToolRegistry(silent);
    registry.setExecutionGuard(async () => null);
    app.bind({ provide }).provide(tools, registry);
    await registerFromDoc(app, store, mcpClient);
    await app.plugins.idle();

    const out = await registry.execute('mcp_set_server_enabled', { id: 'a', enabled: true }, { sessionId: 't' });
    await app.plugins.idle();

    // 运行态确已切换：只回一个错误的话，agent 会以为什么都没发生
    expect((app.plugins.getPlugin(NAME)?.config as Servers).servers[0].enabled).toBe(true);
    expect(out.content).toContain('运行态已生效');
    expect(out.content).toContain('写入配置文件失败：配置文件有尚未生效的外部修改');
    expect(out.content).toContain('可能回退');
  });

  it('宿主没提供 host-config：直接返回失败，运行态配置不变，也不 bounce', async () => {
    // 不经 hostedApp：宿主不装配置文档，插件的 host-config 可选依赖为空；plugins 服务照常在场
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    const host = app.bind({ events, provide });
    const registry = new ToolRegistry(silent);
    registry.setExecutionGuard(async () => null);
    host.provide(tools, registry);
    const unloaded: string[] = [];
    host.events.on('plugin:unloaded', id => {
      unloaded.push(id);
    });
    await app.plugin(mcpClient, { servers: [{ id: 'a', command: 'aalis-test-missing-mcp-command', enabled: false }] });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(NAME)?.state).toBe('active');

    const out = await registry.execute('mcp_set_server_enabled', { id: 'a', enabled: true }, { sessionId: 't' });
    expect(out.content).toMatch(/^失败：.*host-config/);
    await app.plugins.idle();

    // 改了却存不下，重启后会悄悄回退：运行态必须原样不动
    expect((app.plugins.getPlugin(NAME)?.config as Servers).servers[0].enabled).toBe(false);
    expect(unloaded, 'updateConfig 会 bounce 本插件，拆卸即发 plugin:unloaded').toEqual([]);
  });
});
