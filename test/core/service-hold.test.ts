import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

// ════════════════════════════════════════════════════════════
// 容器的「暂不对外」（hold）：编排层对转入后台的激活使用。解析类读口（get / getAll / inspect / ownerOf）
// 一律看不见被暂扣归属的条目；登记事实类读口（hasByContext / getServiceNames / 独占冲突）照常看得见。
// 返回值口径：每次对外可见的变化恰好对应一次事件——暂扣时返回撤下的名字，恢复时返回上线的名字，
// 暂扣期间的退订与整体摘除都不算对外少了提供者。
// ════════════════════════════════════════════════════════════

const HELD = Symbol('held');
const OTHER = Symbol('other');

describe('ServiceContainer.hold', () => {
  it('暂扣后解析类读口看不见、登记事实类读口看得见；恢复后照常解析', () => {
    const c = new ServiceContainer();
    c.register('svc', { v: 'held' }, 'held', HELD, { priority: 10 });
    c.register('svc', { v: 'other' }, 'other', OTHER);
    c.register('only', { v: 'only' }, 'held', HELD);
    expect(c.hold(HELD)).toEqual(['svc', 'only']);
    expect(c.isHeld(HELD)).toBe(true);
    expect(c.get('svc')).toEqual({ v: 'other' });
    expect(c.getAll('svc').map(view => view.contextId)).toEqual(['other']);
    expect(c.inspect('svc').map(info => info.contextId)).toEqual(['other']);
    expect(c.ownerOf('svc')).toBe(OTHER);
    expect(c.get('only')).toBeUndefined();
    expect(c.getAll('only')).toEqual([]);
    expect(c.ownerOf('only')).toBeUndefined();
    expect(c.hasByContext('only', 'held', HELD)).toBe(true);
    expect(c.getServiceNames()).toEqual(['svc', 'only']);

    expect(c.release(HELD)).toEqual(['svc', 'only']);
    expect(c.isHeld(HELD)).toBe(false);
    expect(c.get('svc')).toEqual({ v: 'held' });
    expect(c.get('only')).toEqual({ v: 'only' });
  });

  it('偏好指向被暂扣的条目：解析退回其余条目里的胜者，恢复后偏好重新生效', () => {
    const c = new ServiceContainer();
    c.register('svc', { v: 'held' }, 'held', HELD);
    c.register('svc', { v: 'other' }, 'other', OTHER, { priority: -1 });
    c.prefer('svc', 'held');
    c.hold(HELD);
    expect(c.get('svc')).toEqual({ v: 'other' });
    expect(c.getAll('svc').map(view => view.contextId)).toEqual(['other']);
    c.release(HELD);
    expect(c.get('svc')).toEqual({ v: 'held' });
  });

  it('未暂扣的归属 release 返回空；暂扣期间的退订不算对外少了提供者', () => {
    const c = new ServiceContainer();
    const off = c.register('svc', { v: 1 }, 'held', HELD);
    expect(c.release(HELD)).toEqual([]);
    c.hold(HELD);
    expect(off(), '被暂扣的条目从未对外，退订不发下线').toBe(false);
    expect(off(), '重复退订').toBe(false);
    expect(c.release(HELD), '名下已无条目').toEqual([]);
  });

  it('被暂扣的归属整体摘除：返回空名单并解除暂扣', () => {
    const c = new ServiceContainer();
    c.register('svc', { v: 1 }, 'held', HELD);
    c.hold(HELD);
    expect(c.unregisterByOwner(HELD)).toEqual([]);
    expect(c.isHeld(HELD)).toBe(false);
    expect(c.getServiceNames()).toEqual([]);
  });

  it('被暂扣的条目照常占着独占位：同名的其他提供者照样被拒', () => {
    const c = new ServiceContainer();
    c.register('solo', { v: 1 }, 'held', HELD, { exclusive: true });
    c.hold(HELD);
    expect(() => c.register('solo', { v: 2 }, 'other', OTHER)).toThrow('独占');
    expect(c.prefer('solo', 'other')).toBe(false);
  });
});
