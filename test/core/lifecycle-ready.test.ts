import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type AppOptions,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// lifecycle.onReady：整体装好之后开始对外干活的回调，每次激活跑一次。
//   - start() 等静置后，按激活顺序逐个激活、同一激活内按登记序逐个等；宿主根排在全部插件之后；
//   - 启动之后才激活的（启用、重启、热装），在自己的 apply 落定后跑，重算与 idle() 不等它；
//   - 已就绪之后才登记的，下一个微任务跑；
//   - 单个回调至多等 slowThresholdMs；抛错、拒绝只记在该激活名下；
//   - 退订的、所属激活已开始关闭的不跑；在跑的回调算这次激活的在飞工作，关闭等它落定。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const never = () => new Promise<void>(() => {});
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${ms}ms 内未落定: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 一个 App 与它的 warn 记录：每条带上记它的日志作用域（aalis、aalis:插件 id、aalis:plugins） */
function world(options: Partial<AppOptions> = {}) {
  const warns: string[] = [];
  const scoped = (scope: string): Logger => ({
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(`[${scope}] ${args.map(String).join(' ')}`),
    error() {},
    child: name => scoped(`${scope}:${name}`),
  });
  const app = new App({ name: 'T', logger: scoped('aalis'), slowThresholdMs: 30, ...options });
  apps.push(app);
  return { app, warns };
}

const base = defineService<{ tag: string }>('ready-test:base');

describe('lifecycle.onReady：start() 里的次序与等待', () => {
  it('按激活顺序逐个等：被依赖的先跑，前一个落定后一个才开始，全部落定 start() 才返回', async () => {
    const { app } = world();
    const log: string[] = [];
    const hook = (tag: string) => async () => {
      log.push(`${tag}:开始`);
      await sleep(10);
      log.push(`${tag}:结束`);
    };
    // 依赖方先登记：激活顺序把提供者排到它前面
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'consumer',
          uses: { lifecycle, base },
          apply: caps => void caps.lifecycle.use.onReady(hook('consumer')),
        }),
      },
      {
        definition: definePlugin({
          name: 'provider',
          provides: [base],
          uses: { lifecycle, provide },
          apply(caps) {
            caps.provide.use(base, { tag: 'p' });
            caps.lifecycle.use.onReady(hook('provider'));
          },
        }),
      },
    ]);
    expect(log, '启动之前不跑').toEqual([]);
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['provider:开始', 'provider:结束', 'consumer:开始', 'consumer:结束']);
  });

  it('同一个激活的多个回调按登记序逐个跑', async () => {
    const { app } = world();
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(async () => {
            await sleep(10);
            log.push('一');
          });
          lifecycle.use.onReady(() => void log.push('二'));
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['一', '二']);
  });

  it('宿主根（app.bind）登记的回调排在全部插件之后', async () => {
    const { app } = world();
    const log: string[] = [];
    app.bind({ lifecycle }).lifecycle.use.onReady(() => void log.push('root'));
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply: ({ lifecycle }) => void lifecycle.use.onReady(() => void log.push('p')),
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['p', 'root']);
  });

  it('start() 先等在飞的重算静置：正在激活的插件也在这次启动里被等到', async () => {
    const { app } = world();
    const log: string[] = [];
    void app.plugin(
      definePlugin({
        name: 'slow-apply',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await sleep(10);
          lifecycle.use.onReady(async () => {
            await sleep(10);
            log.push('ready');
          });
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['ready']);
  });

  it('回调抛错或拒绝：只记在该激活名下，其余回调照常跑，start() 不拒绝', async () => {
    const { app, warns } = world();
    const log: string[] = [];
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'bad',
          uses: { lifecycle },
          apply({ lifecycle }) {
            lifecycle.use.onReady(() => {
              throw new Error('同步抛');
            });
            lifecycle.use.onReady(async () => {
              throw new Error('异步拒');
            });
            lifecycle.use.onReady(() => void log.push('bad:第三个'));
          },
        }),
      },
      {
        definition: definePlugin({
          name: 'good',
          uses: { lifecycle },
          apply: ({ lifecycle }) => void lifecycle.use.onReady(() => void log.push('good')),
        }),
      },
    ]);
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['bad:第三个', 'good']);
    expect(warns).toEqual([
      '[aalis:bad] Resources "bad": onReady 回调抛错，已忽略: Error: 同步抛',
      '[aalis:bad] Resources "bad": onReady 回调抛错，已忽略: Error: 异步拒',
    ]);
  });

  it('单个回调超过 slowThresholdMs：点名告警、不再等它，后面的照常跑；它之后才到的拒绝照常记', async () => {
    const { app, warns } = world();
    const log: string[] = [];
    let fail!: (err: Error) => void;
    await app.plugin(
      definePlugin({
        name: 'hanging',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(() => new Promise<void>((_, reject) => (fail = reject)));
          lifecycle.use.onReady(() => void log.push('后一个'));
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['后一个']);
    expect(warns).toEqual(['[aalis:hanging] Resources "hanging": 等待 onReady 回调超过 30ms，放弃等待']);
    fail(new Error('迟到的拒绝'));
    await tick();
    expect(warns[1]).toBe('[aalis:hanging] Resources "hanging": onReady 回调抛错，已忽略: Error: 迟到的拒绝');
  });

  it('阈值为 0：逐个等到回调返回，不告警', async () => {
    const { app, warns } = world({ slowThresholdMs: 0 });
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(async () => {
            await sleep(60);
            log.push('慢的');
          });
          lifecycle.use.onReady(() => void log.push('后一个'));
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['慢的', '后一个']);
    expect(warns).toEqual([]);
  });

  it('启动途中停机开始：还没轮到的回调不再跑，也不记「启动完成」', async () => {
    const infos: string[] = [];
    const logger: Logger = {
      debug() {},
      info: (...args: unknown[]) => void infos.push(args.map(String).join(' ')),
      warn() {},
      error() {},
      child: () => logger,
    };
    const { app } = world({ logger });
    const log: string[] = [];
    let stopping: Promise<void> | undefined;
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'a',
          uses: { lifecycle },
          apply: ({ lifecycle }) =>
            void lifecycle.use.onReady(() => {
              log.push('a');
              stopping = app.stop();
            }),
        }),
      },
      {
        definition: definePlugin({
          name: 'b',
          uses: { lifecycle },
          apply: ({ lifecycle }) => void lifecycle.use.onReady(() => void log.push('b')),
        }),
      },
    ]);
    await within(app.start(), 1000, 'start');
    await within(stopping!, 1000, 'stop');
    expect(log).toEqual(['a']);
    expect(infos).toContain('正在启动...');
    expect(infos).not.toContain('启动完成');
  });
});

