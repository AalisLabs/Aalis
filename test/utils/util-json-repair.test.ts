import { describe, expect, it } from 'vitest';
import { extractJsonCandidate } from '../../packages/util-json-repair/src/index.js';

describe('extractJsonCandidate', () => {
  it('直接 JSON 对象，无前缀文本', () => {
    const raw = '{"mood":"开心","message":"你好"}';
    expect(extractJsonCandidate(raw)).toBe(raw);
  });

  it('去掉 markdown 代码块围栏', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(extractJsonCandidate(raw)).toBe('{"a":1}');
  });

  it('前置自由文本 + JSON — 应返回 JSON 部分', () => {
    const raw = '好的，这是结果：{"mood":"冷静","message":"明白了"}';
    expect(extractJsonCandidate(raw)).toBe('{"mood":"冷静","message":"明白了"}');
  });

  it('文本中含数学集合符号 {2,4,6,7,8} + 末尾真正 JSON — 应返回 JSON 而非集合', () => {
    const raw =
      '补集是{2,4,6,7,8}共5个元素，选C\n' + '{"mood":"认真","state":"做题","desire":70,"message":"前五题搞定了"}';
    const result = extractJsonCandidate(raw);
    expect(result).toContain('"mood"');
    expect(result).toBe('{"mood":"认真","state":"做题","desire":70,"message":"前五题搞定了"}');
  });

  it('多个 JSON 对象 — 取最后一个含 : 的对象', () => {
    const raw = '{"a":1} 然后 {"b":2,"c":3}';
    expect(extractJsonCandidate(raw)).toBe('{"b":2,"c":3}');
  });

  it('仅含无 : 的花括号（如 set 字面量），回退行为：返回该片段', () => {
    const raw = '{A,B,C}';
    // 没有含 ':' 的候选，回退到第一个 '{'
    expect(extractJsonCandidate(raw)).toBe('{A,B,C}');
  });

  it('含 </think> 泄漏标签后跟 JSON', () => {
    const raw = '<think>reasoning...</think>\n{"mood":"平静","message":"好"}';
    expect(extractJsonCandidate(raw)).toBe('{"mood":"平静","message":"好"}');
  });

  it('空字符串', () => {
    expect(extractJsonCandidate('')).toBe('');
  });

  it('无花括号的纯文本', () => {
    const raw = 'hello world';
    expect(extractJsonCandidate(raw)).toBe('hello world');
  });

  it('含嵌套对象的大 JSON — 应返回完整外层对象而非内层片段', () => {
    const raw = '{"persons":[{"platform":"onebot","userId":"a"},{"platform":"onebot","userId":"b"}],"events":[]}';
    expect(extractJsonCandidate(raw)).toBe(raw);
  });

  it('前缀集合符号 + 含嵌套 JSON — 返回完整外层 JSON', () => {
    const raw = '集合 {1,2,3} 之后是 {"mood":"happy","nested":{"key":"val"},"message":"ok"}';
    const result = extractJsonCandidate(raw);
    expect(result).toBe('{"mood":"happy","nested":{"key":"val"},"message":"ok"}');
  });
});
