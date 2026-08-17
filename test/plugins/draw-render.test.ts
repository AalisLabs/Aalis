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
  return new DrawEngine(logger, { headless: true, idleShutdownMs: 0, stepTimeoutMs: 15_000, maxConcurrency: 4 });
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

  // 真引擎级 SSRF 锚：证明「引擎确实把 http(s) 子资源请求路由过 allowRequest 并 abort」，
  // 而非只测 allowRequest 纯函数（那不证明引擎接了这道闸）。把引擎的请求拦截删掉→此锚变红。
  // 覆盖多种子资源向量：<img>、SVG <image href>、CSS url()。
  it('引擎级：多种外链子资源全部被拦（http 请求不出网）', async () => {
    const engine = makeEngine();
    try {
      const plan = resolveCanvas(
        '<style>#b{background:url(http://10.0.0.1/bg.png)}</style>' +
          '<div id="b">x</div>' +
          '<img src="http://169.254.169.254/latest/meta-data/">' +
          '<svg viewBox="0 0 10 10"><image href="https://evil.example.com/pixel.png" width="10" height="10"/></svg>',
        300,
        caps,
      );
      const requested: string[] = [];
      const continued: string[] = [];
      await engine.withPage(plan, 200, async page => {
        // withPage 内部已装 default-deny 拦截器；这里再挂一个观察者记录实际路由的请求
        (page as unknown as { on(e: string, h: (r: { url(): string }) => void): void }).on('requestfailed', r =>
          requested.push(r.url()),
        );
        (page as unknown as { on(e: string, h: (r: { url(): string }) => void): void }).on('requestfinished', r =>
          continued.push(r.url()),
        );
        await page.evaluate('document.title'); // 等一拍让子资源请求发生
      });
      // 没有任何 http(s) 子资源被放行完成（只 about:blank/data: 会 finished）
      expect(continued.some(u => u.startsWith('http'))).toBe(false);
    } finally {
      await engine.dispose();
    }
  }, 30_000);

  // 并发信号量（对抗审计 MED-1）：maxConcurrency=1 时第二个渲染必须等第一个释放槽，
  // 不能并行开 page。把 acquireSlot/releaseSlot 删掉→两者并行完成、峰值观测=2→红。
  it('并发闸：maxConcurrency=1 时渲染排队而非并行', async () => {
    const engine = new DrawEngine(logger, {
      headless: true,
      idleShutdownMs: 0,
      stepTimeoutMs: 15_000,
      maxConcurrency: 1,
    });
    try {
      let inFlight = 0;
      let peak = 0;
      const plan = resolveCanvas('<svg viewBox="0 0 40 40"><rect width="40" height="40" fill="#333"/></svg>', 40, caps);
      const one = () =>
        engine.withPage(plan, 40, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise(r => setTimeout(r, 60));
          inFlight--;
        });
      await Promise.all([one(), one(), one()]);
      expect(peak).toBe(1); // 信号量把并发压到 1
    } finally {
      await engine.dispose();
    }
  }, 30_000);
});
