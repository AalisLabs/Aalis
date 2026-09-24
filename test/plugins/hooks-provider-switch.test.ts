import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import { App, definePlugin, type Logger, provide } from '../../packages/core/src/index.js';
import { Registry as ContributionTable } from '../../packages/plugin-contributions/src/index.js';
import { Registry as HookTable } from '../../packages/plugin-hooks/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 钩子与贡献点由插件提供之后，提供者本身会上下线或换人。本文件钉住这几种情形下的实际行为：
//   - 卡链告警改由 plugin-hooks 的日志器发出；
//   - 没有提供者时 run 以被拒的 Promise 传出，不执行默认动作；
//   - 提供者 bounce：依赖方随之重启，链按重新激活的次序重建，与冷启动同序；
//   - 非独占下第二个提供者以更高优先级上线（热换）：消费者不重启，账本整体重挂。每条登记自带登记序，
//     新提供者按它排链，链序与换人前相同。
//   - 已知现状：换人时正在执行的链会跳过已移走的 handler，截停者被跳过时默认动作照样执行。旧登记表分不清
//     「插件关了」与「搬去了新提供者」，两种修法各有代价；触发需运行中上线第二个钩子提供者，首方没有这种部署。
//     在这里显式钉住，改动时必须是有意识的。
// ════════════════════════════════════════════════════════════

const H = '__t:switch' as never;
const POINT = '__t:switch-point' as never;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world(logger?: Logger): App {
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  return app;
}

/** 以更高优先级提供第二份钩子登记表的插件（非独占，合法） */
const altHooks = definePlugin({
  name: 'alt-hooks',
  uses: { provide },
  provides: [hooks],
  apply: ({ provide }) => void provide(hooks, new HookTable(), { priority: 10 }),
});

/** 在 apply 里登记一条中间件的消费者；facade 留给测试在运行期再登记 */
function consumer(name: string, trail: string[], applied: string[], facades?: Map<string, Hooks>) {
  return definePlugin({
    name,
    uses: { hooks },
    apply({ hooks }) {
      applied.push(name);
      facades?.set(name, hooks);
      hooks.middleware(H, async (_d, next) => {
        trail.push(`${name}1`);
        await next();
      });
    },
  });
}

