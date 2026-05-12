import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/index.js';

describe('ServiceContainer', () => {
  it('注册并查询单个服务', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'openai' }, [], 0, 'plugin-openai');
    const svc = c.get<{ name: string }>('llm');
    expect(svc?.name).toBe('openai');
  });

  it('getAll 返回所有提供者', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'openai' }, [], 0, 'plugin-openai');
    c.register('llm', { name: 'deepseek' }, [], 0, 'plugin-deepseek');
    const all = c.getAll('llm');
    expect(all).toHaveLength(2);
  });

  it('unregisterByContext 按 contextId 整体清理', () => {
    const c = new ServiceContainer();
    c.register('a', { v: 1 }, [], 0, 'plug-x');
    c.register('b', { v: 2 }, [], 0, 'plug-x');
    c.register('c', { v: 3 }, [], 0, 'plug-y');
    c.unregisterByContext('plug-x');
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toEqual({ v: 3 });
  });

  it('能力过滤：required 不满足则 get 返回 undefined', () => {
    const c = new ServiceContainer();
    c.register('llm', { name: 'plain' }, ['chat'], 0, 'p1');
    c.register('llm', { name: 'pro' }, ['chat', 'tool_calling'], 0, 'p2');
    expect(c.get<{ name: string }>('llm', ['tool_calling'])?.name).toBe('pro');
    expect(c.has('llm', ['nonexistent_cap'])).toBe(false);
  });
});
