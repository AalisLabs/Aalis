import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerHttpTools } from '../../packages/plugin-tool-system/src/tools/http.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// http_request 按内容判正文是不是文本：服务端声明的 Content-Type 是标签，声明类型不常见的文本（如 application/vnd.api+json）
// 照样给出正文，声明成文本的二进制与按编码解不开的文本不硬解出乱码；编码按服务端声明的 charset，没声明或认不出的按 UTF-8。请求正文分两个参数：body 是字符串、原样发出、不补请求头，json 按 JSON 发出、
// 没写 Content-Type（任何大小写）时补 application/json。按 Content-Length 判超限后取消响应体，不占着连接。
// ════════════════════════════════════════════════════════════

const net = vi.hoisted(() => ({
  respond: (): Response => new Response(''),
  requests: [] as Array<{ url: string; init: RequestInit }>,
}));
vi.mock(import('../../packages/util-network-guard/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeFetch: async (url: string, init: RequestInit = {}) => {
    net.requests.push({ url, init });
    return net.respond();
  },
}));

const MAX = 4096;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

describe('http_request：正文按内容判、请求正文的两个参数', () => {
  const handlers: Record<string, Omit<RegisteredTool, 'pluginName'>['handler']> = {};
  registerHttpTools(
    stubBoundTools({
      onRegister: t => {
        handlers[t.definition.function.name] = t.handler;
      },
    }),
    { defaultTimeout: 30000, maxResponseSize: MAX, storage: { writeFile: async () => undefined } as never },
  );
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse((await handlers[name](args, toolContext({ sessionId: 's' }))) as string);

  beforeEach(() => {
    net.requests.length = 0;
  });

  it('声明类型不常见的文本照样给出正文', async () => {
    net.respond = () => new Response('{"a":1}', { headers: { 'content-type': 'application/vnd.api+json' } });
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain('{"a":1}');
    expect(out.body).not.toContain('不是 UTF-8 文本');
  });

  it('没有 Content-Type 的文本照样给出正文', async () => {
    net.respond = () => new Response(new TextEncoder().encode('plain'));
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain('plain');
  });

  it('声明成 text/plain 的 PNG 字节：只给元信息，不硬解', async () => {
    net.respond = () => new Response(PNG, { headers: { 'content-type': 'text/plain' } });
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain(`[不是 UTF-8 文本, ${PNG.length} 字节, Content-Type: text/plain]`);
  });

  it('声明 charset=gbk 的 GBK 正文：按声明的编码解出正文', async () => {
    // 「中文」的 GBK 编码
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    net.respond = () => new Response(gbk, { headers: { 'content-type': 'text/html; charset=gbk' } });
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain('中文');
  });

  it('按声明的编码解不开：如实说不是这种编码的文本，不硬解', async () => {
    // GBK 的首字节后面缺了第二个字节
    net.respond = () =>
      new Response(new Uint8Array([0x61, 0xd6]), { headers: { 'content-type': 'text/plain; charset="GBK"' } });
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain('[不是 GBK 文本, 2 字节, Content-Type: text/plain; charset="GBK"]');
  });

  it('声明成单字节编码的 PNG 字节：单字节编码什么都解得开，含 NUL 的照样只给元信息', async () => {
    net.respond = () => new Response(PNG, { headers: { 'content-type': 'text/plain; charset=iso-8859-1' } });
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain(
      `[不是 iso-8859-1 文本, ${PNG.length} 字节, Content-Type: text/plain; charset=iso-8859-1]`,
    );
  });

  it('声明的 charset 认不出：按 UTF-8 解', async () => {
    net.respond = () =>
      new Response(new TextEncoder().encode('正文'), {
        headers: { 'content-type': 'text/plain; charset=zz-placeholder' },
      });
    const out = await call('http_request', { url: 'https://example.invalid/a' });
    expect(out.body).toContain('正文');
  });

  it.each([
    ['http_request', { url: 'https://example.invalid/big' }],
    ['http_download', { url: 'https://example.invalid/big', savePath: 'workspace:/big.bin' }],
  ])('%s：Content-Length 超过上限时取消响应体', async (name, args) => {
    let cancelled = false;
    net.respond = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-length': String(MAX * 2) } },
      );
    const out = await call(name, args);
    expect(out.error).toContain('过大');
    expect(cancelled).toBe(true);
  });

  it('http_download：上游回错误状态时取消响应体', async () => {
    let cancelled = false;
    net.respond = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 404 },
      );
    const out = await call('http_download', { url: 'https://example.invalid/gone', savePath: 'workspace:/gone.bin' });
    expect(out.error).toContain('HTTP 404');
    expect(cancelled).toBe(true);
  });

  it('body 是字符串：原样发出，不补 Content-Type', async () => {
    net.respond = () => new Response('ok');
    await call('http_request', { url: 'https://example.invalid/a', method: 'POST', body: 'a=1&b=2' });
    const { init } = net.requests[0];
    expect(init.body).toBe('a=1&b=2');
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('json 按 JSON 发出，补 application/json', async () => {
    net.respond = () => new Response('ok');
    await call('http_request', { url: 'https://example.invalid/a', method: 'POST', json: { a: 1 } });
    const { init } = net.requests[0];
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('请求头里写了任何大小写的 Content-Type：照原值，只有一份', async () => {
    net.respond = () => new Response('ok');
    await call('http_request', {
      url: 'https://example.invalid/a',
      method: 'POST',
      headers: { 'CONTENT-TYPE': 'application/x-www-form-urlencoded' },
      json: { a: 1 },
    });
    const { init } = net.requests[0];
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it.each([
    ['字符串', '{"a":1}'],
    ['数组', [1, 2]],
    ['null', null],
  ])('json 给的是%s：报错，指向 body，不发请求', async (_label, json) => {
    const out = await call('http_request', { url: 'https://example.invalid/a', method: 'POST', json });
    expect(out.error).toBe('json 要是对象；字符串正文用 body');
    expect(net.requests).toHaveLength(0);
  });

  it('body 与 json 都给：报错，不发请求', async () => {
    const out = await call('http_request', {
      url: 'https://example.invalid/a',
      method: 'POST',
      body: 'x',
      json: { a: 1 },
    });
    expect(out.error).toContain('body 与 json');
    expect(net.requests).toHaveLength(0);
  });
});
