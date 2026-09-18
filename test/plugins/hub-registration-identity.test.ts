import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebUIService } from '../../packages/api-webui/src/index.js';
import { App } from '../../packages/core/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import * as webuiServer from '../../packages/plugin-webui-server/src/index.js';

// ════════════════════════════════════════════════════════════
// 枢纽服务的退订闭包必须按「这一次登记」比对，而不是按 name + contextId：
// 同一 Context 用同名重注册后，旧闭包仍然成立的判据会把新登记一起删掉。
// core 四个注册表按条目引用退订；这里钉住 tools / 工具分组 / webui 页面三处同一口径。
// ════════════════════════════════════════════════════════════

function silentLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

const def = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
});

describe('ToolRegistry 退订按条目身份', () => {
  it('同名重注册后，旧退订闭包不误删新登记；新闭包正常删', () => {
    const reg = new ToolRegistry(silentLogger());
    const oldOff = reg.register({ definition: def('t'), handler: async () => 'old' }, 'p');
    const newOff = reg.register({ definition: def('t'), handler: async () => 'new' }, 'p');

    oldOff();
    expect(
      reg.getAll().map(t => t.name),
      '旧闭包对已被替换的登记应无动作',
    ).toEqual(['t']);

    newOff();
    expect(reg.getAll(), '当前生效的登记由它自己的闭包删除').toEqual([]);
  });

  it('工具分组同一口径', () => {
    const reg = new ToolRegistry(silentLogger());
    const oldOff = reg.registerGroup({ name: 'g', description: 'old' }, 'p');
    reg.registerGroup({ name: 'g', description: 'new' }, 'p');

    oldOff();
    expect(reg.getGroups().map(g => g.description)).toEqual(['new']);
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

describe('webui-server 页面退订按条目身份', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.stop().catch(() => {});
  });

  it('同 key 重注册后，旧退订闭包不摘掉新登记', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger: silentLogger() });
    apps.push(app);
    await app.ctx.useModule(webuiServer as never, {
      port: await freePort(),
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'fixed',
      fixedToken: 'test-fixed-token-placeholder',
    });
    await app.plugins.idle();
    const svc = app.ctx.getService<WebUIService>('webui-server')!;
    const pages = () => svc.getPages().filter(p => p.pluginName === 'p');

    const oldOff = svc.registerPage({ key: 'k', label: 'old' }, 'p');
    const newOff = svc.registerPage({ key: 'k', label: 'new' }, 'p');
    expect(
      pages().map(p => p.label),
      '前置：同 key 两次登记并存',
    ).toEqual(['old', 'new']);

    newOff();
    expect(
      pages().map(p => p.label),
      '新闭包只摘自己那条',
    ).toEqual(['old']);
    oldOff();
    expect(pages()).toEqual([]);
  });
});
