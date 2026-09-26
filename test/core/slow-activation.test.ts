import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  type AppOptions,
  config,
  definePlugin,
  defineService,
  events,
  type LifecycleCap,
  type Logger,
  lifecycle,
  type PluginStatusEntry,
  pluginsService,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 激活不阻塞与可取消（C1）：
// - 激活超过 slowThresholdMs 仍未完成：warn 点名、转入后台，flight 接着激活后面的插件，此后按同一间隔提醒；
//   后台期间它登记的服务不对外，依赖方保持 pending；落定后成功转 active 并上线服务、失败进 error，并补一次重算。
// - lifecycle.signal：在飞初始化在关闭计划冻完后立即 abort，其余在各自收尾段入口 abort；
//   停用 / 卸载 / 重启 / 停机撞上仍在初始化的插件，abort 后至多再等 disposeTimeoutMs，到期记 error。
// 计时用真实定时器、毫秒级阈值；等待一律按条件轮询，不赌固定延时。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 条件成立前轮询；超时抛错（变异后的实现在这里变红，不拖到用例超时） */
async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await sleep(5);
  }
}

/** 在 ms 内落定则交回结果，否则抛错 */
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

/** 一个永不落定、测试结束时统一放行的闸门 */
function hang(): Promise<void> {
  const gate = deferred();
  releases.push(gate.resolve);
  return gate.promise;
}

/** 等 abort 才拒绝的 apply 主体：响应取消的长任务 */
function untilAborted(life: LifecycleCap): Promise<never> {
  return new Promise((_, reject) => life.signal.addEventListener('abort', () => reject(life.signal.reason)));
}

function world(options: Partial<AppOptions> = {}) {
  const lines: Array<{ level: string; text: string }> = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push({ level, text: args.map(String).join(' ') });
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  const app = new App({ name: 'T', logger, slowThresholdMs: 30, disposeTimeoutMs: 30, ...options });
  apps.push(app);
  const host = app.bind({ events, services, provide });
  const trace: string[] = [];
  host.events.on('service:registered', name => void trace.push(`+${name}`));
  host.events.on('service:unregistered', name => void trace.push(`-${name}`));
  host.events.on('plugin:loaded', id => void trace.push(`loaded:${id}`));
  host.events.on('plugins:changed', () => void trace.push('changed'));
  const at = (level: string) => lines.filter(line => line.level === level).map(line => line.text);
  const status = (id: string): PluginStatusEntry | undefined =>
    app.plugins.getStatus().find(entry => entry.instanceId === id);
  return { app, host, trace, at, status };
}

const reminders = (w: ReturnType<typeof world>, id: string) =>
  w.at('warn').filter(text => text.startsWith(`插件 "${id}" 仍在激活`));

