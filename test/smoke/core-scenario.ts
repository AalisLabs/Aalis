import type * as Core from '@aalis/core';

// ════════════════════════════════════════════════════════════
// core 多运行时冒烟的场景（由 core-multi-runtime.test.ts 转译后分别交给 Node、Chromium 主线程与 Worker）
//
// 只用参数交来的 core 包根导出；本模块没有运行期 import（上面的类型导入转译时擦除），也不碰 process、
// Buffer、console 等宿主专有件，日志经 AppOptions.logHub 注入的中枢收集。
// 除慢激活与清理超时两处小阈值外，异步只走微任务，结果因此不随机器负载变化。
// ════════════════════════════════════════════════════════════

type State = Core.PluginState;

export interface SmokeResult {
  /** 依赖方先登记时停在 pending；提供者登记后按依赖先后激活 */
  cascade: { consumerAlone?: State; loaded: string[]; states: Record<string, State> };
  /** bounce 提供者：依赖方随之拆掉重建，拿到新一代提供者 */
  bounce: { loaded: string[]; consumerSaw: number[]; consumerDisposed: number[] };
  /** 听到 app:ready 的监听器，按先后 */
  ready: string[];
  /** 提供者每次拆卸时完成的异步清理（排在超时放弃的那一项之后） */
  flushed: string[];
  /** 慢激活转入后台期间与落定之后的状态 */
  slow: { during: { state?: State; slow: boolean }; after: { state?: State; slow: boolean } };
  /** 依赖方两次激活的 lifecycle.signal：stop 前后是否已 abort，abort 的 reason 名 */
  signal: { beforeStop: boolean[]; afterStop: boolean[]; reasons: string[] };
  /** stop 之后各插件的状态 */
  stopped: Record<string, State>;
  /** warn 与 error 日志（慢激活每过一个阈值的「仍在激活」提醒次数随负载变化，不收） */
  warnings: string[];
}

/** 慢激活阈值与单项清理的等待上限（毫秒） */
const LIMIT_MS = 30;
/** 等插件激活完成的上限：超过即判失败，不拖到用例超时 */
const WAIT_MS = 5000;

export async function smoke(core: typeof Core): Promise<SmokeResult> {
  const { createApp, definePlugin, defineService, events, lifecycle, LogHub, provide } = core;

  const hub = new LogHub();
  const warnings: string[] = [];
  hub.onEntry(entry => {
    if ((entry.level === 'warn' || entry.level === 'error') && !entry.message.includes('仍在激活（已超过')) {
      warnings.push(`${entry.level} ${entry.scope} ${entry.message}`);
    }
  });
  const app = createApp({ name: 'smoke', logHub: hub, slowThresholdMs: LIMIT_MS, disposeTimeoutMs: LIMIT_MS });

  const host = app.bind({ events });
  const loaded: string[] = [];
  let slowLoaded: (() => void) | undefined;
  host.events.on('plugin:loaded', id => {
    loaded.push(id);
    if (id === 'slow') slowLoaded?.();
  });
  const status = (id: string) => {
    const entry = app.plugins.getStatus().find(item => item.instanceId === id);
    return { state: entry?.state, slow: entry?.slow === true };
  };
  const states = () => Object.fromEntries(app.plugins.getStatus().map(entry => [entry.instanceId, entry.state]));

  const store = defineService<{ generation: number }>('smoke-store');
  const ready: string[] = [];
  const flushed: string[] = [];
  let generations = 0;
  const provider = definePlugin({
    name: 'provider',
    uses: { provide, lifecycle },
    provides: [store],
    async apply({ provide, lifecycle }) {
      const generation = ++generations;
      await Promise.resolve();
      provide(store, { generation });
      lifecycle.onDispose(async () => {
        await Promise.resolve();
        flushed.push(`provider#${generation}`);
      });
      // 永不落定：拆卸等满 disposeTimeoutMs 后放弃它，接着执行先登记的那一项
      lifecycle.onDispose(() => new Promise<void>(() => {}), 'hang');
    },
  });

  const consumerSaw: number[] = [];
  const consumerDisposed: number[] = [];
  const signals: AbortSignal[] = [];
  const consumer = definePlugin({
    name: 'consumer',
    uses: { store, events, lifecycle },
    apply({ store, events, lifecycle }) {
      const { generation } = store.require();
      consumerSaw.push(generation);
      signals.push(lifecycle.signal);
      events.on('app:ready', () => void ready.push(`consumer#${generation}`));
      lifecycle.onDispose(() => void consumerDisposed.push(generation));
    },
  });

  // 依赖方先到：required 服务缺席，停在 pending；提供者登记后级联激活
  await app.plugin(consumer);
  const consumerAlone = status('consumer').state;
  await app.plugin(provider);
  await app.plugins.idle();
  const cascade = { consumerAlone, loaded: loaded.splice(0), states: states() };

  // app:ready 是 sticky：启动后才登记的监听器也会补收一次
  await app.start();
  await app.plugin(
    definePlugin({
      name: 'late',
      uses: { events },
      apply: ({ events }) => void events.on('app:ready', () => void ready.push('late')),
    }),
  );
  await app.plugins.idle();

  // bounce 提供者：依赖方先拆后建；提供者卡住的清理超时放弃，其后的异步清理照常执行
  loaded.length = 0;
  await app.plugins.bounce('provider');
  await app.plugins.idle();
  const bounce = { loaded: loaded.splice(0), consumerSaw: [...consumerSaw], consumerDisposed: [...consumerDisposed] };

  // 激活超过阈值转入后台：登记在阈值处返回，落定后转 active
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  await app.plugin(definePlugin({ name: 'slow', apply: () => gate }));
  const during = status('slow');
  const landed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${WAIT_MS}ms 内没等到慢激活落定`)), WAIT_MS);
    slowLoaded = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  release();
  await landed;
  await app.plugins.idle();
  const slow = { during, after: status('slow') };

  // stop：仍在的激活 abort 各自的 signal，全部插件关停
  const beforeStop = signals.map(signal => signal.aborted);
  await app.stop();
  return {
    cascade,
    bounce,
    ready,
    flushed,
    slow,
    signal: {
      beforeStop,
      afterStop: signals.map(signal => signal.aborted),
      reasons: signals.map(signal => (signal.reason as Error | undefined)?.name ?? String(signal.reason)),
    },
    stopped: states(),
    warnings,
  };
}
