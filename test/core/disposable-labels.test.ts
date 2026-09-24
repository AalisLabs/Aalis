import { describe, expect, it } from 'vitest';
import { defineService } from '../../packages/core/src/index.js';
import { createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// 清理项点名：进清理链的条目带标签（跟随为 `watch:服务名`，onDispose 用作者标签）。
// 把「卸载后还剩几个」升级为「剩的是谁」；不做嵌套树（无 effect 原语）。
// 四原语（监听 / 中间件 / 贡献 / 服务登记）按身份归属、激活关闭时整体切断，不进清理链。
// hooks/contributions 测试键沿用同一惯例：as never 绕过空接口键约束；事件键经 declaration merging 登记。
// ════════════════════════════════════════════════════════════

declare module '@aalis/core' {
  interface AalisEvents {
    '__t:evt': [];
  }
}

const EVT = '__t:evt';
const HOOK = '__t:hook2' as never;
const POINT = '__t:point2' as never;

function makeFixture(id = 'root') {
  return createActivationFixture({ id });
}

describe('清理链点名', () => {
  it('四原语登记不进清理链、激活关闭时一并撤回（含显式 entryId 的服务登记）；跟随按 watch:服务名 点名', async () => {
    const ctx = makeFixture('p');
    const baseline = ctx.activation.resources.lifecycle.disposables.labels();
    let heard = 0;
    let passed = 0;
    ctx.caps.events.on(EVT, () => {
      heard++;
    });
    ctx.caps.hooks.middleware(HOOK, async (_d, next) => {
      passed++;
      await next();
    });
    ctx.caps.contributions.contribute(POINT, { id: 'me' } as never);
    ctx.caps.provide(defineService('svc'), {});
    ctx.caps.provide(defineService('llm'), {} as never, { entryId: 'p/model-a' });
    ctx.host.bind(ctx.activation, { ref: defineService('later') }).ref.follow(() => {});

    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual([...baseline, 'watch:later']);
    await ctx.events.emit(EVT);
    await ctx.hooks.run(HOOK, {} as never);
    expect([heard, passed]).toEqual([1, 1]);
    expect(ctx.contributions.collect(POINT).map(entry => entry.key)).toEqual(['p/me']);
    expect(ctx.services.get('svc')).toEqual({});
    expect(ctx.services.inspect('llm')).toEqual([expect.objectContaining({ contextId: 'p/model-a' })]);

    await ctx.activation.disposeAsync();
    await ctx.events.emit(EVT);
    await ctx.hooks.run(HOOK, {} as never);
    expect([heard, passed]).toEqual([1, 1]);
    expect(ctx.contributions.collect(POINT)).toEqual([]);
    expect(ctx.services.get('svc')).toBeUndefined();
    expect(ctx.services.inspect('llm')).toEqual([]);
  });

  it('onDispose 作者标签保留，未命名项以 undefined 占位', async () => {
    const ctx = makeFixture('p');
    const baseline = ctx.activation.resources.lifecycle.disposables.labels();
    ctx.caps.lifecycle.onDispose(() => {}, 'mongo-client');
    ctx.caps.lifecycle.onDispose(() => {});
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual([...baseline, 'mongo-client', undefined]);
    await ctx.activation.disposeAsync();
  });

  it('手动退订：清理链始终不留条目，退订即同步撤回监听', async () => {
    const ctx = makeFixture('p');
    const baseline = ctx.activation.resources.lifecycle.disposables.labels();
    let heard = 0;
    const off = ctx.caps.events.on(EVT, () => {
      heard++;
    });
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual(baseline);
    await ctx.events.emit(EVT);
    off();
    await ctx.events.emit(EVT);
    expect(heard).toBe(1);
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual(baseline);
    await ctx.activation.disposeAsync();
  });

  it('计数器与名单长度恒一致（两读口同源）', async () => {
    const ctx = makeFixture('p');
    ctx.caps.provide(defineService('a'), {});
    ctx.caps.lifecycle.onDispose(() => {}, 'x');
    expect(ctx.activation.resources.lifecycle.disposables.size).toBe(
      ctx.activation.resources.lifecycle.disposables.labels().length,
    );
    await ctx.activation.disposeAsync();
  });
});

describe('贡献登记表枚举', () => {
  it('注册/注销对称，point 与 id 拆分正确（含 id 内含空格等字符）', async () => {
    const ctx = makeFixture('p');
    const off = ctx.caps.contributions.contribute(POINT, { id: 'a b' } as never);
    expect(ctx.caps.contributions.collect(POINT).map(entry => [entry.key, (entry.spec as { id: string }).id])).toEqual([
      ['p/a b', 'a b'],
    ]);
    off();
    expect(ctx.caps.contributions.collect(POINT)).toEqual([]);
    await ctx.activation.disposeAsync();
  });
  it('onDispose 同一函数登记两次：撤销精确到本次登记，余下条目的逆序不翻转', async () => {
    const ctx = makeFixture('dup');
    const baseline = ctx.activation.resources.lifecycle.disposables.labels();
    const log: string[] = [];
    const fn = () => {
      log.push('fn');
    };
    ctx.caps.lifecycle.onDispose(fn, 'first');
    ctx.caps.lifecycle.onDispose(() => {
      log.push('mid');
    }, 'mid');
    const off = ctx.caps.lifecycle.onDispose(fn, 'second');
    off();
    off(); // 幂等
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual([...baseline, 'first', 'mid']);
    await ctx.activation.disposeAsync();
    // 链按引用首匹配移除：若撤销错项（删掉 first），余下 [mid, second] 逆序执行就成了 fn→mid
    expect(log).toEqual(['mid', 'fn']);
  });
});
