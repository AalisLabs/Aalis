import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/index.js';

describe('ServiceContainer', () => {
  it('注册并查询单个服务', () => {
    const c = new ServiceContainer();
    c.register('__t:llm', { name: 'openai' }, 'plugin-llm-openai');
    const svc = c.get<{ name: string }>('__t:llm');
    expect(svc?.name).toBe('openai');
  });

  it('getAll 返回所有提供者', () => {
    const c = new ServiceContainer();
    c.register('__t:llm', { name: 'openai' }, 'plugin-llm-openai');
    c.register('__t:llm', { name: 'deepseek' }, 'plugin-llm-deepseek');
    const all = c.getAll('__t:llm');
    expect(all).toHaveLength(2);
  });

  it('unregisterByOwner 按清理归属整体清理', () => {
    const c = new ServiceContainer();
    const x = Symbol('plug-x');
    const y = Symbol('plug-y');
    c.register('a', { v: 1 }, 'plug-x', x);
    c.register('b', { v: 2 }, 'plug-x', x);
    c.register('c', { v: 3 }, 'plug-y', y);
    c.unregisterByOwner(x);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toEqual({ v: 3 });
  });

  it('hasByContext 按 id 前缀查询（逻辑身份）；unregisterByOwner 按归属清掉 per-entry 子粒度', () => {
    const c = new ServiceContainer();
    const x = Symbol('plug-x');
    const y = Symbol('plug-y');
    c.register('__t:llm', { v: 1 }, 'plug-x/m1', x);
    c.register('__t:llm', { v: 2 }, 'plug-x/m2', x);
    c.register('__t:llm', { v: 3 }, 'plug-y', y);
    c.register('__t:llm', { v: 4 }, 'elsewhere/m3', x); // 不带 plug-x 前缀但同 owner：也要被清
    expect(c.hasByContext('__t:llm', 'plug-x')).toBe(true);
    expect(c.hasByContext('__t:llm', 'plug-y')).toBe(true);
    expect(c.hasByContext('__t:llm', 'plug-z')).toBe(false);
    c.unregisterByOwner(x);
    expect(c.getAll('__t:llm')).toHaveLength(1);
    expect(c.get<{ v: number }>('__t:llm')?.v).toBe(3);
  });

  it('同 contextId 不同 owner：清一个不动另一个（同名 Context 互不误清）', () => {
    const c = new ServiceContainer();
    const a = Symbol('dup');
    const b = Symbol('dup');
    c.register('svc', { g: 1 }, 'dup', a);
    c.register('svc', { g: 2 }, 'dup', b);
    c.unregisterByOwner(a);
    expect(c.getAll('svc')).toHaveLength(1);
    expect(c.get<{ g: number }>('svc')?.g).toBe(2);
  });

  it('无 owner 的条目不被 unregisterByOwner 触及（绕过门面者用返回值自管）', () => {
    const c = new ServiceContainer();
    const off = c.register('svc', { g: 0 }, 'dup');
    c.unregisterByOwner(Symbol('dup'));
    expect(c.getAll('svc')).toHaveLength(1);
    expect(off(), '退订闭包报告真的摘掉了').toBe(true);
    expect(c.getAll('svc')).toHaveLength(0);
    expect(off(), '再退订一次：条目已不在，报 false').toBe(false);
  });

  it('多提供者按 priority + 注册顺序解析（偏好之外）', () => {
    const c = new ServiceContainer();
    c.register('__t:llm', { name: 'low' }, 'p1');
    c.register('__t:llm', { name: 'high' }, 'p2', undefined, { priority: 50 });
    expect(c.get<{ name: string }>('__t:llm')?.name).toBe('high');
  });
});

describe('ServiceContainer unregisterByOwner', () => {
  it('同一 owner 在同一服务名下相邻的多条登记全部清掉', () => {
    const c = new ServiceContainer();
    const a = Symbol('a');
    c.register('__t:llm', { v: 1 }, 'plugin-a', a);
    c.register('__t:llm', { v: 2 }, 'plugin-a/sub', a);
    c.register('__t:llm', { v: 3 }, 'plugin-b', Symbol('b'));
    expect(c.unregisterByOwner(a)).toEqual(['__t:llm']);
    expect(c.getAll('__t:llm').map(e => e.instance)).toEqual([{ v: 3 }]);
  });
});

describe('ServiceContainer 枚举口', () => {
  it('getEntries 返回快照：改动返回值不影响容器', () => {
    const c = new ServiceContainer();
    c.register('__t:llm', { v: 1 }, 'plugin-a');
    const entries = c.getEntries('__t:llm');
    entries.length = 0;
    expect(c.getEntries('__t:llm')).toHaveLength(1);
    expect(c.get('__t:llm')).toEqual({ v: 1 });
  });
});
