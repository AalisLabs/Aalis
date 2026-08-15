import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 插件状态机写入点定格：entry.state / entry.context 的赋值是并发协调的
// 承重面（先写终态、CAS 接管、context 闸全部以它们为判据），写入点每多
// 一处就多一个可能漏抄约定的竞态源——刀 0 的 Phase A 回归即实证。
//
// 拆卸一律走 retireEntry（plugin-activation.ts），不许手写四步；激活收尾
// 与 enablePlugin/bouncePlugin 是点名的例外。新增写入点必须：
//   1. 过刀单（core 修改逐条拍板）；
//   2. 对照 retireEntry JSDoc 的顺序约定自查；
//   3. 更新本测试的定格数——这份"麻烦"是刻意的。
// ════════════════════════════════════════════════════════════

const SRC = join(__dirname, '../../packages/core/src');

/** 赋值写入点（排除 ==/=== 比较）。 */
const WRITE_RE = /\b(?:entry|other)\.(state|context)\s*=(?!=)/g;

/** 文件 → { state 写入点数, context 写入点数 } 的定格。 */
const FROZEN: Record<string, { state: number; context: number }> = {
  'plugin-activation.ts': { state: 3, context: 2 }, // retireEntry ×2 + activating/context/active
  'plugin.ts': { state: 2, context: 1 }, // enablePlugin + bouncePlugin（点名内联例外）
  'plugin-topology.ts': { state: 0, context: 0 }, // evict 已全走 retireEntry
};

describe('插件状态机写入点定格', () => {
  for (const [file, expected] of Object.entries(FROZEN)) {
    it(`${file}：state=${expected.state} / context=${expected.context}`, () => {
      const content = readFileSync(join(SRC, file), 'utf-8');
      const counts = { state: 0, context: 0 };
      for (const m of content.matchAll(WRITE_RE)) {
        counts[m[1] as 'state' | 'context']++;
      }
      expect(
        counts,
        `${file} 的 entry.state/entry.context 写入点数变了。若是新增拆卸路径：改用 retireEntry，` +
          `别手写「写终态→拆→清→发事件」四步（顺序约定见其 JSDoc）；确属必要的新写入点，过刀单后更新本定格。`,
      ).toEqual(expected);
    });
  }
});
