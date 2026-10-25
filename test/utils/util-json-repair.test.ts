import { describe, expect, it } from 'vitest';
import {
  extractJsonCandidate,
  parseLLMJsonObject,
  tryParseJsonObject,
} from '../../packages/util-json-repair/src/index.js';

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

  it('外层对象配不平但含配平内层 — 返回外层整段而非内层，不把内层当成整个结果', () => {
    // 外层 {"a",...,"c"} 未闭合，嵌套的 {"b":1} 是配平的：取了内层就静默丢掉 "a"/"c"
    const raw = '{"a":{"b":1},"c":"trunc';
    const result = extractJsonCandidate(raw);
    expect(result).toBe(raw);
    expect(result).not.toBe('{"b":1}');
    expect(result).toContain('"a"');
    expect(result).toContain('"c"');
  });

  it('推理文本 + 配不平的 JSON payload — 返回 payload 整段', () => {
    const raw = '思考中...\n{"result":{"nested":true},"status":"incompl';
    const result = extractJsonCandidate(raw);
    expect(result).toBe('{"result":{"nested":true},"status":"incompl');
  });

  it('先一个配平对象再一个截断对象 — 返回配平的那个', () => {
    const raw = '{"done":1} 追加 {"more":"trunc';
    expect(extractJsonCandidate(raw)).toBe('{"done":1}');
  });

  it('字符串里只有一个裸引号、配平失败 — 从第一个 { 起整段交给裸引号转义', () => {
    expect(parseLLMJsonObject('说明：{"m":"他说"好"}').parsed).toEqual({ m: '他说"好' });
  });
});

describe('tryParseJsonObject —— 不补被截断的结尾', () => {
  it('少了结尾括号的对象解析失败，不补成完整对象：截断由模型插件报的结束原因认', () => {
    expect(tryParseJsonObject('{"a":[{"b":1').parsed).toBeNull();
  });

  it('已完整 JSON 不被改动', () => {
    const { parsed, repairsApplied } = tryParseJsonObject('{"ok":true,"list":[1,2]}');
    expect(parsed).toEqual({ ok: true, list: [1, 2] });
    expect(repairsApplied).toEqual([]);
  });
});

describe('tryParseJsonObject —— 字符串内部裸引号转义', () => {
  it('字符串里的 XML 标签带属性引号：裸引号转义一步就够', () => {
    const { parsed, repairsApplied } = tryParseJsonObject('{"mood":"开心","message":"好的<face id="14"/>"}');
    expect(parsed?.message).toBe('好的<face id="14"/>');
    expect(repairsApplied).toEqual(['字符串内部裸引号转义']);
  });
});

describe('tryParseJsonObject —— 尾逗号只在字符串外删除', () => {
  it('对象/数组的真尾逗号照常删除', () => {
    expect(tryParseJsonObject('{"list":[1,2,],\n}').parsed).toEqual({ list: [1, 2] });
  });

  it('字符串正文里的 ",]" / ",}" 原样保留（无状态全局 replace 会静默改写模型输出）', () => {
    const { parsed, repairsApplied } = tryParseJsonObject('{"msg":"列表是 [a,] 对象是 {b,}","n":1,}');
    expect(repairsApplied).toContain('移除尾部多余逗号');
    expect(parsed).toEqual({ msg: '列表是 [a,] 对象是 {b,}', n: 1 });
  });

  it('字符串里的转义引号不会让状态机错判（后半段的尾逗号仍被删）', () => {
    const { parsed } = tryParseJsonObject('{"msg":"他说 \\"好,]\\" 就走了","n":[1,]}');
    expect(parsed).toEqual({ msg: '他说 "好,]" 就走了', n: [1] });
  });
});
