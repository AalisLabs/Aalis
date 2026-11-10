import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerHttpTools } from '../../packages/plugin-tool-system/src/tools/http.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { fixedRef } from '../fixtures/service-ref.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// http_download 声明可转后台，只认执行器给这次调用的中止信号，不另设超时：本地测试服务器先回响应头与一段正文、
// 之后一直不结束，中止时下载停住、不写盘。http_request 另有超时，同样接这次调用的中止信号，谁先到按谁停。
// 安全取数换成普通 fetch，只为连本机的测试服务器。
// ════════════════════════════════════════════════════════════

vi.mock(import('../../packages/util-network-guard/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

let server: Server;
let base: string;
const hanging: ServerResponse[] = [];
/** 收到与断开了的请求路径 */
const requested: string[] = [];
const closed: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    req.on('close', () => closed.push(req.url ?? ''));
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('zz-first-chunk');
    hanging.push(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of hanging) res.destroy();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function register() {
  const registered: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  const writeFile = vi.fn(async () => undefined);
  registerHttpTools(
    stubBoundTools({
      onRegister: t => {
        registered[t.definition.function.name] = t;
      },
    }),
    { defaultTimeout: 30_000, maxResponseSize: 1_048_576, storage: fixedRef({ writeFile } as never) },
  );
  return { download: registered.http_download, request: registered.http_request, writeFile };
}

describe('http_download 可转后台', () => {
  it('声明可转后台（让出时限用执行器的默认），参数没有 timeout', () => {
    const { download } = register();
    expect(download.background).toEqual({});
    expect(Object.keys(download.definition.function.parameters.properties)).toEqual(['url', 'savePath']);
  });

  it('下载中中止：3 秒内停住、回下载失败，不写盘', async () => {
    const { download, writeFile } = register();
    const ac = new AbortController();
    const pending = download.handler(
      { url: `${base}/zz-slow.bin`, savePath: 'workspace:/zz-slow.bin' },
      toolContext({ sessionId: 's', signal: ac.signal }),
    );
    await vi.waitFor(() => expect(hanging.length).toBeGreaterThan(0));
    ac.abort();
    const out = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('3 秒内没有停住')), 3000)),
    ]);
    expect(JSON.parse(String(out)).error).toContain('下载失败');
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('http_request 随调用中止', () => {
  it('读响应体途中中止：到服务器的请求随之断开，调用随即回错，不等满超时', async () => {
    const { request } = register();
    const ac = new AbortController();
    const pending = request.handler(
      { url: `${base}/zz-request.txt`, timeout: 60_000 },
      toolContext({ sessionId: 's', signal: ac.signal }),
    );
    await vi.waitFor(() => expect(requested).toContain('/zz-request.txt'));
    ac.abort();
    await vi.waitFor(() => expect(closed).toContain('/zz-request.txt'));
    expect(JSON.parse(String(await pending)).error).toContain('请求失败');
  });
});
