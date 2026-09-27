// ============================================================
// engine.ts — 离线渲染引擎（独立 Chromium 实例：懒启动、空闲关停、步骤超时换代、并发槽）
//
// 每次渲染新建一个浏览器上下文、渲染完关掉（缓存、cookie、存储不在两次渲染之间共享），上下文里开一张页面：
//   1) setJavaScriptEnabled(false)：文档里的脚本一律不执行；
//   2) 请求拦截：data:、blob: 放行，resources 里精确列出的网址由这里响应，其余（file:、未列出的 http(s)、chrome: 等）
//      一律中止。https 文档里对 file: 的引用由 Chrome 自己的来源规则挡住、到不了拦截回调，所以入口只收 https 网址；
//   3) 解析规则与代理把漏过拦截的连接送到死端口（见 launch.ts）。
// 主框架在加载后被导航出去（如 meta refresh 指向清单外）时，导航同样被中止，Chrome 换上自己的错误页：渲染随之失败，
// 或截到错误页。调用方把渲染失败当作「没看到内容」处理。
// 不落盘；puppeteer 的用户数据目录由它自己在系统临时目录建与删。
// ============================================================

import type { Browser, BrowserContext, HTTPRequest, Page } from 'puppeteer';
import { type AnimationOptions, type FramesResult, PAUSE_AND_PROBE, planFrames, seekScript } from './animation.js';
import { Launcher, type SandboxPolicy } from './launch.js';

export interface OfflineRendererOptions {
  sandbox: SandboxPolicy;
  /** 透传 puppeteer；缺省 true */
  headless?: boolean | 'shell';
  executablePath?: string;
  /** 同时进行的渲染数上限，超出的排队；缺省 2 */
  maxConcurrency?: number;
  /** 空闲多少秒后关停 Chromium，0 为常驻；缺省 300 */
  idleShutdownSec?: number;
  /** 加载、等字体、量高、截图各步的时限；缺省 15000。单条 CDP 命令的时限取它的两倍 */
  stepTimeoutMs?: number;
  logger: { debug(m: string): void; info(m: string): void; warn(m: string): void };
}

export interface RenderResource {
  body: Uint8Array;
  contentType: string;
}

/**
 * 截图范围：
 * - viewport：视口；
 * - element：按选择器量元素的框，限高 maxHeight；视口高随之调到元素下沿（视口即画布）；
 * - page：整页（文档滚动高），限高 maxHeight，视口不变。
 */
export type RenderClip =
  | { kind: 'viewport' }
  | { kind: 'element'; selector: string; maxHeight: number }
  | { kind: 'page'; maxHeight: number };

export interface RenderRequest {
  /** 文档网址，必须是 resources 的键、https 网址的规范写法；用保留域名，如 https://render.invalid/<作品编号>/ */
  entry: string;
  /** 网址 → 内容：只有这里精确列出的网址会被响应 */
  resources: ReadonlyMap<string, RenderResource>;
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  clip: RenderClip;
  signal?: AbortSignal;
}

/** 渲染步骤超时：底层 CDP 调用仍挂着，这一代浏览器随之关掉（见 withPage）。 */
export class StepTimeoutError extends Error {
  override name = 'StepTimeoutError';
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function checkRequest(req: RenderRequest): void {
  let entry: URL;
  try {
    entry = new URL(req.entry);
  } catch {
    throw new TypeError(`entry 不是网址：${req.entry}`);
  }
  if (entry.protocol !== 'https:') throw new TypeError(`entry 必须是 https 网址：${req.entry}`);
  if (entry.href !== req.entry) throw new TypeError(`entry 须写成规范形式 ${entry.href}：${req.entry}`);
  if (!req.resources.has(req.entry)) throw new TypeError(`entry 不在 resources 里：${req.entry}`);
  if (req.clip.kind !== 'viewport' && !(req.clip.maxHeight >= 1)) {
    throw new TypeError(`clip.maxHeight 必须不小于 1：${req.clip.maxHeight}`);
  }
}

/** 调用方一取消就以取消原因失败；里面的渲染照常收尾（关上下文、换代、释放并发槽）。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function route(request: HTTPRequest, resources: ReadonlyMap<string, RenderResource>): void {
  const url = request.url();
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    request.continue().catch(() => {});
    return;
  }
  const hit = resources.get(url);
  if (hit) {
    request.respond({ status: 200, contentType: hit.contentType, body: hit.body }).catch(() => {});
    return;
  }
  request.abort('blockedbyclient').catch(() => {});
}

const clampHeight = (h: number, max: number): number => Math.max(1, Math.min(Math.ceil(h) || 1, Math.floor(max)));

export class OfflineRenderer {
  private readonly launcher: Launcher;
  private readonly logger: OfflineRendererOptions['logger'];
  private readonly stepTimeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly idleShutdownMs: number;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(opts: OfflineRendererOptions) {
    this.logger = opts.logger;
    this.stepTimeoutMs = opts.stepTimeoutMs ?? 15_000;
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.idleShutdownMs = (opts.idleShutdownSec ?? 300) * 1000;
    this.launcher = new Launcher({
      sandbox: opts.sandbox,
      headless: opts.headless ?? true,
      executablePath: opts.executablePath,
      stepTimeoutMs: this.stepTimeoutMs,
      logger: opts.logger,
    });
  }

  /** 渲染一张 PNG。 */
  renderPng(req: RenderRequest): Promise<Uint8Array> {
    return this.run(req, (page, box) => this.shot(page, box, 'screenshot'));
  }

