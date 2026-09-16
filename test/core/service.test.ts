import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/index.js';

describe('ServiceContainer', () => {
  it('注册并查询单个服务', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'openai' }, 0, 'plugin-llm-openai');
    const svc = c.get<{ name: string }>('llm');
    expect(svc?.name).toBe('openai');
  });

  it('getAll 返回所有提供者', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'openai' }, 0, 'plugin-llm-openai');
    c.register('llm', { name: 'deepseek' }, 0, 'plugin-llm-deepseek');
    const all = c.getAll('llm');
    expect(all).toHaveLength(2);
  });

  it('unregisterByOwner 按清理归属整体清理', () => {
    const c = new ServiceContainer();
    const x = Symbol('plug-x');
    const y = Symbol('plug-y');
    c.register('a', { v: 1 }, 0, 'plug-x', undefined, x);
    c.register('b', { v: 2 }, 0, 'plug-x', undefined, x);
    c.register('c', { v: 3 }, 0, 'plug-y', undefined, y);
    c.unregisterByOwner(x);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toEqual({ v: 3 });
  });

  it('hasByContext 按 id 前缀查询（逻辑身份）；unregisterByOwner 按归属清掉 per-entry 子粒度', () => {
    const c = new ServiceContainer();
    const x = Symbol('plug-x');
    const y = Symbol('plug-y');
    c.register('llm', { v: 1 }, 0, 'plug-x/m1', undefined, x);
    c.register('llm', { v: 2 }, 0, 'plug-x/m2', undefined, x);
    c.register('llm', { v: 3 }, 0, 'plug-y', undefined, y);
    c.register('llm', { v: 4 }, 0, 'elsewhere/m3', undefined, x); // 不带 plug-x 前缀但同 owner：也要被清
    expect(c.hasByContext('llm', 'plug-x')).toBe(true);
    expect(c.hasByContext('llm', 'plug-y')).toBe(true);
    expect(c.hasByContext('llm', 'plug-z')).toBe(false);
    c.unregisterByOwner(x);
    expect(c.getAll('llm')).toHaveLength(1);
    expect(c.get<{ v: number }>('llm')?.v).toBe(3);
  });

  it('同 contextId 不同 owner：清一个不动另一个（同名 Context 互不误清）', () => {
    const c = new ServiceContainer();
    const a = Symbol('dup');
    const b = Symbol('dup');
    c.register('svc', { g: 1 }, 0, 'dup', undefined, a);
    c.register('svc', { g: 2 }, 0, 'dup', undefined, b);
    c.unregisterByOwner(a);
    expect(c.getAll('svc')).toHaveLength(1);
    expect(c.get<{ g: number }>('svc')?.g).toBe(2);
  });

  it('无 owner 的条目不被 unregisterByOwner 触及（绕过门面者用返回值自管）', () => {
    const c = new ServiceContainer();
    const e = c.register('svc', { g: 0 }, 0, 'dup');
    c.unregisterByOwner(Symbol('dup'));
    expect(c.getAll('svc')).toHaveLength(1);
    expect(c.unregisterEntry('svc', e)).toBe(true);
    expect(c.getAll('svc')).toHaveLength(0);
  });

  it('多提供者按 priority + 注册顺序解析（偏好之外）', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'low' }, 0, 'p1');
    c.register('llm', { name: 'high' }, 50, 'p2');
    expect(c.get<{ name: string }>('llm')?.name).toBe('high');
  });
});
