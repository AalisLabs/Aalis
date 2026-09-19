import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { useToolService } from '../../packages/api-tools/src/index.js';
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
    const oldOff = reg.registerGroup({ name: 'g', label: 'g', description: 'old' }, 'p');
    reg.registerGroup({ name: 'g', label: 'g', description: 'new' }, 'p');

    oldOff();
    expect(reg.getGroups().map(g => g.description)).toEqual(['new']);
  });
});

// ════════════════════════════════════════════════════════════
// useToolService 每 Context 一份绑定、一条 whenService 订阅：同名替换、旧退订失效、
// 提供者重挂一次回调整体重挂。此前一条登记一条订阅——同名覆盖不退订旧订阅，提供者
// bounce 时早已退场的旧登记复活；同名刷新 N 次清理链长 4N；重挂逐条跨微任务。
// ════════════════════════════════════════════════════════════

describe('useToolService 绑定：同名替换与整体重挂', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.stop().catch(() => {});
  });

  function world() {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger: silentLogger() });
    apps.push(app);
    const reg = new ToolRegistry(silentLogger());
    const offProvide = app.ctx.provide('tools', reg);
    const ctx = app.ctx.fork('p');
    return { app, reg, offProvide, ctx, tools: useToolService(ctx) };
  }
  const names = (reg: ToolRegistry) => reg.getAll().map(t => t.name);
  const handlerOf = async (reg: ToolRegistry, name: string) =>
    (await reg.execute(name, {}, { sessionId: 's', platform: 'test' })).content;

  it('同名重注册是替换：旧退订 no-op；退订当前登记后 bounce，被替换的旧登记不复活', async () => {
    const { app, reg, offProvide, tools } = world();
    const oldOff = tools.register({ definition: def('t'), handler: async () => 'old' });
    const newOff = tools.register({ definition: def('t'), handler: async () => 'new' });
    expect(await handlerOf(reg, 't')).toBe('new');
    // 只退当前登记、不动旧的：旧登记已被替换，不该有任何残留能在 bounce 时复活
    newOff();
    expect(names(reg), '当前登记由它自己的闭包摘掉').toEqual([]);

    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    app.ctx.provide('tools', reg2);
    await app.plugins.idle();
    expect(names(reg2), '旧登记的订阅已随替换退场，bounce 不复活它').toEqual([]);
    oldOff();
    expect(names(reg2), '被替换的登记的退订闭包无动作').toEqual([]);
  });

  it('退订当前登记后再 bounce，枢纽为空；退订后可再注册同名', async () => {
    const { app, reg, offProvide, tools } = world();
    const off = tools.register({ definition: def('t'), handler: async () => 'v1' });
    off();
    expect(names(reg)).toEqual([]);
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    app.ctx.provide('tools', reg2);
    await app.plugins.idle();
    expect(names(reg2), '已退订的登记不随 bounce 复活').toEqual([]);
    tools.register({ definition: def('t'), handler: async () => 'v2' });
    expect(await handlerOf(reg2, 't')).toBe('v2');
  });

  it('同名刷新 100 次：清理链只有一条订阅的固定开销，枢纽 1 条', () => {
    const { reg, ctx, tools } = world();
    const base = ctx.disposableCount;
    tools.register({ definition: def('t'), handler: async () => '' });
    const perBinding = ctx.disposableCount - base;
    for (let i = 0; i < 100; i++) tools.register({ definition: def('t'), handler: async () => '' });
    expect(ctx.disposableCount - base, '刷新不新增订阅').toBe(perBinding);
    expect(names(reg)).toEqual(['t']);
  });

  it('提供者重挂对同一 Context 是整体的：任一微任务观察到的都是 0 或全部', async () => {
    const { app, offProvide, tools } = world();
    const total = 20;
    for (let i = 0; i < total; i++) tools.register({ definition: def(`t${i}`), handler: async () => '' });
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    app.ctx.provide('tools', reg2);
    const seen = new Set<number>();
    for (let hop = 0; hop < 50; hop++) {
      seen.add(reg2.getAll().length);
      await Promise.resolve();
    }
    expect(
      [...seen].every(n => n === 0 || n === total),
      `观察到部分重挂：${[...seen].join(',')}`,
    ).toBe(true);
    expect(reg2.getAll().length).toBe(total);
  });

  it('分组同一口径：同名替换、旧退订失效、bounce 不复活', async () => {
    const { app, reg, offProvide, tools } = world();
    const oldOff = tools.registerGroup({ name: 'g', label: 'g', description: 'old' });
    const newOff = tools.registerGroup({ name: 'g', label: 'g', description: 'new' });
    expect(reg.getGroups().map(g => g.description)).toEqual(['new']);
    newOff();
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    app.ctx.provide('tools', reg2);
    await app.plugins.idle();
    expect(reg2.getGroups(), '被替换的旧分组不随 bounce 复活').toEqual([]);
    oldOff();
    expect(reg2.getGroups()).toEqual([]);
  });

  it('拆卸后枢纽清空；关闭后的登记不进枢纽、不抛', async () => {
    const { reg, ctx, tools } = world();
    tools.register({ definition: def('t'), handler: async () => '' });
    await ctx.disposeAsync();
    expect(names(reg)).toEqual([]);
    expect(() => tools.register({ definition: def('late'), handler: async () => '' })).not.toThrow();
    expect(names(reg)).toEqual([]);
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
