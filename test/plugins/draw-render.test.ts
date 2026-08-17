import { describe, expect, it } from 'vitest';
import { DrawEngine } from '../../packages/plugin-draw/src/engine.js';
import { type DrawCaps, resolveCanvas } from '../../packages/plugin-draw/src/plan.js';

// ════════════════════════════════════════════════════════════
// 真 Chromium 集成锚（本机已有 puppeteer 缓存的 Chrome）。
// 三件必须实证的事：
//   1) 渲染出真 PNG 且尺寸 = 画布×scale（定界生效）；
//   2) 标记里的 <script> 不执行（setJavaScriptEnabled(false) 生效）；
//   3) 外联请求被拦但渲染不挂死（default-deny 拦截生效）。
// 安全断言的依据是调研实测：不硬化时 <script> 会真执行、外联会真发出。
// ════════════════════════════════════════════════════════════

const caps: DrawCaps = { defaultWidth: 800, maxWidth: 1600, maxPixels: 4_000_000, maxSourceBytes: 262144, scale: 2 };
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => logger } as never;

function pngSize(buf: Buffer): { width: number; height: number } {
  // PNG IHDR：width/height 位于第 16-24 字节（大端）
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function makeEngine(): DrawEngine {
  return new DrawEngine(logger, { headless: true, idleShutdownMs: 0, stepTimeoutMs: 15_000 });
}

describe('DrawEngine（真浏览器）', () => {
  it('SVG 渲染：PNG 尺寸 = 画布×scale，中文/emoji 不豆腐（有输出即可，保真靠人验）', async () => {
    const engine = makeEngine();
    try {
      const plan = resolveCanvas(
        '<svg viewBox="0 0 200 100"><rect width="200" height="100" fill="#3b82f6"/>' +
          '<text x="100" y="55" text-anchor="middle" fill="#fff" font-size="20">你好 Aalis</text></svg>',
        200,
        caps,
      );
      const r = await engine.renderPng(plan, 2, caps.maxPixels);
      expect(r.width).toBe(200);
      expect(r.height).toBe(100);
      expect(pngSize(r.png)).toEqual({ width: 400, height: 200 });
      expect(r.png.byteLength).toBeGreaterThan(1000);
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  it('HTML 渲染：宽定参数、高实测；折行文本高度>单行', async () => {
    const engine = makeEngine();
    try {
      const plan = resolveCanvas(
        `<div style="font-size:20px;line-height:1.5">${'很长的中文内容'.repeat(30)}</div>`,
        300,
        caps,
      );
      const r = await engine.renderPng(plan, 1, caps.maxPixels);
      expect(r.width).toBe(300);
      expect(r.height).toBeGreaterThan(60); // 必然折成多行
      expect(pngSize(r.png).width).toBe(300);
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  it('安全：<script> 不执行、外联被拦、渲染不挂死', async () => {
    const engine = makeEngine();
    try {
      const plan = resolveCanvas(
        '<div id="t">safe</div>' +
          '<script>document.getElementById("t").textContent="pwned";document.title="pwned"</script>' +
          '<img src="http://127.0.0.1:1/never.png"><img src="https://example.com/x.png">',
        300,
        caps,
      );
      const started = Date.now();
      await engine.withPage(plan, 200, async page => {
        const title = await page.evaluate<string>('document.title');
        const text = await page.evaluate<string>('document.getElementById("t").textContent');
        expect(title).not.toBe('pwned');
        expect(text).toBe('safe');
      });
      // 外联被 abort 而非等超时：整个流程应在数秒内完成
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await engine.dispose();
    }
  }, 30_000);
});
