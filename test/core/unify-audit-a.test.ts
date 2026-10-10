import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { BindingPort } from '../../packages/core/src/index.js';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
} from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 段 A 对抗审计（39 个代理，探针在 Aalis-local-only/…/audit-a-*）确认的契约违例，逐条转成回归测试。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const tick = () => new Promise<void>(r => setImmediate(r));

const apps: App[] = [];
const coreCopies: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
afterAll(() => {
  for (const dir of coreCopies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(options?: { disposeTimeoutMs?: number; logger?: Logger }) {
  const log: string[] = [];
  const saved: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = options?.logger ?? {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    child: () => logger,
  };
  const app = createInspectableApp({
    name: 'T',
    logLevel: 'error',
    logger,
    disposeTimeoutMs: options?.disposeTimeoutMs,
  });
  apps.push(app);
  return { app, log, saved, warnings };
}
type World = ReturnType<typeof world>;

interface Sink {
  save(data: string): void;
}
/** 关闭后 save 抛错的下层：用来证明「调用时它还活着」 */
const sinkPlugin = (w: World, descriptor: ReturnType<typeof defineService<Sink>>, name: string) =>
  definePlugin({
    name,
    uses: { provide, lifecycle },
    apply({ provide, lifecycle }) {
      let closed = false;
      provide(descriptor, {
        save(data) {
          if (closed) throw new Error(`${name} 已关闭`);
          w.saved.push(`${name}:${data}`);
        },
      });
      lifecycle.onDispose(() => {
        closed = true;
        w.log.push(`close:${name}`);
      });
    },
  });

describe('关停编排', () => {
  it('宿主根激活进同一张计划：宿主的收尾够得到插件提供的服务', async () => {
    const w = world();
    const store = defineService<Sink>('zz-aa-store');
    await w.app.plugin(sinkPlugin(w, store, 'store'));
    await w.app.plugins.idle();
    const host = w.app.bind({ store, lifecycle });
    host.lifecycle.onDrain(() => host.store.require().save('host-last'));
    await w.app.stop();
    expect(w.saved).toEqual(['store:host-last']);
  });

  it('required 依赖消失的同轮级联停用：消费者先于提供者，与注册先后无关', async () => {
    for (const consumerFirst of [true, false]) {
      const w = world();
      const gate = defineService<object>('zz-aa-gate');
      const mem = defineService<Sink>('zz-aa-mem');
      const gatePlugin = definePlugin({
        name: 'gate',
        uses: { provide },
        apply: ({ provide }) => void provide(gate, {}),
      });
      const memPlugin = definePlugin({
        name: 'mem',
        uses: { gate, provide, lifecycle },
        apply({ provide, lifecycle }) {
          let closed = false;
          provide(mem, {
            save(data) {
              if (closed) throw new Error('mem 已关闭');
              w.saved.push(data);
            },
          });
          lifecycle.onDispose(() => {
            closed = true;
          });
        },
      });
      const agent = definePlugin({
        name: 'agent',
        uses: { gate, mem: optional(mem), lifecycle },
        apply({ mem, lifecycle }) {
          lifecycle.onDrain(() => mem.require().save('agent:last'));
        },
      });
      await w.app.plugin(gatePlugin);
      for (const plugin of consumerFirst ? [agent, memPlugin] : [memPlugin, agent]) await w.app.plugin(plugin);
      await w.app.plugins.idle();
      await w.app.plugins.disable('gate');
      await w.app.plugins.idle();
      expect(w.saved, `consumerFirst=${consumerFirst} ${w.warnings.join(' | ')}`).toEqual(['agent:last']);
    }
  });

  it('依赖丢失的连带退场：随这批一起失去全部提供者的下游同批收尾，收尾时上游仍在', async () => {
    const w = world();
    const gate = defineService<object>('zz-aa-cascade-gate');
    const mem = defineService<Sink>('zz-aa-cascade-mem');
    const offGate = w.app.bind({ provide }).provide(gate, {});
    await w.app.plugin(
      definePlugin({
        name: 'mem',
        uses: { gate, provide, lifecycle },
        apply({ provide, lifecycle }) {
          let closed = false;
          provide(mem, {
            save(data) {
              if (closed) throw new Error('mem 已关闭');
              w.saved.push(data);
            },
          });
          lifecycle.onDispose(() => {
            closed = true;
          });
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'agent',
        uses: { mem, lifecycle },
        apply: ({ mem, lifecycle }) => void lifecycle.onDrain(() => mem.require().save('agent:last')),
      }),
    );
    await w.app.plugins.idle();
    offGate(); // 非管理撤回：mem 丢了 gate，agent 自己没丢东西
    await w.app.plugins.idle();
    expect(w.saved, w.warnings.join(' | ')).toEqual(['agent:last']);
    expect(w.app.plugins.getStatus().map(p => p.state)).toEqual(['pending', 'pending']);
  });

  it('依赖丢失的连带退场：别的计划正关着的提供者不算还在，下游同批收尾', async () => {
    const w = world();
    const gate = defineService<object>('zz-aa-closing-gate');
    const mem = defineService<object>('zz-aa-closing-mem');
    const offGate = w.app.bind({ provide }).provide(gate, {});
    const seen: boolean[] = [];
    const memPlugin = (name: string, priority: number, drainMs: number) =>
      definePlugin({
        name,
        provides: [mem],
        uses: { gate, provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(mem, {}, { priority });
          lifecycle.onDrain(() => sleep(drainMs));
        },
      });
    await w.app.pluginAll([
      { definition: memPlugin('backup', 0, 40) },
      { definition: memPlugin('main', 10, 0) },
      {
        definition: definePlugin({
          name: 'agent',
          uses: { mem, lifecycle },
          apply: ({ mem, lifecycle }) => void lifecycle.onDrain(() => void seen.push(mem.current !== undefined)),
        }),
      },
    ]);
    await w.app.plugins.idle();
    // 慢激活占住重算，下面的依赖丢失在 bounce 关着 backup 的时候判定
    const registering = w.app.plugin(definePlugin({ name: 'busy', apply: () => sleep(30) }));
    await sleep(2);
    const bouncing = w.app.plugins.bounce('backup');
    await sleep(2);
    offGate(); // main 丢了 gate；backup 正在关，agent 的 mem 随 main 一起失去全部提供者
    await Promise.all([registering, bouncing]);
    await w.app.plugins.idle();
    expect(seen, w.warnings.join(' | ')).toEqual([true]);
  });

  it('停机计划在飞时并发 unload 一个提供者：汇入计划，不抢在消费者之前拆', async () => {
    const w = world();
    const store = defineService<Sink>('zz-aa-store2');
    const gate = deferred();
    await w.app.plugin(sinkPlugin(w, store, 'storage'));
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { store, lifecycle },
        apply({ store, lifecycle }) {
          lifecycle.onDrain(async () => {
            await gate.promise;
            store.require().save('last');
          });
        },
      }),
    );
    await w.app.plugins.idle();
    const stopping = w.app.stop();
    await tick();
    const unloading = w.app.plugins.unload('storage');
    await sleep(10);
    expect(w.log, '消费者还卡在收尾上，提供者不得先关').toEqual([]);
    gate.resolve();
    await Promise.all([stopping, unloading]);
    expect(w.saved).toEqual(['storage:last']);
  });
});

describe('等待业务交出来的 Promise', () => {
  it('收尾段里才登记的 onDrain：同样被等到', async () => {
    const w = world();
    const activation = activationHost(w.app).create('p');
    let finished = false;
    activation.resources.onDrain(() => {
      activation.resources.onDrain(async () => {
        await sleep(20);
        finished = true;
      });
    });
    await activation.disposeAsync();
    expect(finished).toBe(true);
  });

  const stuck = () => new Promise<void>(() => {});
  it.each([
    ['手动退订启动的', (port: BindingPort<unknown>) => port.track(stuck, 'zz-aa-stuck-handle')()],
    ['关闭时撤回的', (port: BindingPort<unknown>) => void port.track(stuck, 'zz-aa-stuck-handle')],
    [
      '注册账本的',
      (port: BindingPort<unknown>) =>
        void port.registrar<string>({ key: key => key, register: () => stuck }).add('zz-aa-stuck-handle'),
    ],
  ])('在飞清理永不落定（%s）：超时点名一次，后续各段不再重复计时', async (_, start) => {
    const w = world();
    const svc = defineService<unknown, BindingPort<unknown>>('zz-aa-stuck', port => port);
    w.app.bind({ provide }).provide(svc, {});
    const activation = activationHost(w.app).create('p');
    start(activationHost(w.app).bind(activation, { port: svc }).port);
    const started = Date.now();
    await activation.disposeAsync(60);
    const elapsed = Date.now() - started;
    expect(elapsed, `耗时 ${elapsed}ms`).toBeLessThan(150);
    expect(w.warnings.filter(x => x.includes('60ms'))).toEqual([expect.stringContaining('zz-aa-stuck-handle')]);
  });
});

describe('注册账本', () => {
  it('register 回调里重入 add：换提供者重挂时每条只登记一次，关闭后枢纽清空', async () => {
    const w = world();
    interface Item {
      name: string;
      onRegister?: () => void;
    }
    const makeHub = () => {
      const live = new Map<number, string>();
      let seq = 0;
      return {
        names: () => [...live.values()].sort(),
        register(item: Item) {
          const id = ++seq;
          live.set(id, item.name);
          item.onRegister?.();
          return () => void live.delete(id);
        },
      };
    };
    type Hub = ReturnType<typeof makeHub>;
    const hub = defineService<Hub, { add(item: Item): () => void }>('zz-aa-hub', port => {
      const book = port.registrar<Item>({ key: item => item.name, register: (h, item) => h.register(item) });
      return { add: item => book.add(item) };
    });
    const host = w.app.bind({ provide }).provide;
    const hubA = makeHub();
    const hubB = makeHub();
    host(hub, hubA, { priority: 1, entryId: 'root/a' });
    let n = 0;
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { h: hub },
        apply({ h }) {
          h.add({ name: 'x', onRegister: () => void h.add({ name: `y${++n}` }) });
        },
      }),
    );
    await w.app.plugins.idle();
    host(hub, hubB, { priority: 2, entryId: 'root/b' });
    await tick();
    const names = hubB.names();
    expect(new Set(names).size, `重复登记：${names}`).toBe(names.length);
    await w.app.plugins.unload('consumer');
    expect(hubA.names()).toEqual([]);
    expect(hubB.names()).toEqual([]);
  });
});