describe('慢激活转入后台', () => {
  it('永不返回的 apply 不挡其余插件与启动：登记、start、idle 都在阈值处返回，慢插件以 activating + slow 可见', async () => {
    const w = world();
    const applied: string[] = [];
    const registered = await within(
      w.app.pluginAll([
        { definition: definePlugin({ name: 'stuck', apply: () => hang() }) },
        { definition: definePlugin({ name: 'other', apply: () => void applied.push('other') }) },
      ]),
      2000,
      'pluginAll',
    );
    expect(registered).toEqual([true, true]);
    await within(w.app.plugins.idle(), 2000, 'idle');
    expect(applied).toEqual(['other']);
    expect(w.status('other')?.state).toBe('active');
    expect(w.status('other')?.slow).toBeUndefined();
    expect(w.status('stuck')).toMatchObject({ state: 'activating', slow: true });
    expect(w.at('warn')).toContain(
      '插件 "stuck" 激活超过 30ms 仍未完成，转入后台继续；它提供的服务在激活完成前不对依赖方开放',
    );
    await within(w.app.start(), 2000, 'start');
  });

  it('后台期间按同一间隔提醒「仍在激活」，经过时长是阈值的倍数；落定后不再提醒', async () => {
    const w = world({ slowThresholdMs: 20 });
    const gate = deferred();
    releases.push(gate.resolve);
    await w.app.plugin(definePlugin({ name: 'stuck', apply: () => gate.promise }));
    await until(() => reminders(w, 'stuck').length >= 2, '两次提醒');
    expect(reminders(w, 'stuck').slice(0, 2)).toEqual([
      '插件 "stuck" 仍在激活（已超过 40ms）',
      '插件 "stuck" 仍在激活（已超过 60ms）',
    ]);
    gate.resolve();
    await until(() => w.status('stuck')?.state === 'active', '落定为 active');
    expect(w.status('stuck')?.slow).toBeUndefined();
    const count = reminders(w, 'stuck').length;
    await sleep(80);
    expect(reminders(w, 'stuck')).toHaveLength(count);
  });

  it('后台期间它登记的服务不对依赖方开放：依赖方保持 pending，动态查询与服务名单都看不到', async () => {
    const w = world();
    const store = defineService<{ ready: boolean }>('zz-slow-store');
    const gate = deferred();
    releases.push(gate.resolve);
    const got: boolean[] = [];
    await w.app.pluginAll([
      {
        definition: definePlugin({
          name: 'slow-store',
          uses: { provide },
          provides: [store],
          async apply({ provide }) {
            provide(store, { ready: true });
            await gate.promise;
          },
        }),
      },
      {
        definition: definePlugin({
          name: 'dependent',
          uses: { store },
          apply: ({ store }) => void got.push(store.require().ready),
        }),
      },
    ]);
    await w.app.plugins.idle();
    expect(w.status('slow-store')).toMatchObject({ state: 'activating', slow: true });
    expect(w.status('dependent')?.state).toBe('pending');
    expect(got).toEqual([]);
    expect(w.host.services.get(store)).toBeUndefined();
    expect(w.host.services.all(store)).toEqual([]);
    expect(w.host.services.inspect(store)).toEqual([]);
    expect(w.host.services.names()).not.toContain(store.name);
    // 阈值前照常可见（apply 里 provide 当场登记），转入后台时撤下
    expect(w.trace.filter(t => t.endsWith(store.name))).toEqual([`+${store.name}`, `-${store.name}`]);

    // 后台激活成功：先写 active 再上线服务，依赖方随之自动激活，不需要另调管理动作
    gate.resolve();
    await until(() => w.status('dependent')?.state === 'active', '依赖方自动激活');
    expect(w.status('slow-store')?.state).toBe('active');
    expect(got).toEqual([true]);
    expect(w.host.services.get(store)).toEqual({ ready: true });
    expect(w.trace.filter(t => t.endsWith(store.name))).toEqual([`+${store.name}`, `-${store.name}`, `+${store.name}`]);
    expect(w.trace).toContain('loaded:slow-store');
    expect(w.trace).toContain('loaded:dependent');
  });

  it('后台期间继续 provide 与退订：不发服务事件；上线时一并对外', async () => {
    const w = world();
    const late = defineService<{ n: number }>('zz-slow-late');
    const dropped = defineService<{ n: number }>('zz-slow-dropped');
    const gate = deferred();
    releases.push(gate.resolve);
    await w.app.plugin(
      definePlugin({
        name: 'late-provider',
        uses: { provide },
        provides: [late],
        async apply({ provide }) {
          await sleep(60);
          provide(late, { n: 1 });
          provide(dropped, { n: 2 })();
          await gate.promise;
        },
      }),
    );
    await until(() => w.status('late-provider')?.slow === true, '转入后台');
    await sleep(60);
    expect(w.trace.filter(t => t.includes('zz-slow-'))).toEqual([]);
    expect(w.host.services.get(late)).toBeUndefined();
    gate.resolve();
    await until(() => w.status('late-provider')?.state === 'active', '落定');
    expect(w.trace.filter(t => t.includes('zz-slow-'))).toEqual([`+${late.name}`]);
    expect(w.host.services.get(late)).toEqual({ n: 1 });
  });

  it('后台激活失败进 error；它登记的服务从未对外上线，依赖方仍 pending', async () => {
    const w = world();
    const store = defineService<object>('zz-slow-failing');
    const gate = deferred();
    releases.push(gate.resolve);
    await w.app.pluginAll([
      {
        definition: definePlugin({
          name: 'failing',
          uses: { provide },
          provides: [store],
          async apply({ provide }) {
            provide(store, {});
            await gate.promise;
            throw new Error('初始化失败');
          },
        }),
      },
      { definition: definePlugin({ name: 'dependent', uses: { store }, apply() {} }) },
    ]);
    await until(() => w.status('failing')?.slow === true, '转入后台');
    const before = w.trace.filter(t => t.endsWith(store.name));
    gate.resolve();
    await until(() => w.status('failing')?.state === 'error', '进 error');
    await w.app.plugins.idle();
    expect(w.status('failing')?.error).toBe('初始化失败');
    expect(w.status('failing')?.slow).toBeUndefined();
    expect(w.status('dependent')?.state).toBe('pending');
    expect(
      w.trace.filter(t => t.endsWith(store.name)),
      '拆卸不补发下线：它早已不对外',
    ).toEqual(before);
  });

  it('apply 很快失败、失败回滚的清理慢于阈值：不算慢激活，flight 等回滚收完', async () => {
    const w = world({ slowThresholdMs: 20, disposeTimeoutMs: 1000 });
    await w.app.plugins.idle();
    await w.app.plugin(
      definePlugin({
        name: 'fails-fast',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          lifecycle.onDispose(() => sleep(80));
          await sleep(5);
          throw new Error('初始化失败');
        },
      }),
    );
    expect(w.status('fails-fast')?.state).toBe('error');
    expect(w.at('warn').filter(text => text.includes('fails-fast'))).toEqual([]);
  });

  it('flight 不再等的激活落定后补一次重算：没有服务事件的成功落定也发 plugins:changed', async () => {
    const w = world();
    const gate = deferred();
    releases.push(gate.resolve);
    await w.app.plugin(definePlugin({ name: 'quiet', apply: () => gate.promise }));
    await w.app.plugins.idle();
    const changes = w.trace.filter(t => t === 'changed').length;
    gate.resolve();
    await until(() => w.trace.filter(t => t === 'changed').length > changes, '落定后的重算');
    expect(w.status('quiet')?.state).toBe('active');
  });

  it('落定路径的日志器抛错不外泄成未处理拒绝，落定后照常补一次重算', async () => {
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => void escaped.push(reason);
    process.on('unhandledRejection', onEscape);
    try {
      let failError = false;
      const changed: string[] = [];
      const logger: Logger = {
        debug() {},
        info() {},
        warn() {},
        error() {
          if (failError) throw new Error('注入的日志故障');
        },
        child: () => logger,
      };
      const app = new App({ name: 'T', logger, slowThresholdMs: 20, disposeTimeoutMs: 20 });
      apps.push(app);
      app.bind({ events }).events.on('plugins:changed', () => void changed.push('changed'));
      const gate = deferred();
      releases.push(gate.resolve);
      await app.plugin(
        definePlugin({
          name: 'noisy',
          async apply() {
            await gate.promise;
            throw new Error('初始化失败');
          },
        }),
      );
      await app.plugins.idle();
      const before = changed.length;
      failError = true;
      gate.resolve();
      await until(() => changed.length > before, '落定后的重算');
      await sleep(20);
      failError = false;
      expect(escaped).toEqual([]);
    } finally {
      process.off('unhandledRejection', onEscape);
    }
  });

  it('阈值为 0：不转后台、不告警，登记等到 apply 落定为止（旧行为）', async () => {
    const w = world({ slowThresholdMs: 0 });
    await w.app.plugins.idle();
    let registered = false;
    const registering = w.app.plugin(definePlugin({ name: 'patient', apply: () => sleep(60) })).then(() => {
      registered = true;
    });
    await sleep(40);
    expect(registered).toBe(false);
    await registering;
    expect(w.status('patient')?.state).toBe('active');
    expect(w.at('warn')).toEqual([]);
  });

  it('上限超过定时器最大延迟（含 Infinity）按最大延迟计，不会被运行时当成 1ms', async () => {
    const w = world({ slowThresholdMs: 2 ** 40, disposeTimeoutMs: Number.POSITIVE_INFINITY });
    await w.app.plugin(
      definePlugin({
        name: 'huge',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          lifecycle.onDispose(() => sleep(30));
          await sleep(30);
        },
      }),
    );
    await w.app.plugins.idle();
    expect(w.status('huge')?.state).toBe('active');
    await w.app.plugins.unload('huge');
    expect(w.at('warn')).toEqual([]);
  });
});

