import { afterEach, describe, expect, it } from 'vitest';
import { createPort } from '../../packages/core/src/context/binding.js';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  type ModuleHandle,
  optional,
  provide,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 段 A 对抗审计（39 个代理，探针在 Aalis-local-only/…/audit-a-*）确认的契约违例，逐条转成回归测试。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
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
  const app = new App({
    config: { name: 'T', logLevel: 'error', plugins: {} },
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
  it('跨层组合（子用祖先的服务 + 祖先用孙模块的服务）：业务依赖无环，两笔交接都成立，不报成环', async () => {
    const w = world();
    const psvc = defineService<Sink>('zz-aa-psvc');
    const gsvc = defineService<Sink>('zz-aa-gsvc');
    const g = sinkPlugin(w, gsvc, 'g');
    const a = definePlugin({
      name: 'a',
      uses: { psvc, lifecycle },
      async apply({ psvc, lifecycle }) {
        await lifecycle.module(g);
        lifecycle.onDrain(() => psvc.require().save('a-last'));
      },
    });
    await w.app.plugin(
      definePlugin({
        name: 'p',
        uses: { gsvc: optional(gsvc), provide, lifecycle },
        async apply({ gsvc, provide, lifecycle }) {
          provide(psvc, { save: data => void w.saved.push(`p:${data}`) });
          await lifecycle.module(a);
          lifecycle.onDrain(() => gsvc.require().save('p-last'));
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.saved.sort()).toEqual(['g:p-last', 'p:a-last']);
    expect(w.warnings.filter(x => x.includes('成环'))).toEqual([]);
  });

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

  it('宿主 logger 的 sink 抛错：成环告警与单阶段失败都不让整批停机流产', async () => {
    const closed: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message: unknown) => {
        if (String(message).includes('成环')) throw new Error('sink boom');
      },
      error() {},
      child: () => logger,
    };
    const w = world({ logger });
    const a = defineService<object>('zz-aa-cyc-a');
    const b = defineService<object>('zz-aa-cyc-b');
    const mk = (name: string, mine: typeof a, other: typeof a) =>
      definePlugin({
        name,
        uses: { other: optional(other), provide, lifecycle },
        apply({ provide, lifecycle }) {
          provide(mine, {});
          lifecycle.onDispose(() => void closed.push(name));
        },
      });
    await w.app.plugin(mk('x', a, b));
    await w.app.plugin(mk('y', b, a));
    await w.app.plugin(
      definePlugin({
        name: 'bystander',
        uses: { lifecycle },
        apply: ({ lifecycle }) => void lifecycle.onDispose(() => void closed.push('bystander')),
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(closed.sort()).toEqual(['bystander', 'x', 'y']);
  });
});

describe('等待业务交出来的 Promise', () => {
  it('子模块挂载失败的回滚：apply 抛错前登记的异步清理落定之后，module() 才抛出', async () => {
    const w = world();
    let cleaned = false;
    const child = definePlugin({
      name: 'child',
      uses: { lifecycle },
      apply({ lifecycle }) {
        lifecycle.onDispose(async () => {
          await sleep(20);
          cleaned = true;
        });
        throw new Error('mount failed');
      },
    });
    let cleanedWhenRejected: boolean | undefined;
    await w.app.plugin(
      definePlugin({
        name: 'parent',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(child).catch(() => {
            cleanedWhenRejected = cleaned;
          });
        },
      }),
    );
    await w.app.plugins.idle();
    expect(cleanedWhenRejected).toBe(true);
  });

  it('收尾段里才登记的 onDrain：同样被等到', async () => {
    const w = world();
    const ctx = w.app.ctx.fork('p');
    let finished = false;
    ctx.onDrain(() => {
      ctx.onDrain(async () => {
        await sleep(20);
        finished = true;
      });
    });
    await ctx.disposeAsync();
    expect(finished).toBe(true);
  });

  it('在飞清理永不落定：超时点名一次、随即出账，后续各段不再重复计时', async () => {
    const w = world();
    const ctx = w.app.ctx.fork('p');
    const port = createPort<unknown>(ctx, 'zz-aa-stuck');
    port.track(() => new Promise<void>(() => {}), 'zz-aa-stuck-handle')();
    const started = Date.now();
    await ctx.disposeAsync(60);
    const elapsed = Date.now() - started;
    expect(elapsed, `耗时 ${elapsed}ms`).toBeLessThan(150);
    const named = w.warnings.filter(x => x.includes('zz-aa-stuck-handle') && x.includes('60ms'));
    expect(named, w.warnings.join(' | ')).toHaveLength(1);
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

  it('来自另一份 core 副本的内置能力描述符：明确报错进 error，不静默停在 pending', async () => {
    const w = world();
    // 另一份副本的内置描述符：标记经全局 symbol 注册表可识别，但资源口不属于本副本的任何激活
    const foreign = {
      name: 'logger',
      [Symbol.for('aalis.builtin-capability')]: true,
      bind(): never {
        throw new Error('资源口不属于本 core 副本的任何激活（@aalis/core 必须是单副本 peer 依赖）');
      },
    };
    await w.app.plugin(definePlugin({ name: 'mixed', uses: { logger: foreign }, apply() {} }));
    await w.app.plugins.idle();
    const status = w.app.plugins.getStatus().find(s => s.instanceId === 'mixed');
    expect(status?.state).toBe('error');
    expect(status?.error).toContain('单副本');
  });

  it('包根导出的 ModuleHandle 就是 lifecycle.module() 的返回类型，带子激活 id', async () => {
    const w = world();
    let handle: ModuleHandle | undefined;
    await w.app.plugin(
      definePlugin({
        name: 'host-plugin',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          handle = await lifecycle.module(definePlugin({ name: 'kid', apply() {} }));
        },
      }),
    );
    await w.app.plugins.idle();
    expect(handle?.id).toBe('host-plugin#kid');
  });
});
