import { describe, expect, it } from 'vitest';
import { buildEnvelope, type ExpandedForward } from '../../packages/plugin-adapter-onebot/src/forward.js';

// ════════════════════════════════════════════════════════════
// 摘要不可用时，合并转发的信封退化为截断的原文。信封随消息归档、进 agent 上下文与 Laya 的请求，
// 截断必须代理安全：截在 emoji 中间留下的孤代理会让严格的 JSON 解析器或分词器拒收。
// ════════════════════════════════════════════════════════════

const expanded = (fullText: string): ExpandedForward => ({
  id: 'f1',
  count: 1,
  participants: ['甲(10001)'],
  fullText,
  truncatedDepth: false,
  truncatedNodes: false,
});

const SUFFIX = '\n…（已截断，原文保留在缓存中）';

describe('buildEnvelope：摘要不可用时的截断', () => {
  it('截断边界落在 emoji 中间：整字符丢弃，不留孤代理', () => {
    const envelope = buildEnvelope(expanded(`${'a'.repeat(599)}😀之后`), null);
    expect(envelope).not.toMatch(/\p{Cs}/u);
    expect(envelope).toContain(`${'a'.repeat(599)}${SUFFIX}`);
  });

  it('不超过上限原样放入；超过时按上限截断并注明', () => {
    expect(buildEnvelope(expanded('短原文'), null)).toBe(
      '<forward id="f1" count=1 participants="甲(10001)">\n短原文\n</forward>',
    );
    expect(buildEnvelope(expanded('x'.repeat(601)), null)).toContain(`${'x'.repeat(600)}${SUFFIX}\n</forward>`);
  });
});
