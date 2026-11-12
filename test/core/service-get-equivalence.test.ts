import { describe, expect, it } from 'vitest';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

// ════════════════════════════════════════════════════════════
// 胜者解析的规格表：偏好 > 优先级 > 位次。
// get、ownerOf 与 getAll 的首项是同一个胜者；getAll 的其余条目保持优先级与位次。
// ════════════════════════════════════════════════════════════

interface Case {
  label: string;
  /** 按注册顺序：[contextId, priority, 位次]；不给位次即宿主的根（空串） */
  entries: Array<[string, number, string?]>;
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
    label: '同 priority、同一登记方：先登记者胜（稳定排序）',
    // 条目 id 的字母序与登记先后相反：排的不是条目 id
    entries: [
      ['z-first', 3],
      ['m-second', 3],
      ['a-third', 3],
    ],
    winner: 'z-first',
    order: ['z-first', 'm-second', 'a-third'],
  },
  {
    label: '同 priority、不同登记方：按位次排，宿主的根（空串）最前，不看谁先登记',
    entries: [
      ['z', 3, 'z'],
      ['host', 3, ''],
      ['a1', 3, 'a'],
      ['a2', 3, 'a'],
    ],
    winner: 'host',
    order: ['host', 'a1', 'a2', 'z'],
  },
  {
    label: '位次按码元序比，不看语言环境：大写排在小写前面',
    entries: [
      ['lower', 0, 'a'],
      ['upper', 0, 'B'],
    ],
    winner: 'upper',
    order: ['upper', 'lower'],
  },
  {
    label: 'priority 先于位次',
    entries: [
      ['front', 0, 'a'],
      ['high', 1, 'z'],
    ],
    winner: 'high',
    order: ['high', 'front'],
  },
];

describe('ServiceContainer 的胜者解析', () => {
  it.each(CASES)('$label', ({ entries, preference, winner, order }) => {
    const sc = new ServiceContainer();
    const owners = new Map<string, symbol>();
    for (const [contextId, priority, seat] of entries) {
      owners.set(contextId, Symbol(contextId));
      sc.register('svc', { tag: contextId }, contextId, owners.get(contextId)!, { priority, seat });
    }
    if (preference) sc.prefer('svc', preference);
    expect(sc.get<{ tag: string }>('svc')?.tag).toBe(winner);
    expect(sc.ownerOf('svc')).toBe(winner === undefined ? undefined : owners.get(winner));
    expect(sc.getAll('svc').map(view => view.contextId)).toEqual(order);
  });
});
