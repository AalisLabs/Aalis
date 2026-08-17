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

// ── SILK 短路：QQ 语音原生格式 ffmpeg 无解码器，转码前就地跳过，不 spawn 子进程 ──

import { cacheOneAttachment } from '../../packages/plugin-adapter-onebot/src/attachment-cache.js';

describe('cacheOneAttachment SILK 短路', () => {
  it('SILK 音频：不尝试转码（makeTempDir 零调用）、返回 null 保留原 URL', async () => {
    const silk = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.alloc(16)]);
    const source = `data:audio/silk;base64,${silk.toString('base64')}`;
    const storage = { writeFile: async () => {} };
    const proc = {
      makeTempDir: async () => {
        throw new Error('不应触发转码（SILK 应在 ffmpeg 之前短路）');
      },
    };
    const warns: string[] = [];
    const out = await cacheOneAttachment(
      storage as never,
      proc as never,
      'audio',
      source,
      'onebot:t:group:1',
      1024 * 1024,
      { warn: (m: string) => warns.push(m) },
    );
    expect(out).toBeNull();
    expect(warns.some(w => w.includes('SILK'))).toBe(true);
  });
});