describe('lifecycle.onReady：启动之后才激活的插件', () => {
  it('apply 落定后跑一次；重算与 idle() 不等它，回调里等 idle() 不互等', async () => {
    const { app } = world();
    await app.start();
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'late',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(async () => {
            log.push('开始');
            await app.plugins.idle();
            await sleep(10);
            log.push('结束');
          });
          log.push('apply');
        },
      }),
    );
    await within(app.plugins.idle(), 200, 'idle');
    expect(app.plugins.getPlugin('late')?.state).toBe('active');
    expect(log.includes('结束'), 'idle() 不等就绪回调').toBe(false);
    await sleep(40);
    expect(log).toEqual(['apply', '开始', '结束']);
  });

  it('就绪相位途中才激活的插件（它等的服务在别人的就绪回调里才上线）：落定后自己跑一次', async () => {
    const { app } = world();
    const late = defineService<{ v: number }>('ready-test:late');
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { lifecycle, late },
        apply: ({ lifecycle }) => void lifecycle.use.onReady(() => void log.push('consumer')),
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('pending');
    // 宿主在自己的就绪回调里才提供这个服务，随后另一个回调还在等
    const host = app.bind({ lifecycle, provide });
    host.lifecycle.use.onReady(() => void host.provide.use(late, { v: 1 }));
    host.lifecycle.use.onReady(() => sleep(30));
    await within(app.start(), 1000, 'start');
    await app.plugins.idle();
    await sleep(10);
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    expect(log).toEqual(['consumer']);
  });

  it('转入后台、还没激活完的插件：start() 不跑它的回调，它落定后自己跑', async () => {
    const { app } = world();
    const log: string[] = [];
    let release!: () => void;
    void app.plugin(
      definePlugin({
        name: 'background',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          lifecycle.use.onReady(() => void log.push('ready'));
          await new Promise<void>(resolve => (release = resolve));
          log.push('apply 落定');
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(app.plugins.getStatus()[0]).toMatchObject({ state: 'activating', slow: true });
    await tick();
    expect(log, '还在初始化，不算就绪').toEqual([]);
    release();
    await tick();
    expect(log).toEqual(['apply 落定', 'ready']);
  });

  it('重启出来的新实例再跑一次，每个实例只跑自己的', async () => {
    const { app } = world();
    const log: string[] = [];
    let generation = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          const mine = ++generation;
          lifecycle.use.onReady(() => void log.push(`ready#${mine}`));
        },
      }),
    );
    await app.start();
    expect(log).toEqual(['ready#1']);
    await app.plugins.bounce('p');
    await app.plugins.idle();
    await tick();
    expect(log).toEqual(['ready#1', 'ready#2']);
  });

  it('激活失败的不跑', async () => {
    const { app } = world({ logLevel: 'error' });
    await app.start();
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'broken',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(() => void log.push('ready'));
          throw new Error('apply 失败');
        },
      }),
    );
    await app.plugins.idle();
    await tick();
    expect(app.plugins.getPlugin('broken')?.state).toBe('error');
    expect(log).toEqual([]);
  });
});

