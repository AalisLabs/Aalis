import { describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';
import { activatePlugin } from '../../packages/core/src/plugin-activation.js';
import type { PluginEntry } from '../../packages/core/src/types/plugin.js';

// ============================================================
// disposeAsync 的时序承诺：「返回时异步清理已真正完成」。
//
// 被打破的场景是全仓最常见的资源写法——apply 里先 await 拿资源、再挂
// onDispose（memory-mongodb 的 connect + 4 个 createIndex、memory-sqlite 的
// 开库、vectorstore-lancedb 的建表都是这个形状）。拆卸落在这个窗口里时，
// disposer 到达时清理链已排空，DisposableChain.push 走 post-dispose 分支就地
// 执行它——资源最终会关，但**异步返回值不被等待**，承诺落空。
//
// 可达面：PluginManager 的 unload / disablePlugin / bouncePlugin 会主动走进
// 本窗口（先改 entry.state 让激活收尾让位，再对在飞 ctx disposeAsync——那三条
// 路径的行为锚在 test/core/admin-during-activation.test.ts）；本文件守的是
// disposeAsync 这个公开契约本身（宿主直调）与 useModule 的沙盒子 ctx 级联。
//
// 时序不靠 sleep 赌：闸门不开 apply 就不落定，「拆卸发起时 apply 必定
// 在飞」是结构保证，不受 CI 负载影响。唯一按时间断言的是超时兜底那条。
// ============================================================

function makeContext(id = 'root'): Context {
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const contributions = new ContributionRegistry();
  const logger = new DefaultLogger('test');
  const config = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
  return new Context({ id, events, services, hooks, contributions, logger, config });
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = resolve;
  });
  return { promise, open };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 造出竞态窗口：apply 里 `await` 一段获取，获取完才挂 disposer。
 * `acquire` 不开，apply 就停在获取里；disposer 的收尾跨一个宏任务，故未登记时
 * 它必然落在 `await disposeAsync()` 之后。
 *
 * @param track 是否把 apply 登记给 ctx（模拟 activatePlugin 的行为）
 */
function startPlugin(ctx: Context, track: boolean) {
  const acquire = deferred();
  const state = { released: false };
  const applying = (async () => {
    await acquire.promise; // 模拟 await client.connect()
    ctx.onDispose(async () => {
      await sleep(0); // 模拟异步关闭 / 落盘：跨一个宏任务
      state.released = true;
    });
  })();
  if (track) ctx.trackActivation(applying);
  return { applying, state, acquire };
}

