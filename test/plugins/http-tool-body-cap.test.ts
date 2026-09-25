import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import { registerHttpTools } from '../../packages/plugin-tool-system/src/tools/http.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// http_request / http_download 流式读取响应体并设上限：服务端不报 Content-Length 时，
// 累计超过 maxResponseSize 即中止并取消流，不把整个响应体缓冲进内存；http_download 不写盘。
// ════════════════════════════════════════════════════════════

const MAX = 4096;
const CHUNK = 1024;

/** 响应体桩：每次 pull 吐 1KB、不带 Content-Length；有限流（16 块后结束），回归时快速失败而不是挂到超时 */
const stream = vi.hoisted(() => ({ pulled: 0, cancelled: false }));
vi.mock(import('../../packages/util-network-guard/src/index.js'), async importOriginal => ({
  ...(await importOriginal()),
  safeFetch: async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          stream.pulled++;
          controller.enqueue(new Uint8Array(CHUNK));
          if (stream.pulled >= 16) controller.close();
        },
        cancel() {
          stream.cancelled = true;
        },
      }),
      { headers: { 'content-type': 'text/plain' } },
    ),
}));

describe('http 工具：响应体流式限额', () => {
  const writeFile = vi.fn(async () => undefined);
  const handlers: Record<string, Omit<RegisteredTool, 'pluginName'>['handler']> = {};
  registerHttpTools(
    stubBoundTools({
      onRegister: t => {
        handlers[t.definition.function.name] = t.handler;
      },
    }),
    { defaultTimeout: 30000, maxResponseSize: MAX, storage: { writeFile } as never },
  );

  beforeEach(() => {
    stream.pulled = 0;
    stream.cancelled = false;
    writeFile.mockClear();
  });

  it.each([
    ['http_request', { url: 'https://example.invalid/big' }],
    ['http_download', { url: 'https://example.invalid/big', savePath: 'workspace:/big.bin' }],
  ])('%s：无 Content-Length 时超限即中止，流被取消，不写盘', async (name, args) => {
    const out = JSON.parse((await handlers[name](args, { sessionId: 's' })) as string);
    expect(out.error).toContain('响应体过大');
    expect(stream.cancelled).toBe(true);
    expect(stream.pulled).toBeLessThanOrEqual(MAX / CHUNK + 2);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