  /** 动画：暂停 SMIL 与 CSS/WAAPI 两套时钟、探测时长、逐帧定格截图。 */
  renderFrames(req: RenderRequest, anim: AnimationOptions): Promise<FramesResult> {
    return this.run(req, async (page, box) => {
      const probe = (await page.evaluate(PAUSE_AND_PROBE)) as { count: number; durationMs: number };
      const { frameCount, durationMs } = planFrames(probe.durationMs, anim);
      const frames: Uint8Array[] = [];
      for (let i = 0; i < frameCount; i++) {
        await page.evaluate(seekScript(i / anim.fps));
        frames.push(await this.shot(page, box, `frame ${i}`));
      }
      return { frames, durationMs, animationCount: probe.count };
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const b = this.browser ?? (this.launching ? await this.launching.catch(() => null) : null);
    this.browser = null;
    if (b) await b.close().catch(() => {});
  }

  private async run<T>(req: RenderRequest, fn: (page: Page, box: Box) => Promise<T>): Promise<T> {
    checkRequest(req);
    req.signal?.throwIfAborted();
    const work = this.withPage(req, fn);
    return req.signal ? abortable(work, req.signal) : work;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.disposed) throw new Error('离线渲染已停用');
    if (this.browser?.connected) return this.browser;
    if (!this.launching) {
      this.launching = this.launcher.launch().finally(() => {
        this.launching = null;
      });
      this.browser = await this.launching;
      return this.browser;
    }
    return this.launching;
  }

  /**
   * 给加载之后的步骤（等字体、量高、截图：不吃 puppeteer 的 timeout）套步骤时限，防极端 CSS 慢渲染吊死并发槽。
   * 时限只让等待方先失败，底层 CDP 调用仍挂着；截图还持有浏览器级的锁，关上下文与别的渲染开新页都要等它。
   * 所以超时抛 StepTimeoutError，由 withPage 关掉这一代浏览器。
   */
  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_r, reject) =>
        setTimeout(() => reject(new StepTimeoutError(`渲染步骤超时（${label}）`)), this.stepTimeoutMs).unref?.(),
      ),
    ]);
  }

  /**
   * 关掉这一代浏览器，不等关闭落定（浏览器进程本身卡住时，puppeteer 在 protocolTimeout 后强杀进程）。
   * 挂着的 CDP 调用随连接断开失败、锁随之释放，同一代里其它在飞的渲染一并失败；下次渲染懒启动新的一代。
   */
  private retire(browser: Browser, reason: string): void {
    // 已不是当前这一代（别的超时已换代、空闲关停或停用）：关闭已由那一方发起
    if (this.browser !== browser) return;
    this.browser = null;
    this.logger.warn(`${reason}，关闭这一代 Chromium，下次渲染时重新启动`);
    browser
      .close()
      .catch(err => this.logger.warn(`关闭 Chromium 失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.maxConcurrency) {
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
    if (this.idleShutdownMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      const b = this.browser;
      this.browser = null;
      if (b) {
        b.close().catch(() => {});
        this.logger.info('离线渲染空闲，Chromium 已关停');
      }
    }, this.idleShutdownMs);
    // 不阻止进程退出
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 新建上下文、开页面、加载入口并量好截图范围，执行 fn 后关掉上下文；步骤超时时关掉这一代浏览器。 */
  private async withPage<T>(req: RenderRequest, fn: (page: Page, box: Box) => Promise<T>): Promise<T> {
    await this.acquireSlot();
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    // 取消时关掉上下文，挂着的 CDP 调用随之失败
    const stop = () => {
      context?.close().catch(() => {});
    };
    req.signal?.addEventListener('abort', stop, { once: true });
    try {
      req.signal?.throwIfAborted();
      browser = await this.ensureBrowser();
      context = await browser.createBrowserContext();
      req.signal?.throwIfAborted();
      const page = await context.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on('request', request => route(request, req.resources));
      await page.setViewport({ ...req.viewport, deviceScaleFactor: req.viewport.deviceScaleFactor ?? 1 });
      await page.goto(req.entry, { waitUntil: 'load', timeout: this.stepTimeoutMs });
      // 等字体就绪（外链字体被拦时很快落定并回退系统字体，不会挂死——实测行为）
      await this.withTimeout(page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true'), 'fonts');
      const box = await this.measure(page, req);
      return await fn(page, box);
    } catch (err) {
      if (err instanceof StepTimeoutError && browser) {
        this.retire(browser, err.message);
        // 不等关上下文：它要等挂住的截图释放锁
        context = null;
      }
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', stop);
      if (context) await context.close().catch(() => {});
      this.releaseSlot();
      this.touchIdle();
    }
  }

  private async measure(page: Page, req: RenderRequest): Promise<Box> {
    const { clip, viewport } = req;
    if (clip.kind === 'viewport') return { x: 0, y: 0, width: viewport.width, height: viewport.height };
    if (clip.kind === 'page') {
      const height = await this.withTimeout(
        page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)),
        'measure',
      );
      return { x: 0, y: 0, width: viewport.width, height: clampHeight(height, clip.maxHeight) };
    }
    const rect = await this.withTimeout(
      page.evaluate(selector => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
      }, clip.selector),
      'measure',
    );
    if (!rect) throw new Error(`截图范围的元素不存在：${clip.selector}`);
    const box = {
      x: rect.x,
      y: rect.y,
      width: Math.max(1, Math.ceil(rect.width)),
      height: clampHeight(rect.height, clip.maxHeight),
    };
    await page.setViewport({
      width: viewport.width,
      height: Math.ceil(box.y + box.height),
      deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    });
    return box;
  }

  private shot(page: Page, box: Box, label: string): Promise<Uint8Array> {
    return this.withTimeout(page.screenshot({ type: 'png', clip: box }), label);
  }
}