describe('disposeAsync 与初始化在飞的竞态', () => {
  it('登记 apply 后，disposeAsync 返回时异步清理已真正完成', async () => {
    const root = makeContext();
    const ctx = root.fork('p');
    const { applying, state, acquire } = startPlugin(ctx, true);

    // 闸门未开 → apply 必定卡在获取里，此刻发起拆卸
    const disposing = ctx.disposeAsync();
    acquire.open();
    await disposing;

    // 这是本测试的全部意义：返回的那一刻资源必须已经关掉，
    // 而不是「最终会关」。App.stop 之后进程立刻退出，没有「最终」。
    expect(state.released).toBe(true);
    await applying;
  });

  it('变异守卫：不登记 apply 时该承诺确实落空（证明上一条不是假绿）', async () => {
    const root = makeContext();
    const ctx = root.fork('p');
    const { applying, state, acquire } = startPlugin(ctx, false);

    // 未登记 = 改动前的行为：拆卸不等 apply，链是空的、直接排空返回。
    // disposer 即便赶在返回前挂上，也走 post-dispose 分支就地执行、返回值被丢弃，
    // 其跨宏任务的收尾必然落在 `await disposing` 之后 —— 承诺落空。
    const disposing = ctx.disposeAsync();
    acquire.open();
    await disposing;
    expect(state.released).toBe(false);

    // 但资源不会泄漏，只是没被等到。
    await applying;
    await sleep(1);
    expect(state.released).toBe(true);
  });

  it('apply 迟迟不落定时，timeoutMs 兜底放行，不拖死停机', async () => {
    const root = makeContext();
    const ctx = root.fork('p');
    const { state, acquire } = startPlugin(ctx, true);

    const t0 = Date.now();
    await ctx.disposeAsync(50); // 闸门永不开
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(50); // 确实等到了超时才放行
    expect(elapsed).toBeLessThan(2000); // 而不是干等 apply
    expect(state.released).toBe(false); // 这一项确实没赶上，是超时的既定代价

    acquire.open();
  });

  it('apply 抛错也算落定，不把拆卸卡住', async () => {
    const root = makeContext();
    const ctx = root.fork('p');
    const acquire = deferred();
    let released = false;
    const applying = (async () => {
      await acquire.promise;
      ctx.onDispose(async () => {
        released = true;
      });
      throw new Error('apply 失败');
    })();
    ctx.trackActivation(applying);
    applying.catch(() => {}); // 调用方自行处理失败（activatePlugin 的 catch）

    const disposing = ctx.disposeAsync(1000);
    acquire.open();
    await disposing;
    // 抛错前挂上的 disposer 仍应被等到
    expect(released).toBe(true);
  });

  it('同步 dispose() 不等 apply —— 其「首个 await 前同步执行完」的语义不变', async () => {
    const root = makeContext();
    const ctx = root.fork('p');
    let syncDisposerRan = false;
    ctx.onDispose(() => {
      syncDisposerRan = true;
    });
    const { applying, acquire } = startPlugin(ctx, true);

    ctx.dispose();
    // 同步路径必须当场跑完已登记的同步 disposer，不因 apply 在飞而推迟
    expect(syncDisposerRan).toBe(true);

    acquire.open();
    await applying;
  });

  it('useModule 建的沙盒子 ctx 同样受保护（与 activatePlugin 同源）', async () => {
    const root = makeContext();
    const parent = root.fork('parent');
    const acquire = deferred();
    let released = false;

    // **不能 await useModule**：await 完 apply 就跑完了、disposer 早已在链上，
    // 那样测的是普通路径、对本改动零判别力。要造的是「子 ctx 的 apply 还在飞
    // 时父级联拆卸」。
    const pending = parent.useModule({
      name: 'sandbox',
      async apply(child) {
        await acquire.promise;
        child.onDispose(async () => {
          await sleep(0);
          released = true;
        });
      },
    });

    const disposing = parent.disposeAsync();
    acquire.open();
    await disposing;

    expect(released).toBe(true);
    await pending.catch(() => {}); // 父已拆，useModule 可能以任意方式收尾
  });

  it('级联：父 ctx 的 disposeAsync 会等到子 ctx 的初始化落定', async () => {
    const root = makeContext();
    const parent = root.fork('parent');
    const child = parent.fork('child');
    const { applying, state, acquire } = startPlugin(child, true);

    const disposing = parent.disposeAsync();
    acquire.open();
    await disposing;

    expect(state.released).toBe(true);
    await applying;
  });

  // ----- activatePlugin 的接线 -----
  //
  // 上面几条都手调 trackActivation 模拟激活路径。这条经真实的 activatePlugin，
  // 钉住 plugin-activation.ts 里那行登记——否则删掉它整个 test/core 仍然全绿，
  // 它随时会被当成死代码清掉。
  //
  // 直接拿 entry.context 拆卸而不经 PluginManager：管理入口如今会主动走进
  // 这个窗口（先改 state 让位、再 disposeAsync，锚在 admin-during-activation），
  // 本条钉的是更底层的「宿主直调」路径——不借任何编排、裸拆在飞 ctx。
  it('经 activatePlugin 激活的 ctx，其 apply 在飞时被拆卸也等得到 disposer', async () => {
    const root = makeContext();
    const acquire = deferred();
    let flushed = false;

    const entry: PluginEntry = {
      module: {
        name: 'race-mod',
        async apply(ctx) {
          await acquire.promise;
          ctx.onDispose(async () => {
            await sleep(0);
            flushed = true;
          });
        },
      },
      instanceId: 'race-mod',
      config: {},
      state: 'pending',
      requiredDeps: [],
      optionalDeps: [],
    };

    const activating = activatePlugin(entry, {
      plugins: new Map([['race-mod', entry]]),
      rootCtx: root,
      logger: new DefaultLogger('test'),
    });

    // activatePlugin 在 apply 之前就把 ctx 挂上 entry，此刻 apply 正卡在闸门里
    expect(entry.state).toBe('activating');
    const ctx = entry.context;
    expect(ctx).toBeDefined();

    const disposing = (ctx as Context).disposeAsync(1000);
    acquire.open();
    await disposing;

    expect(flushed).toBe(true);
    await activating;
  });
});

