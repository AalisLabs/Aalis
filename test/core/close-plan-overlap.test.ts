// 两张关闭计划交叠：后一张计划把前一张里正在关的消费者也排进图，只为等它关完。它在这张图里的收尾阶段是空的，
// 本计划的成员把它当提供者时连过去的边排不了任何先后，却会与真正有用的边凑成环，剪边时剪掉的正是有用的那条。
import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
} from '../../packages/core/src/index.js';
import { deferred } from '../helpers/deferred.js';

/** 让出到下一个宏任务：此前排下的微任务（关闭计划里不等计时器的那些步骤）都已执行完毕 */
const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world() {
  const trace: string[] = [];
  const cycles: string[] = [];
  const logger: Logger = {
    debug: (...a: unknown[]) => void (String(a[0]).includes('成环') && cycles.push(String(a[0]))),
    info() {},
    warn: (...a: unknown[]) => void (String(a[0]).includes('成环') && cycles.push(String(a[0]))),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'close-plan-overlap', logger, disposeTimeoutMs: 2000 });
  apps.push(app);
  return { app, trace, cycles };
}

describe('交叠的关闭计划', () => {
  it('required：消费者 c 正在别的计划里关，卸载它的提供者 p 时 p 等 c 关完才收尾', async () => {
    const { app, trace, cycles } = world();
    const sn = defineService<{ from: string }>('cpo-r-sn');
    const sm = defineService<{ from: string }>('cpo-r-sm');
    const sk = defineService<{ from: string }>('cpo-r-sk');
    // alt 与 c 都提供 sm，p 选中先登记的 alt；c 只是没被选中的后备，但它对外提供 sm 让 p 的计划里多出一条连到 c 的边
    const alt = definePlugin({
      name: 'cpo-alt',
      provides: [sm],
      uses: { provide },
      apply: ({ provide }) => void provide.use(sm, { from: 'alt' }),
    });
    const p = definePlugin({
      name: 'cpo-p',
      provides: [sn],
      uses: { provide, lifecycle, sm },
      apply({ provide, lifecycle }) {
        provide.use(sn, { from: 'p' });
        lifecycle.use.onDispose(() => void trace.push('p 清理'));
      },
    });
    const c = definePlugin({
      name: 'cpo-c',
      provides: [sm, sk],
      uses: { provide, lifecycle, sn },
      apply({ provide, lifecycle, sn }) {
        provide.use(sm, { from: 'c' });
        provide.use(sk, { from: 'c' });
        lifecycle.use.onDrain(() => {
          let from = '无';
          try {
            from = sn.use.from;
          } catch {}
          trace.push(`c 收尾，sn 来自 ${from}`);
        });
      },
    });
    // d 的清理卡在闸门上：c 的计划里 c 要等 d 关完才收尾，p 的卸载落在这段时间里
    const dStarted = deferred();
    const dGate = deferred();
    const d = definePlugin({
      name: 'cpo-d',
      uses: { lifecycle, sk },
      apply: ({ lifecycle }) =>
        void lifecycle.use.onDispose(() => {
          dStarted.resolve();
          return dGate.promise;
        }),
    });
    await app.pluginAll([alt, p, c, d].map(definition => ({ definition })));
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(s => s.state)).toEqual(['active', 'active', 'active', 'active']);
    cycles.length = 0;

    const first = app.plugins.unload('cpo-c');
    await dStarted.promise;
    const second = app.plugins.unload('cpo-p');
    await macrotask();
    dGate.resolve();
    await Promise.all([first, second]);
    expect(trace).toEqual(['c 收尾，sn 来自 p', 'p 清理']);
    expect(cycles).toEqual([]);
  });

  it('optional：消费者 k 正在别的计划里收尾，卸载它 optional 的提供者 m（m 也 optional 用着 k 提供的服务）时 m 等 k 关完才清理', async () => {
    const { app, trace, cycles } = world();
    const sk = defineService<{ from: string }>('cpo-o-sk');
    const sm = defineService<{ from: string }>('cpo-o-sm');
    // k 的收尾卡在闸门上，m 的卸载落在这段时间里
    const kStarted = deferred();
    const kGate = deferred();
    const alt = definePlugin({
      name: 'cpo-alt',
      provides: [sk],
      uses: { provide },
      apply: ({ provide }) => void provide.use(sk, { from: 'alt' }),
    });
    const m = definePlugin({
      name: 'cpo-m',
      provides: [sm],
      uses: { provide, lifecycle, sk: optional(sk) },
      apply({ provide, lifecycle }) {
        provide.use(sm, { from: 'm' });
        lifecycle.use.onDispose(() => void trace.push('m 清理'));
      },
    });
    const k = definePlugin({
      name: 'cpo-k',
      provides: [sk],
      uses: { provide, lifecycle, sm: optional(sm) },
      apply({ provide, lifecycle, sm }) {
        provide.use(sk, { from: 'k' });
        lifecycle.use.onDrain(async () => {
          kStarted.resolve();
          await kGate.promise;
          trace.push(`k 收尾结束，sm ${sm.present ? '在' : '不在'}`);
        });
      },
    });
    await app.pluginAll([alt, m, k].map(definition => ({ definition })));
    await app.plugins.idle();
    expect(app.plugins.getStatus().map(s => s.state)).toEqual(['active', 'active', 'active']);
    cycles.length = 0;

    const first = app.plugins.unload('cpo-k');
    await kStarted.promise;
    const second = app.plugins.unload('cpo-m');
    await macrotask();
    kGate.resolve();
    await Promise.all([first, second]);
    expect(trace).toEqual(['k 收尾结束，sm 在', 'm 清理']);
    expect(cycles).toEqual([]);
  });
});
