import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type BoundTools, tools, withToolGroups } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import {
  App,
  definePlugin,
  type LifecycleCap,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 枢纽服务的退订闭包必须按「这一次登记」比对，而不是按 name + contextId：
// 同一登记者用同名重注册后，旧闭包仍然成立的判据会把新登记一起删掉。
// 枢纽登记表一律按条目引用退订；这里钉住 tools / 工具分组 / webui 页面 / agent 预处理器四处同一口径。
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
// tools 绑定接口每次激活一份账本、一条提供者订阅：同名替换、旧退订失效、
// 提供者换人一次回调整体重挂。一条登记一条订阅的做法下：同名覆盖不退订旧订阅，提供者
// 换人时早已退场的旧登记复活；同名刷新 N 次清理链长 4N；重挂逐条跨微任务。
// ════════════════════════════════════════════════════════════

/** 最小探针插件：把这次激活绑定的 tools 接口交给用例驱动 */
function toolsProbe(name: string, onBound: (bound: BoundTools) => void) {
  return definePlugin({
    name,
    // 声明为 optional：提供者换人期间探针必须留在激活态，否则测到的是「插件被重装」而非「绑定重挂」
    uses: { tools: optional(tools) },
    apply(caps) {
      onBound(caps.tools);
    },
  });
}

/** 等一个条件成立（每轮让出一拍宏任务），把「还没轮到」与「行为不对」分开 */
async function until(predicate: () => boolean, hops = 50): Promise<void> {
  for (let i = 0; i < hops && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  if (!predicate()) throw new Error('等待条件超时');
}

describe('tools 绑定：同名替换与整体重挂', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.stop().catch(() => {});
  });

  async function world() {
    const app = new App({ name: 'T', logLevel: 'error', logger: silentLogger() });
    apps.push(app);
    const host = app.bind({ provide });
    const reg = new ToolRegistry(silentLogger());
    const offProvide = host.provide(tools, reg);
    let bound!: BoundTools;
    await app.plugin(
      toolsProbe('p', b => {
        bound = b;
      }),
    );
    await app.plugins.idle();
    const state = app.plugins.getPlugin('p')?.state;
    if (state !== 'active') throw new Error(`探针未激活（state=${state}），断言无效`);
    return { app, host, reg, offProvide, tools: bound };
  }
  const names = (reg: ToolRegistry) => reg.getAll().map(t => t.name);
  const handlerOf = async (reg: ToolRegistry, name: string) =>
    (await reg.execute(name, {}, { sessionId: 's', platform: 'test' })).content;

  it('同名重注册是替换：旧退订 no-op；退订当前登记后换提供者，被替换的旧登记不复活', async () => {
    const { app, host, reg, offProvide, tools: bound } = await world();
    const oldOff = bound.register({ definition: def('t'), handler: async () => 'old' });
    const newOff = bound.register({ definition: def('t'), handler: async () => 'new' });
    expect(await handlerOf(reg, 't')).toBe('new');
    expect(
      reg.getAll().map(t => t.pluginName),
      '登记自动冠这次激活的身份',
    ).toEqual(['p']);
    // 只退当前登记、不动旧的：旧登记已被替换，不该有任何残留能在换提供者时复活
    newOff();
    expect(names(reg), '当前登记由它自己的闭包摘掉').toEqual([]);

    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    host.provide(tools, reg2);
    await app.plugins.idle();
    expect(names(reg2), '旧登记已随替换出账，换提供者不复活它').toEqual([]);
    oldOff();
    expect(names(reg2), '被替换的登记的退订闭包无动作').toEqual([]);
  });

  it('退订当前登记后再换提供者，枢纽为空；退订后可再注册同名', async () => {
    const { app, host, reg, offProvide, tools: bound } = await world();
    const off = bound.register({ definition: def('t'), handler: async () => 'v1' });
    off();
    expect(names(reg)).toEqual([]);
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    host.provide(tools, reg2);
    await app.plugins.idle();
    expect(names(reg2), '已退订的登记不随换提供者复活').toEqual([]);
    bound.register({ definition: def('t'), handler: async () => 'v2' });
    expect(await handlerOf(reg2, 't')).toBe('v2');
  });

  it('同名刷新 100 次：账上只留一条——换提供者时只重挂这一条', async () => {
    const { app, host, reg, offProvide, tools: bound } = await world();
    for (let i = 0; i < 100; i++) bound.register({ definition: def('t'), handler: async () => '' });
    expect(names(reg)).toEqual(['t']);
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    const registered = vi.spyOn(reg2, 'register');
    host.provide(tools, reg2);
    await app.plugins.idle();
    // 重挂是逐条发起的，调用次数即账上的条目数：刷新若各自留一条（或各自一条订阅），这里是 100
    expect(registered.mock.calls.length, '刷新不在账上堆条目').toBe(1);
    expect(names(reg2)).toEqual(['t']);
  });

  it('提供者重挂对同一次激活是整体的：任一微任务观察到的都是 0 或全部', async () => {
    const { host, offProvide, tools: bound } = await world();
    const total = 20;
    for (let i = 0; i < total; i++) bound.register({ definition: def(`t${i}`), handler: async () => '' });
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    host.provide(tools, reg2);
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

  it('分组同一口径：同名替换、旧退订失效、换提供者不复活', async () => {
    const { app, host, reg, offProvide, tools: bound } = await world();
    const oldOff = bound.registerGroup({ name: 'g', label: 'g', description: 'old' });
    const newOff = bound.registerGroup({ name: 'g', label: 'g', description: 'new' });
    expect(reg.getGroups().map(g => g.description)).toEqual(['new']);
    newOff();
    offProvide();
    const reg2 = new ToolRegistry(silentLogger());
    host.provide(tools, reg2);
    await app.plugins.idle();
    expect(reg2.getGroups(), '被替换的旧分组不随换提供者复活').toEqual([]);
    oldOff();
    expect(reg2.getGroups()).toEqual([]);
  });

  /** 带 warn 收集的世界：关闭后政策要数 warn */
  function warningWorld() {
    const warnings: string[] = [];
    const app = new App({
      name: 'T',
      logLevel: 'error',
      logger: {
        ...silentLogger(),
        warn: (m: unknown) => warnings.push(String(m)),
        child() {
          return this;
        },
      } as unknown as Logger,
    });
    apps.push(app);
    const reg = new ToolRegistry(silentLogger());
    app.bind({ provide }).provide(tools, reg);
    return { app, reg, warnings, refusals: () => warnings.filter(w => w.includes('忽略 tools 登记')).length };
  }

  it('拆卸后枢纽清空；关闭后的登记每次 warn、不进枢纽、不抛（与 core 登记面同口径）', async () => {
    const { app, reg, refusals } = warningWorld();
    let bound!: BoundTools;
    await app.plugin(
      toolsProbe('p', b => {
        bound = b;
      }),
    );
    await app.plugins.idle();
    bound.register({ definition: def('t'), handler: async () => '' });
    expect(names(reg), '前置：登记确实进了枢纽').toEqual(['t']);
    await app.plugins.unload('p');
    expect(names(reg)).toEqual([]);
    for (const n of ['late1', 'late2']) {
      expect(() => bound.register({ definition: def(n), handler: async () => '' })).not.toThrow();
    }
    expect(refusals()).toBe(2);
    expect(names(reg)).toEqual([]);
  });

  it('撤回按激活归属：卸载一个插件不动另一个插件的登记', async () => {
    const { app, reg, tools: bound } = await world();
    let other!: BoundTools;
    await app.plugin(
      toolsProbe('q', b => {
        other = b;
      }),
    );
    await app.plugins.idle();
    bound.register({ definition: def('t-p'), handler: async () => '' });
    other.register({ definition: def('t-q'), handler: async () => '' });
    expect(names(reg).sort()).toEqual(['t-p', 't-q']);
    await app.plugins.unload('p');
    expect(names(reg), '只摘掉被卸载那次激活的登记').toEqual(['t-q']);
  });

  it('拆卸窗口内（等在飞 apply）的登记与事件登记同口径：closed 即拒、warn、不进枢纽', async () => {
    const { app, reg, refusals } = warningWorld();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let life!: LifecycleCap;
    let lateOff!: () => void;
    // 插件在 apply 里跨 await 取资源、回来再登记，是生产里的常见形状：这段窗口内管理面
    // 可以卸载它（unload 撞上在飞 apply：先置终态，再等 apply 落定）。
    const lateRegistrar = definePlugin({
      name: 'late-registrar',
      uses: { tools: optional(tools), lifecycle },
      async apply(caps) {
        life = caps.lifecycle;
        caps.tools.register({ definition: def('early'), handler: async () => '' });
        await gate;
        lateOff = caps.tools.register({ definition: def('late'), handler: async () => '' });
      },
    });
    const mounting = app.plugin(lateRegistrar);
    await until(() => names(reg).length > 0);
    expect(names(reg)).toEqual(['early']);

    const unloading = app.plugins.unload('late-registrar');
    expect(life.closed, '卸载一经发起，在飞的 apply 立刻看得到').toBe(true);
    release();
    await mounting;
    await unloading;
    expect(refusals(), '窗口内的登记被拒并记 warn').toBe(1);
    expect(names(reg)).toEqual([]);
    expect(() => lateOff(), '拒收返回的退订可调、无动作').not.toThrow();
  });

  it('withToolGroups 视图的枢纽引用是活取的，跟着提供者换人', async () => {
    const { host, reg, offProvide, tools: bound } = await world();
    const view = withToolGroups(bound, ['g']);
    expect(view.current).toBe(reg);
    offProvide();
    expect(view.current).toBeUndefined();
    const reg2 = new ToolRegistry(silentLogger());
    host.provide(tools, reg2);
    expect(view.current).toBe(reg2);
  });

  it('withToolGroups 登记的工具带上默认分组，且并不覆盖工具自带的分组', async () => {
    const { reg, tools: bound } = await world();
    const view = withToolGroups(bound, ['g']);
    view.register({ definition: def('t'), handler: async () => '' });
    view.register({ definition: def('u'), handler: async () => '', groups: ['own'] });
    const groupsOf = (name: string) => reg.getAll().find(t => t.name === name)?.groups;
    expect(groupsOf('t')).toEqual(['g']);
    expect(groupsOf('u'), '自带分组在前，默认分组追加在后').toEqual(['own', 'g']);
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
    const app = new App({ name: 'T', logLevel: 'error', logger: silentLogger() });
    apps.push(app);
    await app.plugins.register(webuiServerPlugin, {
      port: await freePort(),
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'fixed',
      fixedToken: 'test-fixed-token-placeholder',
    });
    await app.plugins.idle();
    const svc = app.bind({ services }).services.get(webuiServer)!;
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

describe('agent 预处理器退订按条目身份', () => {
  it('同名替换后，旧退订闭包只摘自己的中间件，不删新登记的账目', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silentLogger() });
    await registerHubs(app);
    await app.plugins.register(agentPlugin, {});
    await app.plugins.idle();
    const host = app.bind({ services, hooks });
    const svc = host.services.get(agent)!;
    const ran: string[] = [];
    const handler = (tag: string) => async (_m: unknown, next: () => Promise<void>) => {
      ran.push(tag);
      await next();
    };
    const run = () =>
      host.hooks.run('agent:input:before', { message: {} as never, metadata: {} }, async () => undefined);

    const oldOff = svc.registerPreprocessor!('x', handler('old'));
    svc.registerPreprocessor!('x', handler('new'));
    oldOff();
    expect(
      svc.getPreprocessors?.().map(p => p.name),
      '旧闭包对已被替换的登记应无动作',
    ).toEqual(['x']);

    // 账目仍在，所以第三次同名登记能替换掉「new」的中间件——链上只剩最新一个
    svc.registerPreprocessor!('x', handler('newer'));
    await run();
    expect(ran).toEqual(['newer']);
    await app.stop();
  });
});
