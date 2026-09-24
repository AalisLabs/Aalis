import { afterEach, describe, expect, it } from 'vitest';
import {
  DefaultLogger,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';
import type { Activation } from '../../packages/core/src/orchestration/activation.js';
import { activatePlugin, type PluginRecord } from '../../packages/core/src/orchestration/plugin-activation.js';
import { createActivationFixture } from '../helpers/activation.js';

// ============================================================
// disposeAsync 的时序承诺：「返回时异步清理已真正完成」。
//
// 被打破的场景是全仓最常见的资源写法——apply 里先 await 拿资源、再挂
// onDispose（memory-mongodb 的 connect + 4 个 createIndex、memory-sqlite 的
// 开库、vectorstore-lancedb 的建表都是这个形状）。拆卸落在这个窗口里时，
// disposer 到达时清理链已排空，DisposableChain.push 走 post-dispose 分支就地
// 执行它——资源最终会关，但**异步返回值不被等待**，承诺落空。
//
// 可达面：PluginManager 的 unload / disable / bounce 会主动走进
// 本窗口（先改 entry.state 让激活收尾让位，再对在飞 ctx disposeAsync——那三条
// 路径的行为锚在 test/core/admin-during-activation.test.ts）；本文件守的是
// disposeAsync 这个内部契约本身（宿主直调）与父激活对子激活的级联。
//
// 时序不靠 sleep 赌：闸门不开 apply 就不落定，「拆卸发起时 apply 必定
// 在飞」是结构保证，不受 CI 负载影响。唯一按时间断言的是超时兜底那条。
// ============================================================

const activations: Activation[] = [];
afterEach(async () => {
  for (const ctx of activations.splice(0)) {
    if (!ctx.resources.disposed) await ctx.disposeAsync().catch(() => {});
  }
});

function makeActivation(id = 'root') {
  const fixture = createActivationFixture({ id });
  activations.push(fixture.activation);
  return fixture;
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
function startPlugin(ctx: Activation, track: boolean) {
  const acquire = deferred();
  const state = { released: false };
  const applying = (async () => {
    await acquire.promise; // 模拟 await client.connect()
    ctx.resources.onDispose(async () => {
      await sleep(0); // 模拟异步关闭 / 落盘：跨一个宏任务
      state.released = true;
    });
  })();
  if (track) ctx.resources.trackInitialization(applying);
  return { applying, state, acquire };
}

describe('disposeAsync 与初始化在飞的竞态', () => {
  it('登记 apply 后，disposeAsync 返回时异步清理已真正完成', async () => {
    const { host, activation: root } = makeActivation();
    const ctx = host.create(root, 'p');
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
    const { host, activation: root } = makeActivation();
    const ctx = host.create(root, 'p');
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
    const { host, activation: root } = makeActivation();
    const ctx = host.create(root, 'p');
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
    const { host, activation: root } = makeActivation();
    const ctx = host.create(root, 'p');
    const acquire = deferred();
    let released = false;
    const applying = (async () => {
      await acquire.promise;
      ctx.resources.onDispose(async () => {
        released = true;
      });
      throw new Error('apply 失败');
    })();
    ctx.resources.trackInitialization(applying);
    applying.catch(() => {}); // 调用方自行处理失败（activatePlugin 的 catch）

    const disposing = ctx.disposeAsync(1000);
    acquire.open();
    await disposing;
    // 抛错前挂上的 disposer 仍应被等到
    expect(released).toBe(true);
  });

  it('级联：父 ctx 的 disposeAsync 会等到子 ctx 的初始化落定', async () => {
    const { host, activation: root } = makeActivation();
    const parent = host.create(root, 'parent');
    const child = host.create(parent, 'child');
    const { applying, state, acquire } = startPlugin(child, true);

    const disposing = parent.disposeAsync();
    acquire.open();
    await disposing;

    expect(state.released).toBe(true);
    await applying;
  });

  // ----- activatePlugin 的接线 -----
  //
  // 上面几条都手调 trackInitialization 模拟激活路径。这条经真实的 activatePlugin，
  // 钉住 plugin-activation.ts 里那行登记——否则删掉它整个 test/core 仍然全绿，
  // 它随时会被当成死代码清掉。
  //
  // 直接拿内部记录的 activation 拆卸而不经 PluginManager：管理入口如今会主动走进
  // 这个窗口（先改 state 让位、再 disposeAsync，锚在 admin-during-activation），
  // 本条钉的是更底层的「宿主直调」路径——不借任何编排、裸拆在飞 ctx。
  it('经 activatePlugin 激活的 ctx，其 apply 在飞时被拆卸也等得到 disposer', async () => {
    const { host } = makeActivation();
    const acquire = deferred();
    let flushed = false;

    const entry: PluginRecord = {
      definition: definePlugin({
        name: 'race-mod',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await acquire.promise;
          lifecycle.onDispose(async () => {
            await sleep(0);
            flushed = true;
          });
        },
      }),
      instanceId: 'race-mod',
      config: {},
      state: 'pending',
      required: [],
      optional: [],
    };

    const activating = activatePlugin(entry, {
      host,
      logger: new DefaultLogger('test'),
    });

    // activatePlugin 在 apply 之前就把 activation 挂上内部记录，此刻 apply 正卡在闸门里
    expect(entry.state).toBe('activating');
    const ctx = entry.activation;
    expect(ctx).toBeDefined();

    const disposing = ctx!.disposeAsync(1000);
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
  function ctxWithLogSink(): { ctx: Activation; lines: string[] } {
    const lines: string[] = [];
    const sink = (m: unknown, e?: unknown) => lines.push(`${String(m)} ${e instanceof Error ? e.message : ''}`);
    const logger: Logger = { warn: sink, debug: sink, info: sink, error: sink, child: () => logger };
    const { activation: ctx } = createActivationFixture({ id: 'p', logger });
    activations.push(ctx);
    return { ctx, lines };
  }

  it('有 label 时点 label', async () => {
    const { ctx, lines } = ctxWithLogSink();
    ctx.resources.onDispose(() => new Promise(() => {}), 'lancedb-table');
    await ctx.disposeAsync(20);
    expect(lines.join('\n')).toMatch(/\[lancedb-table\]/);
  });

  it('清理抛错记 warn 级——默认日志级别下必须可见（泄漏头号成因不许静音）', async () => {
    const lines: string[] = [];
    const tag = (lv: string) => (m: unknown, e?: unknown) =>
      lines.push(`${lv}|${String(m)} ${e instanceof Error ? e.message : ''}`);
    const logger: Logger = {
      warn: tag('warn'),
      debug: tag('debug'),
      info: tag('info'),
      error: tag('error'),
      child: () => logger,
    };
    const { activation: ctx } = createActivationFixture({ id: 'p', logger });
    activations.push(ctx);
    ctx.resources.onDispose(() => {
      throw new Error('boom');
    }, 'mongo-client');
    await ctx.disposeAsync();
    expect(lines.find(l => l.includes('boom'))).toMatch(/^warn\|/);
  });

  it('清理抛错时也点名，不是一句无主的「已忽略」', async () => {
    const { ctx, lines } = ctxWithLogSink();
    ctx.resources.onDispose(() => {
      throw new Error('boom');
    }, 'mongo-client');
    await ctx.disposeAsync();
    expect(lines.join('\n')).toMatch(/\[mongo-client\].*boom|boom.*\[mongo-client\]/);
  });
});

describe('拆卸窗口内的 provides 校验归因', () => {
  // provide 的 post-dispose 守卫会吞掉拆卸窗口里的注册——那是框架层竞态，
  // 不是作者的声明错误。此测锚死如实归因（曾报「声明 provides 但未实际注册」的假罪名）。
  it('apply 在飞时被拆卸且声明了 provides：error 如实归因为「激活期间资源已被拆卸」', async () => {
    const { host } = makeActivation();
    const acquire = deferred();
    const db = defineService('__t:dar-db');

    const entry: PluginRecord = {
      definition: definePlugin({
        name: 'prov-mod',
        uses: { provide },
        provides: [db],
        async apply({ provide: pub }) {
          await acquire.promise;
          pub(db, {});
        },
      }),
      instanceId: 'prov-mod',
      config: {},
      state: 'pending',
      required: [],
      optional: [],
    };

    const activating = activatePlugin(entry, {
      host,
      logger: new DefaultLogger('test'),
    });

    const ctx = entry.activation;
    const disposing = ctx!.disposeAsync(1000);
    acquire.open();
    await disposing;
    await activating;

    expect(entry.state).toBe('error');
    expect(entry.error).toContain('激活期间资源已被拆卸');
    expect(entry.error).not.toContain('未实际注册');
  });
});
