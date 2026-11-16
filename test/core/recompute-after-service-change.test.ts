import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, definePlugin, defineService, lifecycle, provide, services } from '../../packages/core/src/index.js';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';
import { deferred } from '../helpers/deferred.js';

// 不等结果的重算请求（服务变更、后台激活落定、旧实例停下）当场只记下，下一个微任务才跑；没事可做的那一遍在同步段里
// 做完，不占着状态机。
// - 登记的返回时机不取决于调用方看不见的状态：应用刚建好、宿主刚登记或撤回服务、刚改偏好之后，同一拍或隔几拍登记，
//   返回时激活都已完成。
// - 一拍里的多次变更只看最终的现态、只重算一遍：服务下线又上线，必需它的插件不拆。
// - 变更之后立刻等 idle()，等得到这次重算；紧接着停机，这次 idle() 不被停机计划拖住。

const dep = defineService<{ v: number }>('rk:dep');
const spare = defineService<object>('rk:spare');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function makeApp(): App {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  return app;
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const states = (app: App): string[] => app.plugins.getStatus().map(item => `${item.instanceId}=${item.state}`);
/** 初始化跨一个宏任务的插件：登记若只是排队、立即返回，这时它还在激活中 */
const slow = (name: string, uses = {}) =>
  definePlugin({ name, uses, apply: () => new Promise<void>(resolve => setTimeout(resolve, 5)) });
/** 隔 hops 个微任务再调 fn；0 即同一个同步段 */
function hopsLater<T>(hops: number, fn: () => T): T | Promise<T> {
  if (hops === 0) return fn();
  let chain = Promise.resolve();
  for (let i = 1; i < hops; i++) chain = chain.then(() => {});
  return chain.then(fn);
}

describe('登记的返回时机不取决于看不见的内部状态', () => {
  const HOPS = [0, 1, 2, 3];

  it.each(HOPS)('应用刚建好，隔 %i 个微任务登记：返回时已激活', async hops => {
    const app = makeApp();
    await hopsLater(hops, () => app.plugin(slow('rk-first')));
    expect(states(app)).toEqual(['rk-first=active']);
  });

  it.each(HOPS)('宿主刚登记一项服务，隔 %i 个微任务登记必需它的插件：返回时已激活', async hops => {
    const app = makeApp();
    await app.plugins.idle();
    app.bind({ provide }).provide.use(dep, { v: 1 });
    await hopsLater(hops, () => app.plugin(slow('rk-consumer', { dep })));
    expect(states(app)).toEqual(['rk-consumer=active']);
  });

  it.each(HOPS)('宿主刚撤回一项没人用的服务，隔 %i 个微任务登记：返回时已激活', async hops => {
    const app = makeApp();
    const off = app.bind({ provide }).provide.use(spare, {});
    await app.plugins.idle();
    off();
    await hopsLater(hops, () => app.plugin(slow('rk-late')));
    expect(states(app)).toEqual(['rk-late=active']);
  });

  it.each(HOPS)('刚改过偏好，隔 %i 个微任务登记：返回时已激活', async hops => {
    const app = makeApp();
    const host = app.bind({ provide, services });
    host.provide.use(dep, { v: 1 });
    await app.plugins.idle();
    host.services.use.prefer(dep, 'elsewhere');
    await hopsLater(hops, () => app.plugin(slow('rk-consumer', { dep })));
    expect(states(app)).toEqual(['rk-consumer=active']);
  });

  it('刚建好的应用上同一拍批量登记：返回时全部已激活', async () => {
    const app = makeApp();
    await app.pluginAll(['a', 'b', 'c'].map(name => ({ definition: slow(`rk-${name}`) })));
    expect(states(app)).toEqual(['rk-a=active', 'rk-b=active', 'rk-c=active']);
  });
});

describe('服务变更之后的重算', () => {
  it('同一拍里必需的服务下线又上线：依赖它的插件不拆', async () => {
    const app = makeApp();
    const host = app.bind({ provide });
    const off = host.provide.use(dep, { v: 1 });
    let applies = 0;
    const drains: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'rk-steady',
        uses: { dep, lifecycle },
        apply({ lifecycle }) {
          applies++;
          lifecycle.use.onDrain(() => void drains.push('drain'));
        },
      }),
    );
    await app.plugins.idle();
    off();
    host.provide.use(dep, { v: 2 });
    await app.plugins.idle();
    expect([applies, drains, states(app)]).toEqual([1, [], ['rk-steady=active']]);
  });

  it('必需的服务下线之后立刻等 idle()：等得到这次重算，依赖它的插件已收尾并回到 pending', async () => {
    const app = makeApp();
    const off = app.bind({ provide }).provide.use(dep, { v: 1 });
    const drains: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'rk-waits',
        uses: { dep, lifecycle },
        apply: ({ lifecycle }) => void lifecycle.use.onDrain(() => void drains.push('drain')),
      }),
    );
    await app.plugins.idle();
    off();
    await app.plugins.idle();
    expect([states(app), drains]).toEqual([['rk-waits=pending'], ['drain']]);
  });

  it('同一拍里连着几次服务变更：只重算一遍，只通知一次', async () => {
    const app = makeApp();
    const host = app.bind({ provide });
    host.provide.use(dep, { v: 1 });
    await app.plugin(definePlugin({ name: 'rk-needs', uses: { dep }, apply() {} }));
    await app.plugins.idle();
    // 每一遍重算对每个 required 依赖判一次「还有没有人提供」：数这个判断的次数
    const judged = vi.spyOn(ServiceContainer.prototype, 'survives');
    let notified = 0;
    app.plugins.watch(() => void notified++);
    const burst = async (times: number): Promise<[number, number]> => {
      judged.mockClear();
      notified = 0;
      for (let i = 0; i < times; i++) host.provide.use(spare, {}, { entryId: `spare-${times}-${i}` });
      await app.plugins.idle();
      await tick();
      return [judged.mock.calls.length, notified];
    };
    const once = await burst(1);
    expect(once[1]).toBe(1);
    expect(await burst(3)).toEqual(once);
    judged.mockRestore();
  });
});