describe('lifecycle.onReady：登记与退订', () => {
  it('已就绪之后才登记的，下一个微任务跑一次', async () => {
    const { app } = world();
    const log: string[] = [];
    let cap!: { onReady(fn: () => void): () => void };
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply: ({ lifecycle }) => {
          cap = lifecycle.use;
        },
      }),
    );
    await app.start();
    cap.onReady(() => void log.push('迟登记'));
    expect(log, '不在登记的调用栈上跑').toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['迟登记']);
  });

  it('退订的不跑：启动之前退订、轮到之前被前一个回调退订', async () => {
    const { app } = world();
    const log: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(() => void log.push('早退订'))();
          let offLater: () => void = () => {};
          lifecycle.use.onReady(() => {
            log.push('第一个');
            offLater();
          });
          offLater = lifecycle.use.onReady(() => void log.push('被第一个退订'));
          lifecycle.use.onReady(() => void log.push('最后一个'));
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(log).toEqual(['第一个', '最后一个']);
  });

  it('同一个函数登记两次各算一条，各自退订', async () => {
    const { app } = world();
    let count = 0;
    const fn = () => void count++;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.onReady(fn);
          lifecycle.use.onReady(fn)();
          lifecycle.use.onReady(fn);
        },
      }),
    );
    await within(app.start(), 1000, 'start');
    expect(count).toBe(2);
  });

  it('激活已开始关闭之后登记：拒收并告警', async () => {
    const { app, warns } = world();
    const log: string[] = [];
    let cap!: { onReady(fn: () => void): () => void };
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply: ({ lifecycle }) => {
          cap = lifecycle.use;
        },
      }),
    );
    await app.start();
    await app.plugins.disable('p');
    cap.onReady(() => void log.push('不该跑'));
    await tick();
    expect(log).toEqual([]);
    expect(warns).toEqual(['[aalis:p] 激活 "p" 已关闭，忽略 onReady']);
  });
});

