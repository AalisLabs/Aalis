import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerHttpTools } from '../../packages/plugin-tool-system/src/tools/http.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// http_download 声明可转后台，只认执行器给这次调用的中止信号，不另设超时：本地测试服务器先回响应头与一段正文、
// 之后一直不结束，中止时下载停住、不写盘。安全取数换成普通 fetch，只为连本机的测试服务器。
// ════════════════════════════════════════════════════════════

vi.mock(import('../../packages/util-network-guard/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

let server: Server;
let base: string;
const hanging: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((_req, res) => {
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
    { defaultTimeout: 30_000, maxResponseSize: 1_048_576, storage: { writeFile } as never },
  );
  return { download: registered.http_download, writeFile };
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
      { sessionId: 's', signal: ac.signal },
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
