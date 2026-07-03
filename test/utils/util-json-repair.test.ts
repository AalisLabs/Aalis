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

  it('外层对象被截断但含配平内层 — 返回截断的外层（供修复）而非内层，避免丢弃外层字段', () => {
    // 模型输出触达 token 上限，外层 {"a",...,"c"} 未闭合，但嵌套的 {"b":1} 是配平的。
    // 旧行为会 descend 进内层、返回 {"b":1}，静默丢弃 "a"/"c"。修复后应返回截断的外层整段。
    const raw = '{"a":{"b":1},"c":"trunc';
    const result = extractJsonCandidate(raw);
    expect(result).toBe(raw);
    expect(result).not.toBe('{"b":1}');
    expect(result).toContain('"a"');
    expect(result).toContain('"c"');
  });

  it('推理文本 + 被截断的 JSON payload — 返回截断 payload 整段供修复', () => {
    const raw = '思考中...\n{"result":{"nested":true},"status":"incompl';
    const result = extractJsonCandidate(raw);
    expect(result).toBe('{"result":{"nested":true},"status":"incompl');
  });

  it('先一个配平对象再一个截断对象 — 返回配平的那个', () => {
    const raw = '{"done":1} 追加 {"more":"trunc';
    expect(extractJsonCandidate(raw)).toBe('{"done":1}');
  });
});