describe('lifecycle.signal 的时机', () => {
  it('收尾段入口才 abort：消费者先关时提供者的 signal 未断，各自 onDrain 里自己的已断；reason 是 AbortError', async () => {
    const w = world();
    const svc = defineService<object>('zz-signal-svc');
    const seen: string[] = [];
    let providerLife!: LifecycleCap;
    let consumerLife!: LifecycleCap;
    await w.app.plugin(
      definePlugin({
        name: 'provider',
        uses: { provide, lifecycle },
        provides: [svc],
        apply({ provide, lifecycle }) {
          providerLife = lifecycle;
          provide(svc, {});
          lifecycle.onDrain(() => void seen.push(`provider: 自己=${lifecycle.signal.aborted}`));
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { svc, lifecycle },
        apply({ lifecycle }) {
          consumerLife = lifecycle;
          lifecycle.onDrain(
            () => void seen.push(`consumer: 自己=${lifecycle.signal.aborted} 提供者=${providerLife.signal.aborted}`),
          );
        },
      }),
    );
    await w.app.plugins.idle();
    const stopping = w.app.stop();
    expect(consumerLife.signal.aborted, '已激活的插件不在冻结时断').toBe(false);
    await stopping;
    expect(seen).toEqual(['consumer: 自己=true 提供者=false', 'provider: 自己=true']);
    const reason = providerLife.signal.reason as DOMException;
    expect(reason).toBeInstanceOf(DOMException);
    expect(reason.name).toBe('AbortError');
    expect(reason.message).toContain('provider');
    // @ts-expect-error closed 已删除，改用 signal.aborted
    expect(providerLife.closed).toBeUndefined();
  });

  it.each([
    'unload',
    'disable',
    'bounce',
    'stop',
  ] as const)('在飞初始化在 %s 冻结计划后立即 abort：调用一返回 apply 就看得到', async action => {
    const w = world({ slowThresholdMs: 5000 });
    const entered = deferred();
    let life!: LifecycleCap;
    const registering = w.app.plugin(
      definePlugin({
        name: 'inflight',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          if (life) return; // bounce 起的第二轮直接完成
          life = lifecycle;
          entered.resolve();
          await untilAborted(lifecycle);
        },
      }),
    );
    await entered.promise;
    expect(life.signal.aborted).toBe(false);
    const managing = action === 'stop' ? w.app.stop() : w.app.plugins[action]('inflight');
    expect(life.signal.aborted).toBe(true);
    await within(Promise.all([registering, managing]), 2000, action);
  });

  it('冻结完成后才 abort：监听器里碰到的另一个在初始化的激活已在计划里', async () => {
    const w = world({ slowThresholdMs: 30 });
    const late = defineService<object>('zz-signal-late');
    let second!: { provide: (d: typeof late, impl: object) => () => void };
    let firstLife!: LifecycleCap;
    const secondEntered = deferred();
    await w.app.pluginAll([
      {
        definition: definePlugin({
          name: 'first',
          uses: { lifecycle },
          apply({ lifecycle }) {
            firstLife = lifecycle;
            return hang();
          },
        }),
      },
      {
        definition: definePlugin({
          name: 'second',
          uses: { provide },
          apply(caps) {
            second = caps;
            secondEntered.resolve();
            return hang();
          },
        }),
      },
    ]);
    await secondEntered.promise;
    expect(w.status('first')?.slow).toBe(true);
    expect(w.status('second')?.state).toBe('activating');
    let accepted: boolean | undefined;
    firstLife.signal.addEventListener('abort', () => {
      second.provide(late, {});
      accepted = w.host.services.get(late) !== undefined;
    });
    const stopping = w.app.stop();
    expect(accepted, 'first 的 abort 监听器执行时 second 已冻结，登记被拒').toBe(false);
    expect(w.at('warn')).toContain('激活 "second" 已 dispose，忽略 provide("zz-signal-late")');
    await within(stopping, 2000, 'stop');
  });
});