describe('服务变更之后紧接着停机', () => {
  it('变更后立刻等的 idle() 不被停机计划拖住：停机还卡在清理里时它已落定', async () => {
    const app = makeApp();
    const host = app.bind({ provide });
    const gate = deferred();
    await app.plugin(
      definePlugin({
        name: 'rk-holds',
        uses: { lifecycle },
        apply: ({ lifecycle }) => void lifecycle.use.onDispose(() => gate.promise),
      }),
    );
    await app.plugins.idle();
    host.provide.use(spare, {});
    const idle = app.plugins.idle().then(() => 'idle');
    const stopping = app.stop();
    const late = new Promise<string>(resolve => setTimeout(() => resolve('停机放行之前没落定'), 50));
    expect(await Promise.race([idle, late])).toBe('idle');
    gate.resolve();
    await stopping;
  });

  it.each([
    ['调度空闲', false],
    ['另有激活在途', true],
  ])('必需的服务下线后同一拍里停机（%s）：依赖方由停机计划关掉，只收尾一次', async (_, busy) => {
    const app = makeApp();
    const off = app.bind({ provide }).provide.use(dep, { v: 1 });
    const drains: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'rk-dependent',
        uses: { dep, lifecycle },
        apply: ({ lifecycle }) => void lifecycle.use.onDrain(() => void drains.push('drain')),
      }),
    );
    await app.plugins.idle();
    const gate = deferred();
    if (busy) void app.plugin(definePlugin({ name: 'rk-slow', apply: () => gate.promise }));
    off();
    const stopping = app.stop();
    gate.resolve();
    await stopping;
    expect([drains, app.plugins.getPlugin('rk-dependent')?.state]).toEqual([['drain'], 'disposed']);
  });
});
