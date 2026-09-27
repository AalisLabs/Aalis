import { describe, expect, it } from 'vitest';
import { type DrawCaps, renderRequest, resolveCanvas } from '../../packages/plugin-draw/src/plan.js';
import { OfflineRenderer } from '../../packages/util-offline-render/src/index.js';

// ════════════════════════════════════════════════════════════
// 真 Chromium 集成锚：draw 的渲染计划经离线渲染库出图（本机已有 puppeteer 缓存的 Chrome）。
// 要实证的事：
//   1) 渲染出真 PNG 且尺寸 = 画布×scale（定界生效）；HTML 按内容量高、受像素上限限高、最低 16；
//   2) 标记里的 <script> 不执行、外联被拦而渲染不挂死（走 draw 的完整请求，不只看库本身）。
// 库层的隔离（宿主文件、零网络、上下文、并发槽、步骤超时）见 test/utils/offline-render-*.test.ts。
// ════════════════════════════════════════════════════════════

const caps: DrawCaps = { defaultWidth: 800, maxWidth: 1600, maxPixels: 4_000_000, maxSourceBytes: 262144, scale: 2 };
const logger = { info: () => {}, warn: () => {}, debug: () => {} };

function pngSize(png: Uint8Array): { width: number; height: number } {
  // PNG IHDR：width/height 位于第 16-24 字节（大端）
  const buf = Buffer.from(png);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function makeRenderer(): OfflineRenderer {
  return new OfflineRenderer({ sandbox: 'preferred', idleShutdownSec: 0, maxConcurrency: 4, logger });
}

describe('draw 渲染（真浏览器）', () => {
  it('SVG 渲染：PNG 尺寸 = 画布×scale，中文/emoji 不豆腐（有输出即可，保真靠人验）', async () => {
    const renderer = makeRenderer();
    try {
      const plan = resolveCanvas(
        '<svg viewBox="0 0 200 100"><rect width="200" height="100" fill="#3b82f6"/>' +
          '<text x="100" y="55" text-anchor="middle" fill="#fff" font-size="20">你好 Aalis</text></svg>',
        200,
        caps,
      );
      expect([plan.width, plan.height]).toEqual([200, 100]);
      const png = await renderer.renderPng(renderRequest(plan, 2, caps.maxPixels));
      expect(pngSize(png)).toEqual({ width: 400, height: 200 });
      expect(png.byteLength).toBeGreaterThan(1000);
    } finally {
      await renderer.dispose();
    }
  }, 30_000);

  it('HTML 渲染：宽定参数、高实测；折行文本高度>单行；超高按像素上限截，空内容最低 16', async () => {
    const renderer = makeRenderer();
    try {
      const plan = resolveCanvas(
        `<div style="font-size:20px;line-height:1.5">${'很长的中文内容'.repeat(30)}</div>`,
        300,
        caps,
      );
      const size = pngSize(await renderer.renderPng(renderRequest(plan, 1, caps.maxPixels)));
      expect(size.width).toBe(300);
      expect(size.height).toBeGreaterThan(60); // 必然折成多行

      const tall = resolveCanvas('<div style="height:5000px;background:#123"></div>', 100, caps);
      expect(pngSize(await renderer.renderPng(renderRequest(tall, 1, 30_000)))).toEqual({ width: 100, height: 300 });

      const empty = resolveCanvas('<div></div>', 100, caps);
      expect(pngSize(await renderer.renderPng(renderRequest(empty, 1, caps.maxPixels)))).toEqual({
        width: 100,
        height: 16,
      });
    } finally {
      await renderer.dispose();
    }
  }, 30_000);

  it('安全：<script> 不执行、外联被拦、渲染不挂死', async () => {
    const renderer = makeRenderer();
    try {
      // 脚本若执行，画布会被撑到 500 高
      const plan = resolveCanvas(
        '<div id="t" style="height:20px">safe</div>' +
          '<script>document.getElementById("t").style.height="500px"</script>' +
          '<img hidden src="http://127.0.0.1:1/never.png"><img hidden src="https://example.com/x.png">' +
          '<div hidden style="background:url(http://169.254.169.254/latest/meta-data/)"></div>',
        300,
        caps,
      );
      const started = Date.now();
      const png = await renderer.renderPng(renderRequest(plan, 1, caps.maxPixels));
      expect(pngSize(png)).toEqual({ width: 300, height: 20 });
      // 外联被中止而非等超时：整个流程应在数秒内完成
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await renderer.dispose();
    }
  }, 30_000);
});
