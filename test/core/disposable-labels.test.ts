import { describe, expect, it } from 'vitest';
import { defineService } from '../../packages/core/src/index.js';
import { createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// 清理项点名：按激活绑定的能力注册自动打标签（`前缀:名字`）。
// 把「卸载后还剩几个」升级为「剩的是谁」；不做嵌套树（无 effect 原语）。
// 测试键沿用 hooks/contributions 测试同一惯例：as never 绕过空接口键约束。
// ════════════════════════════════════════════════════════════

const EVT = '__t:evt' as never;
const HOOK = '__t:hook2' as never;
const POINT = '__t:point2' as never;

function makeFixture(id = 'root') {
  return createActivationFixture({ id });
}

describe('门面注册自动标签', () => {
  it('五个门面各按前缀点名；provide 显式 entryId 时用 entryId', () => {
    const ctx = makeFixture('p');
    ctx.caps.events.on(EVT, () => {});
    ctx.caps.hooks.middleware(HOOK, async (_d, next) => {
      await next();
    });
    ctx.caps.contributions.contribute(POINT, { id: 'me' } as never);
    ctx.caps.provide(defineService('svc'), {});
    ctx.caps.provide(defineService('llm'), {} as never, { entryId: 'p/model-a' });
    ctx.host.bind(ctx.activation, { ref: defineService('later') }).ref.follow(() => {});

    const labels = ctx.activation.resources.lifecycle.disposables.labels();
    expect(labels).toContain('on:__t:evt');
    expect(labels).toContain('middleware:__t:hook2');
    expect(labels).toContain('contribute:__t:point2:me');
    expect(labels).toContain('provide:svc');
    expect(labels).toContain('provide:p/model-a');
    expect(labels).toContain('watch:later');
    ctx.activation.dispose();
  });

  it('onDispose 作者标签保留，未命名项以 undefined 占位', () => {
    const ctx = makeFixture('p');
    const baseline = ctx.activation.resources.lifecycle.disposables.labels();
    ctx.caps.lifecycle.onDispose(() => {}, 'mongo-client');
    ctx.caps.lifecycle.onDispose(() => {});
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual([...baseline, 'mongo-client', undefined]);
    ctx.activation.dispose();
  });

  it('手动退订自摘：名单同步缩短（自移除语义不回归）', () => {
    const ctx = makeFixture('p');
    const baseline = ctx.activation.resources.lifecycle.disposables.labels();
    const off = ctx.caps.events.on(EVT, () => {});
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual([...baseline, 'on:__t:evt']);
    off();
    expect(ctx.activation.resources.lifecycle.disposables.labels()).toEqual(baseline);
    ctx.activation.dispose();
  });

  it('计数器与名单长度恒一致（两读口同源）', () => {
    const ctx = makeFixture('p');
    ctx.caps.provide(defineService('a'), {});
    ctx.caps.lifecycle.onDispose(() => {}, 'x');
    expect(ctx.activation.resources.lifecycle.disposables.size).toBe(
      ctx.activation.resources.lifecycle.disposables.labels().length,
    );
    ctx.activation.dispose();
  });
});

describe('贡献登记表枚举', () => {
  it('注册/注销对称，point 与 id 拆分正确（含 id 内含空格等字符）', () => {
    const ctx = makeFixture('p');
    const off = ctx.caps.contributions.contribute(POINT, { id: 'a b' } as never);
    expect(ctx.caps.contributions.collect(POINT).map(entry => [entry.key, (entry.spec as { id: string }).id])).toEqual([
      ['p/a b', 'a b'],
    ]);
    off();
    expect(ctx.caps.contributions.collect(POINT)).toEqual([]);
    ctx.activation.dispose();
  });
  it('onDispose 同一函数登记两次：撤销精确到本次登记，余下条目的逆序不翻转', () => {
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
    ctx.activation.dispose();
    // 链按引用首匹配移除：若撤销错项（删掉 first），余下 [mid, second] 逆序执行就成了 fn→mid
    expect(log).toEqual(['mid', 'fn']);
  });
});
