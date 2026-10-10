import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

// ════════════════════════════════════════════════════════════
// 胜者解析的规格表：偏好 > 优先级 > 注册顺序。
// get、ownerOf 与 getAll 的首项是同一个胜者；getAll 的其余条目保持优先级与注册顺序。
// ════════════════════════════════════════════════════════════

interface Case {
  label: string;
  /** 按注册顺序：[contextId, priority] */
  entries: Array<[string, number]>;
  preference?: string;
  winner: string | undefined;
  order: string[];
}

const CASES: Case[] = [
  {
    label: '偏好胜过 priority',
    entries: [
      ['a', 0],
      ['b', 10],
      ['c', 5],
    ],
    preference: 'a',
    winner: 'a',
    order: ['a', 'b', 'c'],
  },
  {
    label: '偏好指向不在场的提供者：回落 priority',
    entries: [
      ['a', 0],
      ['b', 10],
    ],
    preference: 'ghost',
    winner: 'b',
    order: ['b', 'a'],
  },
  {
    label: '同 priority：先注册者胜（稳定排序）',
    entries: [
      ['first', 3],
      ['second', 3],
      ['third', 3],
    ],
    winner: 'first',
    order: ['first', 'second', 'third'],
  },
];

describe('ServiceContainer 的胜者解析', () => {
  it.each(CASES)('$label', ({ entries, preference, winner, order }) => {
    const sc = new ServiceContainer();
    const owners = new Map<string, symbol>();
    for (const [contextId, priority] of entries) {
      owners.set(contextId, Symbol(contextId));
      sc.register('svc', { tag: contextId }, contextId, owners.get(contextId)!, { priority });
    }
    if (preference) sc.prefer('svc', preference);
    expect(sc.get<{ tag: string }>('svc')?.tag).toBe(winner);
    expect(sc.ownerOf('svc')).toBe(winner === undefined ? undefined : owners.get(winner));
    expect(sc.getAll('svc').map(view => view.contextId)).toEqual(order);
  });
});