describe('调度与类型面', () => {
  it('停机之后的管理操作窗口里调 idle()：必须落定', async () => {
    const w = world();
    await w.app.plugin(definePlugin({ name: 'p', apply() {} }));
    await w.app.plugins.idle();
    await w.app.plugins.disable('p');
    await w.app.stop();
    const unloading = w.app.plugins.unload('p');
    const settled = await Promise.race([w.app.plugins.idle().then(() => 'settled'), sleep(300).then(() => 'hung')]);
    await unloading;
    expect(settled).toBe('settled');
  });

  it('另一份 core 造的描述符与 optional 包装：注册时按 error 点名拒绝，定义与发布时直接抛错', async () => {
    type CoreNs = typeof import('../../packages/core/src/index.js');
    const srcRoot = fileURLToPath(new URL('../../packages/core/src', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'aalis-core-copy-'));
    coreCopies.push(dir);
    cpSync(srcRoot, dir, { recursive: true });
    const B = (await import(`${pathToFileURL(join(dir, 'index.ts')).href}?copy=2`)) as CoreNs;
    const errors: string[] = [];
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...a: unknown[]) => void warns.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => void errors.push(a.map(String).join(' ')),
      child: () => logger,
    };
    const w = world({ logger });
    // 另一份 core 的 definePlugin 只认自己的章，能造出定义；交到宿主注册时被拒
    expect(await w.app.plugin(B.definePlugin({ name: 'mixed', uses: { logger: B.logger }, apply() {} }))).toBe(false);
    expect(
      await w.app.plugin(
        B.definePlugin({ name: 'mixed-opt', uses: { x: B.optional(B.defineService('x')) }, apply() {} }),
      ),
    ).toBe(false);
    expect(errors.filter(l => l.includes('另一份 @aalis/core'))).toHaveLength(2);
    expect(warns.filter(l => l.includes('另一份 @aalis/core'))).toEqual([]);
    expect(w.app.plugins.getStatus()).toEqual([]);
    // 本份 core 的 definePlugin 在定义时就拒绝另一份的描述符；发布另一份的描述符同样拒绝
    expect(() => definePlugin({ name: 'ours', uses: { logger: B.logger }, apply() {} })).toThrow('另一份 @aalis/core');
    const { provide: publish } = w.app.bind({ provide });
    // 排查指引给文档站地址：npm 装的项目里没有仓库的 docs/ 目录
    expect(() => publish(B.defineService('copy-svc'), {})).toThrow(
      'https://aalis.acenyan.com/guide/third-party-plugin#two-cores',
    );
  });
});
