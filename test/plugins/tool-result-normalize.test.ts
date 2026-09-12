import { describe, expect, it } from 'vitest';
import { asToolExecutionResult } from '../../packages/api-tools/src/index.js';

// execute() 0.8.0 起返回对象，旧实现返回字符串；调用方经它归一，配旧 plugin-tools 不会把 .content 读成 undefined。
describe('asToolExecutionResult', () => {
  it('字符串 → { content }', () => {
    expect(asToolExecutionResult('plain')).toEqual({ content: 'plain' });
  });
  it('对象原样返回（含 images）', () => {
    const r = { content: 'c', images: ['data:image/png;base64,AA=='] };
    expect(asToolExecutionResult(r)).toBe(r);
  });
});
