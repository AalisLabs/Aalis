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
  /** 跑过的就绪回调，按先后 */
  ready: string[];
  /** 提供者每次拆卸时完成的异步清理（排在超时放弃的那一项之后） */
  flushed: string[];
  /** 慢激活转入后台期间与落定之后的状态 */
  slow: { during: { state?: State; slow: boolean }; after: { state?: State; slow: boolean } };
  /** 依赖方两次激活的 lifecycle.signal：stop 前后是否已 abort，abort 的 reason 名 */
  signal: { beforeStop: boolean[]; afterStop: boolean[]; reasons: string[] };
  /** stop 之后各插件的状态 */
  stopped: Record<string, State>;
  /** warn 与 error 日志 */
  warnings: string[];
}

/** 慢激活阈值与单项清理的等待上限（毫秒） */
const LIMIT_MS = 30;
/** 等插件激活完成的上限：超过即判失败，不拖到用例超时 */
const WAIT_MS = 5000;

export async function smoke(core: typeof Core): Promise<SmokeResult> {
  const { App, definePlugin, defineService, lifecycle, LogHub, provide } = core;

  const hub = new LogHub();
  const warnings: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn' || entry.level === 'error') {
      warnings.push(`${entry.level} ${entry.scope} ${entry.message}`);
    }
  });
  const app = new App({ logHub: hub, slowThresholdMs: LIMIT_MS, disposeTimeoutMs: LIMIT_MS });

  /** apply 走完的先后（各插件在 apply 末尾记一笔），与每个插件 apply 过几次 */
  const loaded: string[] = [];
  const applied = new Map<string, number>();
  const applyDone = (id: string): void => {
    loaded.push(id);
    applied.set(id, (applied.get(id) ?? 0) + 1);
  };
  /** 等 id 再激活一次：从现在起它又走完一次 apply，且状态已是 active */
  const nextLoad = (id: string) =>
    new Promise<void>((resolve, reject) => {
      const from = applied.get(id) ?? 0;
      const timer = setTimeout(() => reject(new Error(`${WAIT_MS}ms 内没等到 ${id} 激活`)), WAIT_MS);
      const off = app.plugins.watch(() => {
        if ((applied.get(id) ?? 0) <= from || status(id).state !== 'active') return;
        clearTimeout(timer);
        off();
        resolve();
      });
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
      provide.use(store, { generation });
      lifecycle.use.onDispose(async () => {
        await Promise.resolve();
        flushed.push(`provider#${generation}`);
      });
      // 超过宽限才落定：拆卸等满 disposeTimeoutMs 后放弃它、接着执行先登记的那一项；它落定之前同 id 不启动新实例
      lifecycle.use.onDispose(() => new Promise<void>(resolve => setTimeout(resolve, LIMIT_MS * 3)), 'hang');
      applyDone('provider');
    },
  });

  const consumerSaw: number[] = [];
  const consumerDisposed: number[] = [];
  const signals: AbortSignal[] = [];
  const consumer = definePlugin({
    name: 'consumer',
    uses: { store, lifecycle },
    apply({ store, lifecycle }) {
      const { generation } = store.use;
      consumerSaw.push(generation);
      signals.push(lifecycle.use.signal);
      lifecycle.use.onReady(() => void ready.push(`consumer#${generation}`));
      lifecycle.use.onDispose(() => void consumerDisposed.push(generation));
      applyDone('consumer');
    },
  });

  // 依赖方先到：required 服务缺席，停在 pending；提供者登记后级联激活
  await app.plugin(consumer);
  const consumerAlone = status('consumer').state;
  await app.plugin(provider);
  await app.plugins.idle();
  const cascade = { consumerAlone, loaded: loaded.splice(0), states: states() };

  // 启动之后才激活的插件：自己的 apply 落定后跑就绪回调
  await app.start();
  await app.plugin(
    definePlugin({
      name: 'late',
      uses: { lifecycle },
      apply: ({ lifecycle }) => void lifecycle.use.onReady(() => void ready.push('late')),
    }),
  );
  await app.plugins.idle();
  // 就绪回调不在重算里等：让出一拍，等它跑完
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  // bounce 提供者：依赖方先拆后建；提供者卡住的清理超时放弃，其后的异步清理照常执行，旧实例停下后才启动新实例
  loaded.length = 0;
  const reloaded = nextLoad('consumer');
  await app.plugins.bounce('provider');
  await reloaded;
  await app.plugins.idle();
  const bounce = { loaded: loaded.splice(0), consumerSaw: [...consumerSaw], consumerDisposed: [...consumerDisposed] };

  // 激活超过阈值转入后台：登记在阈值处返回，落定后转 active
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const landed = nextLoad('slow');
  await app.plugin(definePlugin({ name: 'slow', apply: () => gate.then(() => applyDone('slow')) }));
  const during = status('slow');
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
