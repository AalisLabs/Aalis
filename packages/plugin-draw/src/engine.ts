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

export interface EngineConfig {
  headless: boolean;
  executablePath?: string;
  /** 空闲多少毫秒后关停 Chromium（0=不关停） */
  idleShutdownMs: number;
  /** 单次 setContent/渲染步骤超时 */
  stepTimeoutMs: number;
}

export class DrawEngine {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

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
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (allowRequest(req.url())) req.continue().catch(() => {});
        else req.abort('blockedbyclient').catch(() => {});
      });
      await page.setViewport({ width: plan.width, height: viewportHeight, deviceScaleFactor: 1 });
      await page.setContent(plan.html, { waitUntil: 'load', timeout: this.cfg.stepTimeoutMs });
      // 等字体就绪（外链字体被拦时会快速 resolve 并回退系统字体，不会挂死——实测行为）
      await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true');
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
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
        const measured = await page.evaluate<number>(
          'Math.ceil(document.getElementById("aalis-draw").getBoundingClientRect().height)',
        );
        height = Math.max(16, Math.min(measured || 16, Math.floor(maxPixels / plan.width)));
      }
      await page.setViewport({ width: plan.width, height, deviceScaleFactor: scale });
      const shot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: plan.width, height },
      });
      return { png: Buffer.from(shot), width: plan.width, height };
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