describe('停用 / 卸载 / 重启 / 停机撞上仍在初始化的插件', () => {
  it.each(['disable', 'unload', 'bounce'] as const)('后台激活响应 signal：%s 很快落定，不记 error', async action => {
    const w = world({ disposeTimeoutMs: 5000 });
    let applies = 0;
    await w.app.plugin(
      definePlugin({
        name: 'responsive',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          if (++applies === 1) await untilAborted(lifecycle);
        },
      }),
    );
    await until(() => w.status('responsive')?.slow === true, '转入后台');
    const started = Date.now();
    expect(await w.app.plugins[action]('responsive')).toBe(true);
    await w.app.plugins.idle();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(w.at('error')).toEqual([]);
    if (action === 'disable') expect(w.status('responsive')?.state).toBe('disabled');
    if (action === 'unload') expect(w.status('responsive')).toBeUndefined();
    if (action === 'bounce') {
      expect(w.status('responsive')?.state).toBe('active');
      expect(applies).toBe(2);
    }
  });

  it.each([
    'disable',
    'bounce',
    'unload',
  ] as const)('后台激活不响应 signal：%s 在宽限后返回，记 error「未在宽限内停止」', async action => {
    const w = world({ disposeTimeoutMs: 40 });
    await w.app.plugin(definePlugin({ name: 'deaf', apply: () => hang() }));
    await until(() => w.status('deaf')?.slow === true, '转入后台');
    expect(await within(w.app.plugins[action]('deaf'), 2000, action)).toBe(true);
    await within(w.app.plugins.idle(), 2000, 'idle');
    const stopped = w.at('error').filter(text => text.includes('未在宽限内停止'));
    expect(stopped).toEqual(['插件 "deaf" 未在宽限内停止（abort 后收尾段又等了 40ms，初始化仍未落定，不再等待）']);
    if (action === 'unload') expect(w.status('deaf')).toBeUndefined();
    else {
      expect(w.status('deaf')?.state, '重启遇到停不下来的也不再起新实例').toBe('error');
      expect(w.status('deaf')?.error).toContain('未在宽限内停止');
    }
  });

  it('宽限期间 enable 已把终态改走：不写 error，新一轮照常激活', async () => {
    const w = world({ disposeTimeoutMs: 60 });
    let applies = 0;
    await w.app.plugin(
      definePlugin({
        name: 'deaf',
        apply: () => (++applies === 1 ? hang() : undefined),
      }),
    );
    await until(() => w.status('deaf')?.slow === true, '转入后台');
    const disabling = w.app.plugins.disable('deaf');
    await sleep(10);
    expect(await w.app.plugins.enable('deaf')).toBe(true);
    await disabling;
    await until(() => w.status('deaf')?.state === 'active', '新一轮激活');
    expect(applies).toBe(2);
    expect(w.status('deaf')?.error).toBeUndefined();
    expect(w.at('error').filter(text => text.includes('未在宽限内停止'))).toHaveLength(1);
  });

  it('被放弃的 apply 迟到落定：同一条目已起新一轮时让位，不把新一轮写成 active、不发 loaded', async () => {
    const w = world({ disposeTimeoutMs: 30, slowThresholdMs: 5000 });
    const zombie = deferred();
    const fresh = deferred();
    releases.push(zombie.resolve, fresh.resolve);
    let applies = 0;
    await w.app.plugin(
      definePlugin({ name: 'twice', apply: () => (++applies === 1 ? zombie.promise : fresh.promise) }),
    );
    // 第一轮在飞：停用在宽限后放弃它、转 error
    await within(w.app.plugins.disable('twice'), 2000, 'disable');
    expect(w.status('twice')?.state).toBe('error');
    const enabling = w.app.plugins.enable('twice');
    await until(() => applies === 2, '第二轮 apply');
    zombie.resolve();
    await sleep(20);
    expect(w.status('twice')?.state, '迟到的第一轮不得替第二轮收尾').toBe('activating');
    expect(w.trace).not.toContain('loaded:twice');
    fresh.resolve();
    await enabling;
    await w.app.plugins.idle();
    expect(w.status('twice')?.state).toBe('active');
    expect(w.trace.filter(t => t === 'loaded:twice')).toHaveLength(1);
  });

  it('停机有界：不响应的后台激活与在飞激活都在阈值 + 宽限量级内收场；之后不再提醒', async () => {
    const w = world({ slowThresholdMs: 40, disposeTimeoutMs: 40 });
    const secondEntered = deferred();
    const registering = w.app.pluginAll([
      { definition: definePlugin({ name: 'background', apply: () => hang() }) },
      {
        definition: definePlugin({
          name: 'inflight',
          apply() {
            secondEntered.resolve();
            return hang();
          },
        }),
      },
    ]);
    await secondEntered.promise;
    expect(w.status('background')?.slow).toBe(true);
    expect(w.status('inflight')?.slow).toBeUndefined();
    await within(Promise.all([w.app.stop(), registering]), 2000, 'stop');
    expect(w.at('error').filter(text => text.includes('未在宽限内停止'))).toEqual([
      '插件 "inflight" 未在宽限内停止（abort 后收尾段又等了 40ms，初始化仍未落定，不再等待）',
      '插件 "background" 未在宽限内停止（abort 后收尾段又等了 40ms，初始化仍未落定，不再等待）',
    ]);
    const count = w.at('warn').filter(text => text.includes('仍在激活')).length;
    await sleep(120);
    expect(w.at('warn').filter(text => text.includes('仍在激活'))).toHaveLength(count);
  });

  it('两轮提醒之间停用后台激活：此后不再提醒', async () => {
    const w = world({ slowThresholdMs: 20, disposeTimeoutMs: 20 });
    await w.app.plugin(definePlugin({ name: 'deaf', apply: () => hang() }));
    await until(() => reminders(w, 'deaf').length >= 1, '第一次提醒');
    await w.app.plugins.disable('deaf');
    const count = reminders(w, 'deaf').length;
    await sleep(100);
    expect(reminders(w, 'deaf')).toHaveLength(count);
  });

  it('在飞激活（未到阈值）被停机接手：flight 不陪着等 apply，stop 远早于阈值推进', async () => {
    const w = world({ slowThresholdMs: 5000, disposeTimeoutMs: 30 });
    const entered = deferred();
    const stopping: string[] = [];
    w.host.events.on('app:stopping', () => void stopping.push('stopping'));
    const registering = w.app.plugin(
      definePlugin({
        name: 'deaf',
        apply() {
          entered.resolve();
          return hang();
        },
      }),
    );
    await entered.promise;
    const started = Date.now();
    await within(w.app.stop(), 1000, 'stop');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stopping).toEqual(['stopping']);
    await within(registering, 1000, 'register');
  });

  it('apply 同步段里触发停机：登记初始化时即 abort，flight 不等满阈值', async () => {
    const w = world({ slowThresholdMs: 5000, disposeTimeoutMs: 30 });
    const entered = deferred();
    let stopping!: Promise<void>;
    let life!: LifecycleCap;
    const registering = w.app.plugin(
      definePlugin({
        name: 'self-stop',
        uses: { lifecycle },
        apply({ lifecycle }) {
          life = lifecycle;
          stopping = w.app.stop();
          entered.resolve();
          return hang();
        },
      }),
    );
    await entered.promise;
    await within(Promise.all([registering, stopping]), 1000, 'stop');
    expect(life.signal.aborted).toBe(true);
  });

  it('提供者重启：仍在后台初始化的 required 下游并入同一批，先于提供者收场，再按新实例重新激活', async () => {
    const w = world({ disposeTimeoutMs: 1000 });
    const svc = defineService<{ v: number }>('zz-bg-provider');
    const order: string[] = [];
    const seen: number[] = [];
    await w.app.plugin(
      definePlugin({
        name: 'prov',
        uses: { provide, config, lifecycle },
        provides: [svc],
        apply({ provide, config, lifecycle }) {
          const v = Number(config.v ?? 1);
          provide(svc, { v });
          lifecycle.onDispose(() => void order.push(`prov#${v} 清理`));
        },
      }),
      { v: 1 },
    );
    await w.app.plugin(
      definePlugin({
        name: 'cons',
        uses: { svc, lifecycle },
        async apply({ svc, lifecycle }) {
          seen.push(svc.require().v);
          if (seen.length > 1) return;
          lifecycle.signal.addEventListener('abort', () => void order.push('cons 被 abort'));
          await untilAborted(lifecycle);
        },
      }),
    );
    await until(() => w.status('cons')?.slow === true, '下游转入后台');
    await w.app.plugins.updateConfig('prov', { v: 2 });
    await w.app.plugins.idle();
    expect(order, '下游还在用旧实例初始化，提供者不能先走').toEqual(['cons 被 abort', 'prov#1 清理']);
    expect(seen).toEqual([1, 2]);
    expect(w.status('cons')?.state).toBe('active');
  });

  it('后台激活响应 signal、required 依赖下线：拆掉回到 pending，依赖恢复后重新激活', async () => {
    const w = world({ disposeTimeoutMs: 1000 });
    const svc = defineService<{ v: number }>('zz-bg-required');
    const firstGate = deferred();
    releases.push(firstGate.resolve);
    let off = w.host.provide(svc, { v: 1 });
    const seen: number[] = [];
    await w.app.plugin(
      definePlugin({
        name: 'cons',
        uses: { svc, lifecycle },
        async apply({ svc, lifecycle }) {
          seen.push(svc.require().v);
          if (seen.length === 1) await Promise.race([firstGate.promise, untilAborted(lifecycle)]);
        },
      }),
    );
    await until(() => w.status('cons')?.slow === true, '转入后台');
    off();
    await until(() => w.status('cons')?.state === 'pending', '回到 pending');
    off = w.host.provide(svc, { v: 2 });
    firstGate.resolve();
    await until(() => w.status('cons')?.state === 'active', '重新激活');
    expect(seen).toEqual([1, 2]);
    off();
  });

  it('后台激活不响应 signal、required 依赖下线：宽限后转 error，依赖恢复后不自动重试，enable 后重新激活', async () => {
    const w = world({ disposeTimeoutMs: 30 });
    const svc = defineService<{ v: number }>('zz-bg-required-deaf');
    let off = w.host.provide(svc, { v: 1 });
    let applies = 0;
    await w.app.plugin(
      definePlugin({ name: 'deaf', uses: { svc }, apply: () => (++applies === 1 ? hang() : undefined) }),
    );
    await until(() => w.status('deaf')?.slow === true, '转入后台');
    off();
    await until(() => w.status('deaf')?.state === 'error', '宽限后转 error');
    expect(w.status('deaf')?.error).toContain('未在宽限内停止');
    off = w.host.provide(svc, { v: 2 });
    await sleep(20);
    await w.app.plugins.idle();
    expect(w.status('deaf')?.state, '僵尸 apply 仍在跑，依赖恢复也不起新实例').toBe('error');
    expect(applies).toBe(1);
    expect(await w.app.plugins.enable('deaf')).toBe(true);
    await w.app.plugins.idle();
    expect(w.status('deaf')?.state).toBe('active');
    expect(applies).toBe(2);
    off();
  });

  it('管理面经 pluginsService 读到的状态同样带 slow', async () => {
    const w = world();
    await w.app.plugin(definePlugin({ name: 'stuck', apply: () => hang() }));
    await w.app.plugins.idle();
    const viaService = w.app.bind({ pluginsService }).pluginsService.require().getStatus();
    expect(viaService.find(entry => entry.instanceId === 'stuck')?.slow).toBe(true);
  });
});
