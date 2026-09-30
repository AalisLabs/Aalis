import { expect, it } from 'vitest';
import { sanitizeRunLog } from '../../packages/api-remote-agent/src/index.js';

it('完整保留普通参数与多行输出，凭据键、环境变量和签名 URL 脱敏', () => {
  const source = {
    input: { path: '/agent/game/index.html', GITHUB_TOKEN: 'PRIVATE_ENV', OPENAI_API_KEY: 'PRIVATE_KEY' },
    output: {
      stdout: 'line1\nline2',
      command: 'export GITHUB_TOKEN=PRIVATE_SHELL\nnode test.js',
      config: '{"api_key":"PRIVATE_JSON"}',
      url: 'https://user:PRIVATE_PASS@site.test/out?signature=PRIVATE_SIGN',
    },
  };
  const clean = sanitizeRunLog(source);
  const text = JSON.stringify(clean);
  for (const secret of ['PRIVATE_ENV', 'PRIVATE_KEY', 'PRIVATE_SHELL', 'PRIVATE_JSON', 'PRIVATE_PASS', 'PRIVATE_SIGN'])
    expect(text).not.toContain(secret);
  expect(clean).toMatchObject({ input: { path: '/agent/game/index.html' }, output: { stdout: 'line1\nline2' } });
  expect(source.input.GITHUB_TOKEN).toBe('PRIVATE_ENV');
});

it('特殊对象键不会污染原型；循环只作显式标记', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"nested":{"token":"secret"}}');
  expect(JSON.stringify(sanitizeRunLog(input))).toContain('__proto__');
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  expect(sanitizeRunLog(loop)).toEqual({ self: '<循环引用已省略>' });
});
