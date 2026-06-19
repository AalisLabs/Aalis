import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/index.js';

describe('ServiceContainer', () => {
  it('注册并查询单个服务', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'openai' }, 0, 'plugin-openai');
    const svc = c.get<{ name: string }>('llm');
    expect(svc?.name).toBe('openai');
  });

  it('getAll 返回所有提供者', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'openai' }, 0, 'plugin-openai');
    c.register('llm', { name: 'deepseek' }, 0, 'plugin-deepseek');
    const all = c.getAll('llm');
    expect(all).toHaveLength(2);
  });

  it('unregisterByContext 按 contextId 整体清理', () => {
    const c = new ServiceContainer();
    c.register('a', { v: 1 }, 0, 'plug-x');
    c.register('b', { v: 2 }, 0, 'plug-x');
    c.register('c', { v: 3 }, 0, 'plug-y');
    c.unregisterByContext('plug-x');
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toEqual({ v: 3 });
  });

  it('hasByContext / unregisterByContext 覆盖 per-entry 子粒度（owner/sub）', () => {
    const c = new ServiceContainer();
    c.register('llm', { v: 1 }, 0, 'plug-x/m1');
    c.register('llm', { v: 2 }, 0, 'plug-x/m2');
    c.register('llm', { v: 3 }, 0, 'plug-y');
    expect(c.hasByContext('llm', 'plug-x')).toBe(true);
    expect(c.hasByContext('llm', 'plug-y')).toBe(true);
    expect(c.hasByContext('llm', 'plug-z')).toBe(false);
    c.unregisterByContext('plug-x');
    expect(c.getAll('llm')).toHaveLength(1);
    expect(c.get<{ v: number }>('llm')?.v).toBe(3);
  });

  it('多提供者按 priority + 注册顺序解析（偏好之外）', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'low' }, 0, 'p1');
    c.register('llm', { name: 'high' }, 50, 'p2');
    expect(c.get<{ name: string }>('llm')?.name).toBe('high');
  });
});
