import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { readBodyCapped } from '../../packages/plugin-llm-ollama/src/index.js';

// ════════════════════════════════════════════════════════════
// 远程图片/音频下载体积上限——流式限额读取。
//
// 背景（审计存量项）：附件缓存失败回退原 URL 时，provider 侧此前用
// res.arrayBuffer() 全量缓冲、无任何体积上限——超大/恶意资源可撑爆内存。
// 契约：Content-Length 超限即拒（零读取）；无头时流式累计超限即断；正常资源原样返回。
// ════════════════════════════════════════════════════════════

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

describe('readBodyCapped（下载体积上限）', () => {
  it('Content-Length 超限：直接拒收，不读响应体', async () => {
    const res = new Response(streamOf([new Uint8Array(10)]), {
      headers: { 'content-length': String(1024 * 1024) },
    });
    expect(await readBodyCapped(res, 1000)).toBeNull();
  });

  it('无 Content-Length 流式累计超限：中途断开返回 null', async () => {
    const res = new Response(streamOf([new Uint8Array(600), new Uint8Array(600)]));
    expect(await readBodyCapped(res, 1000)).toBeNull();
  });

  it('未超限：完整返回内容', async () => {
    const payload = Buffer.from('hello-image-bytes');
    const res = new Response(streamOf([new Uint8Array(payload)]));
    const buf = await readBodyCapped(res, 1000);
    expect(buf?.toString()).toBe('hello-image-bytes');
  });
});