// ════════════════════════════════════════════════════════════
// 清理项的诊断标注。
//
// disposeAsync 超时告警本来只说「有东西超时了」，不说是哪一项——而它的文档
// 写着「warn 点名」。卡住时既不知道是哪个插件的哪个资源，也无从下手。
// ════════════════════════════════════════════════════════════
describe('清理超时/抛错时点名', () => {
  /** 造一个日志可截获的 ctx —— 诊断输出走 logger，不走返回值 */
  function ctxWithLogSink(): { ctx: Context; lines: string[] } {
    const lines: string[] = [];
    const sink = (m: unknown, e?: unknown) => lines.push(`${String(m)} ${e instanceof Error ? e.message : ''}`);
    const ctx = new Context({
      id: 'p',
      events: new EventBus(),
      services: new ServiceContainer(),
      hooks: new HookRegistry(),
      contributions: new ContributionRegistry(),
      logger: { warn: sink, debug: sink, info: sink, error: sink } as never,
      config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
    });
    return { ctx, lines };
  }

  it('有 label 时点 label', async () => {
    const { ctx, lines } = ctxWithLogSink();
    ctx.onDispose(() => new Promise(() => {}), 'lancedb-table');
    await ctx.disposeAsync(20);
    expect(lines.join('\n')).toMatch(/\[lancedb-table\]/);
  });

  it('清理抛错记 warn 级——默认日志级别下必须可见（泄漏头号成因不许静音）', () => {
    const lines: string[] = [];
    const tag = (lv: string) => (m: unknown, e?: unknown) =>
      lines.push(`${lv}|${String(m)} ${e instanceof Error ? e.message : ''}`);
    const ctx = new Context({
      id: 'p',
      events: new EventBus(),
      services: new ServiceContainer(),
      hooks: new HookRegistry(),
      contributions: new ContributionRegistry(),
      logger: { warn: tag('warn'), debug: tag('debug'), info: tag('info'), error: tag('error') } as never,
      config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
    });
    ctx.onDispose(() => {
      throw new Error('boom');
    }, 'mongo-client');
    ctx.dispose();
    expect(lines.find(l => l.includes('boom'))).toMatch(/^warn\|/);
  });

  it('清理抛错时也点名，不是一句无主的「已忽略」', () => {
    const { ctx, lines } = ctxWithLogSink();
    ctx.onDispose(() => {
      throw new Error('boom');
    }, 'mongo-client');
    ctx.dispose();
    expect(lines.join('\n')).toMatch(/\[mongo-client\].*boom|boom.*\[mongo-client\]/);
  });
});

describe('拆卸窗口内的 provides 校验归因', () => {
  // provide 的 post-dispose 守卫会吞掉拆卸窗口里的注册——那是框架层竞态，
  // 不是作者的声明错误。此测锚死如实归因（曾报「声明 provides 但未实际注册」的假罪名）。
  it('apply 在飞时被拆卸且声明了 provides：error 如实归因为「激活期间 Context 已被拆卸」', async () => {
    const root = makeContext();
    const acquire = deferred();

    const entry: PluginEntry = {
      module: {
        name: 'prov-mod',
        provides: ['db'],
        async apply(ctx) {
          await acquire.promise;
          ctx.provide('db', {});
        },
      },
      instanceId: 'prov-mod',
      config: {},
      state: 'pending',
      requiredDeps: [],
      optionalDeps: [],
    };

    const activating = activatePlugin(entry, {
      plugins: new Map([['prov-mod', entry]]),
      rootCtx: root,
      logger: new DefaultLogger('test'),
    });

    const ctx = entry.context;
    const disposing = (ctx as Context).disposeAsync(1000);
    acquire.open();
    await disposing;
    await activating;

    expect(entry.state).toBe('error');
    expect(entry.error).toContain('激活期间 Context 已被拆卸');
    expect(entry.error).not.toContain('未实际注册');
  });
});
