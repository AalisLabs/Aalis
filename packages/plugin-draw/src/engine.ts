// ============================================================
// engine.ts — 硬化渲染引擎（独立 Chromium 实例，懒启动 + 空闲关停）
//
// 刻意不复用 plugin-tool-browser 的共享页面池：那里承载可能带登录态的
// 真实浏览页，本插件渲染的是 LLM 生成的不可信标记，二者不同进程隔离。
// 每次渲染开独立 page，硬化三件套：
//   1) setJavaScriptEnabled(false) —— 标记里的 <script> 一律不执行；
//   2) 请求拦截 default-deny —— 只放 about:blank 与 data:（见 plan.allowRequest）；
//   3) 视口即画布 —— 定宽定高 + clip 截图，杜绝内联 SVG 随视口伸缩。
// ============================================================

import { Buffer } from 'node:buffer';
import type { Logger } from '@aalis/core';
import { allowRequest, type CanvasPlan } from './plan.js';

// puppeteer 动态 import（与 plugin-tool-browser 同策略：避免顶层类型耦合）
type Browser = {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  connected: boolean;
};
type Page = {
  setJavaScriptEnabled(v: boolean): Promise<void>;
  setRequestInterception(v: boolean): Promise<void>;
  on(event: 'request', handler: (req: InterceptedRequest) => void): void;
  setViewport(v: { width: number; height: number; deviceScaleFactor: number }): Promise<void>;
  setContent(html: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  evaluate<T>(fn: string | ((...a: never[]) => T), ...args: unknown[]): Promise<T>;
  screenshot(opts: {
    type: 'png';
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array>;
  close(): Promise<void>;
};
type InterceptedRequest = {
  url(): string;
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
};

interface EngineConfig {
  headless: boolean;
  executablePath?: string;
  /** 空闲多少毫秒后关停 Chromium（0=不关停） */
  idleShutdownMs: number;
  /** 单次 setContent/渲染步骤超时 */
  stepTimeoutMs: number;
  /** 同时在渲染的 page 数上限（防群内并发画图起无界 page + ffmpeg） */
  maxConcurrency: number;
}

export class DrawEngine {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private logger: Logger,
    private cfg: EngineConfig,
  ) {}

  private async ensureBrowser(): Promise<Browser> {
    if (this.disposed) throw new Error('渲染引擎已停用');
    if (this.browser?.connected) return this.browser;
    if (!this.launching) {
      this.launching = (async () => {
        const { default: puppeteer } = (await import('puppeteer')) as unknown as {
          default: {
            launch(opts: Record<string, unknown>): Promise<Browser>;
          };
        };
        const browser = await puppeteer.launch({
          headless: this.cfg.headless,
          ...(this.cfg.executablePath ? { executablePath: this.cfg.executablePath } : {}),
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        this.logger.info('绘图引擎 Chromium 已启动（独立实例，不与 browser 工具共享）');
        return browser;
      })().finally(() => {
        this.launching = null;
      });
      this.browser = await this.launching;
      return this.browser;
    }
    return this.launching;
  }

  /** 给 post-load 步骤（evaluate/screenshot——不吃 puppeteer timeout）套墙钟硬上限，防极端 CSS 慢渲染吊死渲染槽。 */
  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_r, reject) =>
        setTimeout(() => reject(new Error(`渲染步骤超时（${label}）`)), this.cfg.stepTimeoutMs).unref?.(),
      ),
    ]);
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.cfg.maxConcurrency) {
      this.active++;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    this.active++;
  }

  private releaseSlot(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfg.idleShutdownMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      const b = this.browser;
      this.browser = null;
      if (b) {
        b.close().catch(() => {});
        this.logger.info('绘图引擎空闲，Chromium 已关停');
      }
    }, this.cfg.idleShutdownMs);
    // 不阻止进程退出
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 开一张硬化后的独立 page，执行 fn 后必关。 */
  async withPage<T>(plan: CanvasPlan, viewportHeight: number, fn: (page: Page) => Promise<T>): Promise<T> {
    await this.acquireSlot();
    let page: Page | null = null;
    try {
      const browser = await this.ensureBrowser();
      page = await browser.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (allowRequest(req.url())) req.continue().catch(() => {});
        else req.abort('blockedbyclient').catch(() => {});
      });
      await page.setViewport({ width: plan.width, height: viewportHeight, deviceScaleFactor: 1 });
      await page.setContent(plan.html, { waitUntil: 'load', timeout: this.cfg.stepTimeoutMs });
      // 等字体就绪（外链字体被拦时会快速 resolve 并回退系统字体，不会挂死——实测行为）
      await this.withTimeout(page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true'), 'fonts');
      return await fn(page);
    } finally {
      if (page) await page.close().catch(() => {});
      this.releaseSlot();
      this.touchIdle();
    }
  }

  /** 静态渲染：定界（HTML 模式实测内容高）→ 设缩放视口 → clip 截图。 */
  async renderPng(
    plan: CanvasPlan,
    scale: number,
    maxPixels: number,
  ): Promise<{ png: Buffer; width: number; height: number }> {
    const guessHeight = plan.height === 'auto' ? 600 : plan.height;
    return this.withPage(plan, guessHeight, async page => {
      let height = plan.height;
      if (height === 'auto') {
        const measured = await this.withTimeout(
          page.evaluate<number>('Math.ceil(document.getElementById("aalis-draw").getBoundingClientRect().height)'),
          'measure',
        );
        height = Math.max(16, Math.min(measured || 16, Math.floor(maxPixels / plan.width)));
      }
      await page.setViewport({ width: plan.width, height, deviceScaleFactor: scale });
      const shot = await this.withTimeout(
        page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: plan.width, height } }),
        'screenshot',
      );
      return { png: Buffer.from(shot), width: plan.width, height };
    });
  }

  /**
   * 动画渲染：同一页内完成「暂停时钟 → 时长探测 → 逐帧定格截图」。
   * 双机制必须并用（调研实测 getAnimations() 不暴露 SMIL）：
   *   SMIL → svg.pauseAnimations() + svg.setCurrentTime(t)
   *   CSS/WAAPI → document.getAnimations() 逐个 pause() + currentTime=t*1000
   * 步进与截图之间无真实时间依赖，帧序列字节级确定（调研实测）。
   * 时长：显式参数 > 文档声明探测（CSS computedTiming / SMIL getSimpleDuration，
   * 无穷循环按单轮计）> 默认值；帧数受 maxFrames 收口（超出按帧数反推有效时长）。
   */
  async renderAnimation(
    plan: CanvasPlan,
    opts: {
      fps: number;
      requestedDurationMs?: number;
      defaultDurationMs: number;
      maxDurationMs: number;
      maxFrames: number;
      scale: number;
      maxPixels: number;
    },
  ): Promise<{ frames: Buffer[]; width: number; height: number; animationCount: number; durationMs: number }> {
    const guessHeight = plan.height === 'auto' ? 600 : plan.height;
    return this.withPage(plan, guessHeight, async page => {
      let height = plan.height;
      if (height === 'auto') {
        const measured = await this.withTimeout(
          page.evaluate<number>('Math.ceil(document.getElementById("aalis-draw").getBoundingClientRect().height)'),
          'measure',
        );
        height = Math.max(16, Math.min(measured || 16, Math.floor(opts.maxPixels / plan.width)));
      }
      await page.setViewport({ width: plan.width, height, deviceScaleFactor: opts.scale });

      // 暂停两套动画时钟；顺带数动画数与声明时长（0 动画 = 调用方该提示"这是静态图"）
      const probe = await page.evaluate<{ count: number; durationMs: number }>(
        `(() => {
          let count = 0;
          let max = 0;
          for (const svg of document.querySelectorAll('svg')) {
            try { svg.pauseAnimations(); } catch {}
            for (const el of svg.querySelectorAll('animate,animateTransform,animateMotion,set')) {
              count += 1;
              try {
                const d = el.getSimpleDuration();
                if (Number.isFinite(d)) max = Math.max(max, d * 1000);
              } catch {}
            }
          }
          for (const a of document.getAnimations()) {
            try {
              a.pause();
              count += 1;
              const t = a.effect.getComputedTiming();
              const iters = Number.isFinite(t.iterations) ? t.iterations : 1;
              max = Math.max(max, (t.delay || 0) + (Number(t.duration) || 0) * iters);
            } catch {}
          }
          return { count, durationMs: Math.round(max) };
        })()`,
      );

      let durationMs = opts.requestedDurationMs ?? (probe.durationMs > 0 ? probe.durationMs : opts.defaultDurationMs);
      durationMs = Math.min(durationMs, opts.maxDurationMs);
      let frameCount = Math.max(2, Math.round((durationMs / 1000) * opts.fps));
      if (frameCount > opts.maxFrames) {
        frameCount = opts.maxFrames;
        durationMs = Math.round((frameCount / opts.fps) * 1000);
      }

      const frames: Buffer[] = [];
      for (let i = 0; i < frameCount; i++) {
        const t = (i / opts.fps).toFixed(6);
        await page.evaluate(
          `((t) => {
            for (const svg of document.querySelectorAll('svg')) {
              try { svg.setCurrentTime(t); } catch {}
            }
            for (const a of document.getAnimations()) {
              try { a.pause(); a.currentTime = t * 1000; } catch {}
            }
          })(${t})`,
        );
        const shot = await this.withTimeout(
          page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: plan.width, height } }),
          `frame ${i}`,
        );
        frames.push(Buffer.from(shot));
      }
      return { frames, width: plan.width, height, animationCount: probe.count, durationMs };
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const b = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
    this.browser = null;
    if (b) await b.close().catch(() => {});
  }
}
