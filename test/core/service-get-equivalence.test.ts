import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/services.js';

// ════════════════════════════════════════════════════════════
// `get()` 与「偏好 > 优先级 > 注册顺序」的一致性
//
// `get()` 走的是短路径（直接读 entries + preferences），不经 `resolveEntries` 的重排。
// 两条路径必须给出同一个冠军，否则同一个服务名在 `getService` 与 `getAllServices`
// 眼里会是两个不同的实例 —— 这类分歧不会报错，只会让调用方拿到意料之外的 provider。
//
// 这里穷举「几个 entry × 各种 priority × 偏好指向谁（含指向已不存在的 ctxId）」，
// 逐组比对 `get()` 与 `getEntries()[0]`。
// ════════════════════════════════════════════════════════════

interface Case {
  label: string;
  entries: Array<{ ctxId: string; priority: number }>;
  preference?: string;
}

const CASES: Case[] = [
  { label: '单 entry，无偏好', entries: [{ ctxId: 'a', priority: 0 }] },
  { label: '单 entry，偏好指向它', entries: [{ ctxId: 'a', priority: 0 }], preference: 'a' },
  { label: '单 entry，偏好指向不存在的', entries: [{ ctxId: 'a', priority: 0 }], preference: 'ghost' },
  {
    label: '多 entry，无偏好 → 取最高 priority',
    entries: [
      { ctxId: 'a', priority: 0 },
      { ctxId: 'b', priority: 10 },
      { ctxId: 'c', priority: 5 },
    ],
  },
  {
    label: '多 entry，偏好指向最低 priority（偏好必须胜过 priority）',
    entries: [
      { ctxId: 'a', priority: 0 },
      { ctxId: 'b', priority: 10 },
      { ctxId: 'c', priority: 5 },
    ],
    preference: 'a',
  },
  {
    label: '多 entry，偏好指向已不存在的 → 回落 priority',
    entries: [
      { ctxId: 'a', priority: 0 },
      { ctxId: 'b', priority: 10 },
    ],
    preference: 'ghost',
  },
  {
    label: '同 priority → 保持注册顺序（稳定排序）',
    entries: [
      { ctxId: 'first', priority: 3 },
      { ctxId: 'second', priority: 3 },
      { ctxId: 'third', priority: 3 },
    ],
  },
  {
    label: '同 priority + 偏好指向后注册的',
    entries: [
      { ctxId: 'first', priority: 3 },
      { ctxId: 'second', priority: 3 },
    ],
    preference: 'second',
  },
  {
    label: '负 priority 与 0 混排',
    entries: [
      { ctxId: 'a', priority: -5 },
      { ctxId: 'b', priority: 0 },
      { ctxId: 'c', priority: -1 },
    ],
  },
];

function build(c: Case): ServiceContainer {
  const sc = new ServiceContainer();
  for (const e of c.entries) sc.register('svc', { tag: e.ctxId }, e.priority, e.ctxId);
  if (c.preference) sc.prefer('svc', c.preference);
  return sc;
}

describe('ServiceContainer.get 与全表解析给出同一个冠军', () => {
  for (const c of CASES) {
    it(c.label, () => {
      const sc = build(c);
      const viaGet = sc.get<{ tag: string }>('svc');
      const viaEntries = sc.getEntries('svc')[0]?.instance as { tag: string } | undefined;
      expect(viaGet, '短路径与全表解析的冠军不一致').toBe(viaEntries);
    });
  }

  it('服务不存在时两条路径都给 undefined', () => {
    const sc = new ServiceContainer();
    expect(sc.get('nope')).toBeUndefined();
    expect(sc.getEntries('nope')[0]).toBeUndefined();
  });

  it('偏好被撤销后回落到 priority 冠军', () => {
    const sc = build({
      label: '',
      entries: [
        { ctxId: 'low', priority: 0 },
        { ctxId: 'high', priority: 9 },
      ],
      preference: 'low',
    });
    expect((sc.get<{ tag: string }>('svc') as { tag: string }).tag).toBe('low');
    sc.unprefer('svc');
    expect((sc.get<{ tag: string }>('svc') as { tag: string }).tag).toBe('high');
    expect(sc.get<{ tag: string }>('svc')).toBe(sc.getEntries('svc')[0]?.instance);
  });
});