describe('lifecycle.onReady：与关闭的关系', () => {
  it('轮到之前所属激活已开始关闭：不跑', async () => {
    const { app } = world();
    const log: string[] = [];
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'a',
          uses: { lifecycle },
          apply: ({ lifecycle }) =>
            void lifecycle.use.onReady(async () => {
              log.push('a');
              // 不等它：等的话与本回调互等到宽限
              void app.plugins.disable('b');
              await sleep(10);
            }),
        }),
      },
      {
        definition: definePlugin({
          name: 'b',
          uses: { lifecycle },
          apply: ({ lifecycle }) => void lifecycle.use.onReady(() => void log.push('b')),
        }),
      },
    ]);
    await within(app.start(), 1000, 'start');
    await app.plugins.idle();
    expect(log).toEqual(['a']);
  });

  /** a 的就绪回调里不等地重启 b，自己再等一会儿：相位停在 a 上，轮到 b 时挂在条目上的已是新实例 */
  const restarter = (app: App, log: string[]) =>
    definePlugin({
      name: 'a',
      uses: { lifecycle },
      apply: ({ lifecycle }) =>
        void lifecycle.use.onReady(async () => {
          log.push('a');
          void app.plugins.bounce('b');
          await sleep(20);
        }),
    });

  it('相位途中被重启、轮到时新实例的 apply 还没落定：回调等 apply 落定后才跑，apply 途中才登记的也一样', async () => {
    const { app } = world({ slowThresholdMs: 0 });
    const log: string[] = [];
    let generation = 0;
    await app.pluginAll([
      { definition: restarter(app, log) },
      {
        definition: definePlugin({
          name: 'b',
          uses: { lifecycle },
          async apply({ lifecycle }) {
            const mine = ++generation;
            lifecycle.use.onReady(() => void log.push(`b#${mine} 先登记的`));
            if (mine === 1) return;
            await sleep(40);
            lifecycle.use.onReady(() => void log.push(`b#${mine} 途中登记的`));
            await sleep(20);
            log.push(`b#${mine} apply 落定`);
          },
        }),
      },
    ]);
    await within(app.start(), 1000, 'start');
    await app.plugins.idle();
    await tick();
    expect(log).toEqual(['a', 'b#2 apply 落定', 'b#2 先登记的', 'b#2 途中登记的']);
  });

  it('相位途中被重启、新实例的 apply 随后失败：它的回调不跑', async () => {
    const { app } = world({ slowThresholdMs: 0 });
    const log: string[] = [];
    let generation = 0;
    await app.pluginAll([
      { definition: restarter(app, log) },
      {
        definition: definePlugin({
          name: 'b',
          uses: { lifecycle },
          async apply({ lifecycle }) {
            const mine = ++generation;
            lifecycle.use.onReady(() => void log.push(`b#${mine}`));
            if (mine === 1) return;
            await sleep(40);
            throw new Error('第二次 apply 失败');
          },
        }),
      },
    ]);
    await within(app.start(), 1000, 'start');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('b')?.state).toBe('error');
    expect(log).toEqual(['a']);
  });

  it('相位途中被重启、轮到时新实例正在跑第一个回调：只有新实例跑，每个回调只跑一次，第二个等第一个落定', async () => {
    const { app } = world({ slowThresholdMs: 0 });
    const log: string[] = [];
    let generation = 0;
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'a',
          uses: { lifecycle },
          apply: ({ lifecycle }) =>
            void lifecycle.use.onReady(async () => {
              log.push('a');
              await app.plugins.bounce('b');
            }),
        }),
      },
      {
        definition: definePlugin({
          name: 'b',
          uses: { lifecycle },
          apply({ lifecycle }) {
            const mine = ++generation;
            lifecycle.use.onReady(async () => {
              log.push(`b#${mine} 一 开始`);
              await sleep(30);
              log.push(`b#${mine} 一 结束`);
            });
            lifecycle.use.onReady(() => void log.push(`b#${mine} 二`));
          },
        }),
      },
    ]);
    await within(app.start(), 1000, 'start');
    await sleep(60);
    expect(log).toEqual(['a', 'b#2 一 开始', 'b#2 一 结束', 'b#2 二']);
  });

  it('停用撞上没跑完的回调：清理等它落定，新实例在它之后才激活', async () => {
    const { app } = world({ slowThresholdMs: 0 });
    const log: string[] = [];
    let generation = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          const mine = ++generation;
          log.push(`apply#${mine}`);
          lifecycle.use.onReady(async () => {
            if (mine > 1) return;
            await sleep(30);
            log.push('ready#1 结束');
          });
          lifecycle.use.onDispose(() => void log.push(`dispose#${mine}`));
        },
      }),
    );
    void app.start();
    await sleep(5);
    await within(app.plugins.bounce('p'), 1000, 'bounce');
    await app.plugins.idle();
    expect(log).toEqual(['apply#1', 'ready#1 结束', 'dispose#1', 'apply#2']);
  });

  it('回调超过 disposeTimeoutMs 仍没跑完：关闭不再等，旧实例记为 lingering，它停下之前同一 id 不激活', async () => {
    const { app } = world({ slowThresholdMs: 0, disposeTimeoutMs: 20 });
    let release!: () => void;
    let applied = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          if (++applied > 1) return;
          lifecycle.use.onReady(() => new Promise<void>(resolve => (release = resolve)));
        },
      }),
    );
    void app.start();
    await sleep(5);
    await within(app.plugins.bounce('p'), 1000, 'bounce');
    expect(app.plugins.getStatus()[0]).toMatchObject({ state: 'pending', lingering: true });
    expect(applied).toBe(1);
    release();
    await sleep(10);
    await app.plugins.idle();
    expect(app.plugins.getStatus()[0]).toMatchObject({ state: 'active' });
    expect(app.plugins.getStatus()[0].lingering).toBeUndefined();
    expect(applied).toBe(2);
  });

  it('回调卡住不影响 stop()', async () => {
    const { app } = world({ disposeTimeoutMs: 20 });
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply: ({ lifecycle }) => void lifecycle.use.onReady(never),
      }),
    );
    await within(app.start(), 1000, 'start');
    await within(app.stop(), 1000, 'stop');
  });
});
