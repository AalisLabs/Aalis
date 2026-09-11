import { describe, expect, it } from 'vitest';
import { prepareLLMMessages } from '../../packages/schema-message/src/index.js';

// 高代理 = "😀".charAt(0)（U+D83D）。截断切坏 emoji 会留下它，经 JSON.stringify → \ud83d →
// DeepSeek 严格解析器报 "unexpected end of hex escape" → 整条请求 400。
const HI = '😀'[0];

describe('prepareLLMMessages 边界守卫：发 LLM 前规整 UTF-16', () => {
  it('content 里的孤代理被替换为 U+FFFD（杜绝 DeepSeek 400）', () => {
    const out = prepareLLMMessages([{ role: 'user', content: `杭州${HI}天气` }]);
    expect(out[0].content).toBe('杭州�天气');
  });

  it('良构 content（含完整 emoji）原样透传', () => {
    const out = prepareLLMMessages([{ role: 'user', content: '正常😀内容' }]);
    expect(out[0].content).toBe('正常😀内容');
  });

  it('null content 不报错', () => {
    const out = prepareLLMMessages([{ role: 'assistant', content: null }]);
    expect(out[0].content).toBe(null);
  });
});

describe('prepareLLMMessages：工具结果携图的协议编码', () => {
  const IMG = 'data:image/png;base64,iVBORw0KGgo=';

  it('带 images 的 tool 消息拆成「tool 文本 + 注明来源的 user 图片消息」，原 tool 消息去 images', () => {
    const out = prepareLLMMessages([
      { role: 'assistant', content: null, toolCallId: undefined },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call-7', images: [IMG] },
      { role: 'user', content: '然后呢' },
    ]);
    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'user', 'user']);
    expect(out[1]).toEqual({ role: 'tool', content: '{"ok":true}', toolCallId: 'call-7' });
    expect(out[2].images).toEqual([IMG]);
    expect(out[2].content).toContain('call-7');
    expect(out[3].content).toBe('然后呢');
  });

  it('并行工具调用：载体延后到该段 tool 应答全部结束之后，不打断 assistant(tool_calls)→tool* 的连续性', () => {
    // 对抗审计（2026-09）blocker：就地插在带图 tool 之后，会让 assistant(tool_calls:[a,b]) 的应答序列
    // 变成 tool(a) → user → tool(b)，OpenAI 系端点拒收整轮请求。
    const out = prepareLLMMessages([
      { role: 'assistant', content: null },
      { role: 'tool', content: 'A', toolCallId: 'a', images: [IMG] },
      { role: 'tool', content: 'B', toolCallId: 'b' },
      { role: 'tool', content: 'C', toolCallId: 'c', images: [`${IMG}2`] },
      { role: 'assistant', content: '收到' },
    ]);
    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'tool', 'user', 'assistant']);
    expect(out.slice(1, 4).every(m => m.images === undefined)).toBe(true);
    // 同一段的图合并进一条载体，按 tool 顺序、并注明各自的 toolCallId
    expect(out[4].images).toEqual([IMG, `${IMG}2`]);
    expect(out[4].content).toContain('a');
    expect(out[4].content).toContain('c');
  });

  it('幂等：拆过一次的输出再过一遍不变（拆出的 tool 消息已无 images）', () => {
    const once = prepareLLMMessages([{ role: 'tool', content: 'x', toolCallId: 'c', images: [IMG] }]);
    expect(prepareLLMMessages(once)).toEqual(once);
  });

  it('不带 images 的 tool 消息与带 images 的 user 消息都原样（只对 tool+images 编码）', () => {
    const msgs = [
      { role: 'tool', content: 'plain', toolCallId: 'c' },
      { role: 'user', content: '看图', images: [IMG] },
    ];
    expect(prepareLLMMessages(msgs)).toEqual(msgs);
    // 空数组视同无图
    expect(prepareLLMMessages([{ role: 'tool', content: 'p', toolCallId: 'c', images: [] }])).toHaveLength(1);
  });
});