describe('卡链告警与无提供者', () => {
  it('广播相位里 handler 没调 next：plugin-hooks 的日志器点名肇事者与被跳过的数量', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message: string) => void warns.push(message),
      error() {},
      child: () => logger,
    };
    const app = world(logger);
    await registerHubs(app);
    await app.pluginAll(
      [
        definePlugin({
          name: 'stuck',
          uses: { hooks },
          apply: ({ hooks }) => void hooks.middleware(H, async () => {}),
        }),
        definePlugin({
          name: 'after',
          uses: { hooks },
          apply: ({ hooks }) => void hooks.middleware(H, async (_d, next) => next()),
        }),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    const host = app.bind({ hooks });
    expect(await host.hooks.run(H, {} as never, undefined, { warnOnStall: true })).toBe(false);
    expect(warns).toContain(`钩子 ${H}: handler(来自 stuck) 未调用 next()，其后 1 个 handler 被跳过`);
  });

  it('没有提供者：run 以被拒的 Promise 传出（不在调用点同步抛），默认动作不执行', async () => {
    const app = world();
    const host = app.bind({ hooks });
    let ran = false;
    let pending: Promise<boolean> | undefined;
    expect(() => {
      pending = host.hooks.run(H, {} as never, async () => {
        ran = true;
      });
    }).not.toThrow();
    await expect(pending).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe('提供者 bounce：依赖方重启，链与冷启动同序', () => {
  it('bounce plugin-hooks 后各消费者重新激活，链序与冷启动相同', async () => {
    const trail: string[] = [];
    const applied: string[] = [];
    const app = world();
    await app.pluginAll(
      [
        (await import('../../packages/plugin-hooks/src/index.js')).default,
        (await import('../../packages/plugin-contributions/src/index.js')).default,
        consumer('a', trail, applied),
        consumer('b', trail, applied),
        consumer('c', trail, applied),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    const host = app.bind({ hooks });
    await host.hooks.run(H, {} as never);
    const cold = [...trail];
    expect(cold).toEqual(['a1', 'b1', 'c1']);

    expect(await app.plugins.bounce('@aalis/plugin-hooks')).toBe(true);
    await app.plugins.idle();
    expect(applied, '三个 required 消费者都随提供者重启').toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    trail.length = 0;
    await host.hooks.run(H, {} as never);
    expect(trail).toEqual(cold);
  });
});

describe('非独占热换（第二个提供者以更高优先级上线）', () => {
  it('消费者不重启，账本整体重挂到新提供者；跨消费者交错登记的链序保持不变', async () => {
    const trail: string[] = [];
    const applied: string[] = [];
    const facades = new Map<string, Hooks>();
    const app = world();
    await registerHubs(app);
    await app.pluginAll(
      [consumer('a', trail, applied, facades), consumer('b', trail, applied, facades)].map(definition => ({
        definition,
      })),
    );
    await app.plugins.idle();
    // a 在 b 之后再登记一条：原表里是 a1、b1、a2 交错
    facades.get('a')?.middleware(H, async (_d, next) => {
      trail.push('a2');
      await next();
    });
    const host = app.bind({ hooks });
    await host.hooks.run(H, {} as never);
    expect(trail).toEqual(['a1', 'b1', 'a2']);

    await app.plugin(altHooks);
    await app.plugins.idle();
    trail.length = 0;
    await host.hooks.run(H, {} as never);
    expect(applied, '消费者没有重启').toEqual(['a', 'b']);
    expect(trail, '账本整批重挂，但新提供者按登记序排链：仍是 a1、b1、a2 交错').toEqual(['a1', 'b1', 'a2']);
  });

  it('已知现状：在飞链途中换人，已移走的截停者被跳过，run 返回 true 且执行默认动作', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let entered!: () => void;
    const inFirst = new Promise<void>(r => {
      entered = r;
    });
    const app = world();
    await registerHubs(app);
    await app.pluginAll(
      [
        definePlugin({
          name: 'slow',
          uses: { hooks },
          apply: ({ hooks }) =>
            void hooks.middleware(H, async (_d, next) => {
              entered();
              await gate;
              await next();
            }),
        }),
        // 截停者：不调 next，默认动作本不该执行
        definePlugin({
          name: 'guard',
          uses: { hooks },
          apply: ({ hooks }) => void hooks.middleware(H, async () => {}),
        }),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    const host = app.bind({ hooks });

    // 对照：不换人时被截停
    let defaulted = false;
    const control = host.hooks.run(H, {} as never, async () => {
      defaulted = true;
    });
    await inFirst;
    release();
    expect(await control).toBe(false);
    expect(defaulted).toBe(false);

    // 换人：链执行到一半时第二个提供者上线
    let reopen!: () => void;
    const gate2 = new Promise<void>(r => {
      reopen = r;
    });
    let entered2!: () => void;
    const inFirst2 = new Promise<void>(r => {
      entered2 = r;
    });
    const slowAgain = definePlugin({
      name: 'slow2',
      uses: { hooks },
      apply: ({ hooks }) =>
        void hooks.middleware('__t:switch-2' as never, async (_d, next) => {
          entered2();
          await gate2;
          await next();
        }),
    });
    const guardAgain = definePlugin({
      name: 'guard2',
      uses: { hooks },
      apply: ({ hooks }) => void hooks.middleware('__t:switch-2' as never, async () => {}),
    });
    await app.pluginAll([slowAgain, guardAgain].map(definition => ({ definition })));
    await app.plugins.idle();
    let defaulted2 = false;
    const running = host.hooks.run('__t:switch-2' as never, {} as never, async () => {
      defaulted2 = true;
    });
    await inFirst2;
    await app.plugin(altHooks);
    await app.plugins.idle();
    reopen();
    expect(await running, '已知现状：截停者已移到新表，旧表上的在飞链把它当作已撤回跳过').toBe(true);
    expect(defaulted2).toBe(true);
  });

  it('贡献点热换：条目整体重挂，collect 结果不变（按全局键排序，与登记次序无关）', async () => {
    const app = world();
    await registerHubs(app);
    await app.pluginAll(
      ['x', 'y'].map(name => ({
        definition: definePlugin({
          name,
          uses: { contributions },
          apply: ({ contributions }) => void contributions.contribute(POINT, { id: 'blk' } as never),
        }),
      })),
    );
    await app.plugins.idle();
    const host = app.bind({ contributions });
    const before = host.contributions.collect(POINT).map(h => h.key);
    expect(before).toEqual(['x/blk', 'y/blk']);
    await app.plugin(
      definePlugin({
        name: 'alt-contributions',
        uses: { provide },
        provides: [contributions],
        apply: ({ provide }) => void provide(contributions, new ContributionTable(), { priority: 10 }),
      }),
    );
    await app.plugins.idle();
    expect(host.contributions.collect(POINT).map(h => h.key)).toEqual(before);
  });
});
