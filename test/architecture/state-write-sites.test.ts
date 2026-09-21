import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 插件状态机写入点定格：entry.state / entry.activation 的赋值是并发协调的
// 承重面（先写终态、CAS 接管、activation 闸全部以它们为判据），写入点每多
// 一处就多一个可能漏抄约定的竞态源。
//
// 拆卸一律走 retireEntry / retireBatch（plugin-activation.ts），不许手写四步。
// plugin.ts 对 entry.activation 零直接写入——清引用只走 retireEntry。
// enable 把 disabled/error 拉回 pending 是点名的例外。新增写入点必须：
//   1. 过刀单（core 修改逐条拍板）；
//   2. 对照 retireEntry JSDoc 的顺序约定自查；
//   3. 更新本测试的定格数——这份"麻烦"是刻意的。
// ════════════════════════════════════════════════════════════

const SRC = join(__dirname, '../../packages/core/src');

/** 赋值写入点（排除 ==/=== 比较）。 */
const WRITE_RE = /\b(?:entry|other)\.(state|activation)\s*=(?!=)/g;

/** 文件 → { state 写入点数, activation 写入点数 } 的定格。 */
const FROZEN: Record<string, { state: number; activation: number }> = {
  // retireEntry / retireBatch 各写一次终态、清一次激活引用；
  // activatePlugin 写 activating / active 两个状态，挂一次激活。
  'orchestration/plugin-activation.ts': { state: 4, activation: 3 },
  // enable：把 disabled/error 拉回 pending，随后交给 recompute 激活
  'orchestration/plugin.ts': { state: 1, activation: 0 },
  'orchestration/plugin-topology.ts': { state: 0, activation: 0 },
};

function countWrites(content: string): { state: number; activation: number } {
  const counts = { state: 0, activation: 0 };
  for (const match of content.matchAll(WRITE_RE)) counts[match[1] as 'state' | 'activation']++;
  return counts;
}

describe('插件状态机写入点定格', () => {
  for (const [file, expected] of Object.entries(FROZEN)) {
    it(`${file}：state=${expected.state} / activation=${expected.activation}`, () => {
      const content = readFileSync(join(SRC, file), 'utf-8');
      const counts = countWrites(content);
      expect(
        counts,
        `${file} 的 entry.state/entry.activation 写入点数变了。若是新增拆卸路径：改用 retireEntry，` +
          `别手写「写终态→拆→清→发事件」四步（顺序约定见其 JSDoc）；确属必要的新写入点，过刀单后更新本定格。`,
      ).toEqual(expected);
    });
  }

  it('orchestration/plugin.ts 对 entry.activation 零直接写入', () => {
    const content = readFileSync(join(SRC, 'orchestration/plugin.ts'), 'utf-8');
    const writes = [...content.matchAll(/\b(?:entry|other)\.activation\s*=(?!=)/g)];
    expect(writes, '拆卸清引用只走 retireEntry，plugin.ts 不得直接写 entry.activation').toHaveLength(0);
  });

  it('FROZEN 名单外的 core 源文件零写入点（防拆卸逻辑挪进新模块逃出定格）', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!/\.ts$/.test(name) || name.endsWith('.d.ts') || name.replace(/\\/g, '/') in FROZEN) continue;
      const content = readFileSync(join(SRC, name), 'utf-8');
      if (WRITE_RE.test(content)) offenders.push(name);
      WRITE_RE.lastIndex = 0;
    }
    expect(offenders, '新文件里出现 entry.state/entry.activation 写入点——纳入 FROZEN 并过刀单').toEqual([]);
  });

  it('负对照：读取、宽松比较与严格比较均不算写入', () => {
    expect(
      countWrites(`
      const current = entry.activation;
      if (entry.state === 'active' || other.state == 'pending') return;
      if (entry.activation === current || other.activation == null) return;
    `),
    ).toEqual({ state: 0, activation: 0 });
  });

  it('正对照：额外状态写入或激活引用写入会改变定格', () => {
    const file = 'orchestration/plugin-activation.ts';
    const original = readFileSync(join(SRC, file), 'utf8');
    expect(countWrites(`${original}\nentry.state = 'pending';`)).toEqual({ state: 5, activation: 3 });
    expect(countWrites(`${original}\nother.activation = undefined;`)).toEqual({ state: 4, activation: 4 });
    expect(countWrites(`${original}\nentry.activation = undefined;`)).not.toEqual(FROZEN[file]);
  });
});
