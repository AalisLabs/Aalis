import { describe, expect, it } from 'vitest';
import { readBodyCapped } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';

// ════════════════════════════════════════════════════════════
// 入站附件下载流式限额：无 Content-Length 时也不会全量缓冲撑爆内存。
// ════════════════════════════════════════════════════════════

function fakeRes(chunks: Uint8Array[], contentLength?: number): Response {
  let i = 0;
  return {
    ok: true,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null,
    },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

describe('readBodyCapped 流式限额', () => {
  it('流式累计超 maxBytes → 早退返回 null（不全量缓冲）', async () => {
    expect(await readBodyCapped(fakeRes([new Uint8Array(600), new Uint8Array(600)]), 1000)).toBeNull();
  });

  it('Content-Length 头即超限 → 立即拒，不拉取', async () => {
    expect(await readBodyCapped(fakeRes([], 99999), 1000)).toBeNull();
  });

  it('在 maxBytes 内 → 返回完整 buffer', async () => {
    const buf = await readBodyCapped(fakeRes([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]), 1000);
    expect(buf?.length).toBe(5);
  });
});
