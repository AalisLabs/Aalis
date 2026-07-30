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
