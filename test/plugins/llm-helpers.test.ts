import { describe, expect, it } from 'vitest';
import { formatModelRef, parseModelRef } from '../../packages/plugin-llm-api/src/index.js';

describe('parseModelRef', () => {
  it('空值返回空对象', () => {
    expect(parseModelRef('')).toEqual({});
    expect(parseModelRef(null)).toEqual({});
    expect(parseModelRef(undefined)).toEqual({});
  });

  it('无 :: 仅作 model', () => {
    expect(parseModelRef('gpt-4o')).toEqual({ model: 'gpt-4o' });
  });

  it('完整 provider::model', () => {
    expect(parseModelRef('@aalis/plugin-openai::gpt-4o')).toEqual({
      provider: '@aalis/plugin-openai',
      model: 'gpt-4o',
    });
  });

  it('model 内含 : 不被误拆分（ollama 风格）', () => {
    expect(parseModelRef('@aalis/plugin-ollama::qwen2.5:7b')).toEqual({
      provider: '@aalis/plugin-ollama',
      model: 'qwen2.5:7b',
    });
  });

  it('provider 为空但有 ::', () => {
    expect(parseModelRef('::gpt-4o')).toEqual({ model: 'gpt-4o', provider: undefined });
  });

  it('model 为空但有 ::', () => {
    expect(parseModelRef('@aalis/plugin-openai::')).toEqual({
      provider: '@aalis/plugin-openai',
      model: undefined,
    });
  });
});

describe('formatModelRef', () => {
  it('双方都有 → 拼接', () => {
    expect(formatModelRef({ provider: '@aalis/plugin-openai', model: 'gpt-4o' })).toBe('@aalis/plugin-openai::gpt-4o');
  });

  it('仅 model → 直接输出 model', () => {
    expect(formatModelRef({ model: 'gpt-4o' })).toBe('gpt-4o');
  });

  it('仅 provider → 输出 provider', () => {
    expect(formatModelRef({ provider: '@aalis/plugin-openai' })).toBe('@aalis/plugin-openai');
  });

  it('双方都空 → 空字符串', () => {
    expect(formatModelRef({})).toBe('');
  });

  it('round-trip：含冒号 model', () => {
    const ref = { provider: '@aalis/plugin-ollama', model: 'qwen2.5:7b' };
    expect(parseModelRef(formatModelRef(ref))).toEqual(ref);
  });
});
