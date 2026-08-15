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

// ════════════════════════════════════════════════════════════
// 清理项点名：内核门面注册自动打标签（`前缀:名字`）+ 两个枚举读口。
// 把「卸载后还剩几个」升级为「剩的是谁」；不做嵌套树（无 effect 原语）。
// 测试键沿用 hooks/contributions 测试同一惯例：as never 绕过空接口键约束。
// ════════════════════════════════════════════════════════════

const EVT = '__t:evt' as never;
const HOOK = '__t:hook2' as never;
const POINT = '__t:point2' as never;

function makeContext(id = 'root'): Context {
  return new Context({
    id,
    events: new EventBus(),
    services: new ServiceContainer(),
    hooks: new HookRegistry(),
    contributions: new ContributionRegistry(),
    logger: new DefaultLogger('test'),
    config: new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} }),
  });
}

describe('门面注册自动标签', () => {
  it('五个门面各按前缀点名；provide 显式 entryId 时用 entryId', () => {
    const ctx = makeContext('p');
    ctx.on(EVT, () => {});
    ctx.middleware(HOOK, async (_d, next) => {
      await next();
    });
    ctx.contribute(POINT, { id: 'me' } as never);
    ctx.provide('svc', {});
    ctx.provide('llm', {}, { entryId: 'p/model-a' });
    ctx.whenService('later', () => {});

    const labels = ctx.listDisposables();
    expect(labels).toContain('on:__t:evt');
    expect(labels).toContain('middleware:__t:hook2');
    expect(labels).toContain('contribute:__t:point2:me');
    expect(labels).toContain('provide:svc');
    expect(labels).toContain('provide:p/model-a');
    expect(labels).toContain('whenService:later');
    ctx.dispose();
  });

  it('onDispose 作者标签保留，未命名项以 undefined 占位', () => {
    const ctx = makeContext('p');
    ctx.onDispose(() => {}, 'mongo-client');
    ctx.onDispose(() => {});
    expect(ctx.listDisposables()).toEqual(['mongo-client', undefined]);
    ctx.dispose();
  });

  it('手动退订自摘：名单同步缩短（自移除语义不回归）', () => {
    const ctx = makeContext('p');
    const off = ctx.on(EVT, () => {});
    expect(ctx.listDisposables()).toEqual(['on:__t:evt']);
    off();
    expect(ctx.listDisposables()).toEqual([]);
    ctx.dispose();
  });

  it('计数器与名单长度恒一致（两读口同源）', () => {
    const ctx = makeContext('p');
    ctx.provide('a', {});
    ctx.onDispose(() => {}, 'x');
    expect(ctx.disposableCount).toBe(ctx.listDisposables().length);
    ctx.dispose();
  });
});

describe('贡献登记表枚举', () => {
  it('注册/注销对称，point 与 id 拆分正确（含 id 内含空格等字符）', () => {
    const ctx = makeContext('p');
    const off = ctx.contribute(POINT, { id: 'a b' } as never);
    expect(ctx.listContributions()).toEqual([{ point: '__t:point2', id: 'a b' }]);
    off();
    expect(ctx.listContributions()).toEqual([]);
    ctx.dispose();
  });
});
