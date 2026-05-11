import type { Context, ConfigSchema, PluginModule } from '@aalis/core';
import type { WebuiPage } from '@aalis/plugin-webui-api';

// ════════════════════════════════════════════════════════════
// plugin-tool-browser — 浏览器自动化工具
//
// 提供 AI 可调用的浏览器操作工具：导航、获取文本、截图、点击、输入。
// 基于 Puppeteer，支持 headless 模式。
// ════════════════════════════════════════════════════════════

// ──────────── 类型 ────────────

interface BrowserConfig {
  headless: boolean;
  defaultTimeout: number;
  viewportWidth: number;
  viewportHeight: number;
  maxPages: number;
  executablePath: string;
  maxContentLength: number;
  allowedProtocols: string[];
  blockPrivate: boolean;
  allowedHosts: string[];
}

interface PageSlot {
  page: any; // puppeteer Page
  url: string;
  title: string;
  lastAccess: number;
}

// ──────────── 插件元数据 ────────────

export const name = '@aalis/plugin-tool-browser';
export const displayName = '浏览器工具';

// tools 服务由核心提供，无需声明依赖

export const configSchema: ConfigSchema = {
  headless: {
    type: 'boolean',
    label: '无头模式',
    default: true,
    description: '是否以无头模式运行浏览器（无 GUI 窗口）。',
  },
  defaultTimeout: {
    type: 'number',
    label: '默认超时(ms)',
    default: 30000,
    description: '页面导航和操作的默认超时时间。',
  },
  viewportWidth: { type: 'number', label: '视口宽度', default: 1280 },
  viewportHeight: { type: 'number', label: '视口高度', default: 720 },
  maxPages: {
    type: 'number',
    label: '最大页面数',
    default: 5,
    description: '同时打开的最大标签页数量。超出后关闭最早打开的页面。',
  },
  executablePath: {
    type: 'string',
    label: 'Chrome 路径',
    description: '自定义 Chrome/Chromium 可执行文件路径。留空则使用 Puppeteer 内置 Chromium。',
  },
  maxContentLength: {
    type: 'number',
    label: '最大内容长度',
    default: 50000,
    description: '返回给 Agent 的页面文本最大字符数。',
  },
  blockPrivate: {
    type: 'boolean',
    label: '封锁内网与本地',
    default: true,
    description: '拒绝 localhost / 127.x / ::1 / 10.x / 172.16-31.x / 192.168.x / 169.254.x / 0.0.0.0，防止 SSRF。',
  },
  // allowedProtocols（默认 [http,https]）与 allowedHosts（默认 []）请直接在 aalis.config.yaml 中编辑。
};

export const defaultConfig = {
  headless: true,
  defaultTimeout: 30000,
  viewportWidth: 1280,
  viewportHeight: 720,
  maxPages: 5,
  executablePath: '',
  maxContentLength: 50000,
  allowedProtocols: ['http', 'https'],
  blockPrivate: true,
  allowedHosts: [] as string[],
};

// ──────────── WebUI 页面 ────────────

export const webuiPages: WebuiPage[] = [
  {
    key: 'browser',
    label: '浏览器',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    order: 57,
    content: [
      {
        type: 'table',
        label: '打开的页面',
        source: 'listPages',
        columns: [
          { key: 'id', label: 'ID' },
          { key: 'title', label: '标题' },
          { key: 'url', label: 'URL' },
          { key: 'lastAccessText', label: '最后访问' },
        ],
        actions: [
          { label: '关闭', method: 'closePage', confirm: '确定关闭该页面？' },
        ],
        refresh: 15,
      },
      {
        type: 'actions',
        label: '操作',
        items: [
          { label: '关闭所有页面', method: 'closeAll', confirm: '确定关闭所有页面？', danger: true },
        ],
      },
    ],
  },
];

// ──────────── 插件入口 ────────────

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('browser');

  let browser: any = null;
  const pages = new Map<string, PageSlot>();
  let pageCounter = 0;

  // ── 动态加载 puppeteer ──

  async function ensureChrome(): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');
    const puppeteer = await import('puppeteer');
    const execPath = puppeteer.executablePath?.() ?? puppeteer.default?.executablePath?.();
    if (execPath && fs.existsSync(execPath)) return;

    logger.info('Chrome 未安装，正在自动下载...');
    // 通过 puppeteer 包路径找到其内置 CLI
    const puppeteerPkg = path.dirname(
      (await import('url')).fileURLToPath(import.meta.resolve('puppeteer'))
    );
    // 向上找到 puppeteer 包根目录（含 package.json）
    let pkgRoot = puppeteerPkg;
    while (!fs.existsSync(path.join(pkgRoot, 'package.json'))) {
      const parent = path.dirname(pkgRoot);
      if (parent === pkgRoot) break;
      pkgRoot = parent;
    }
    const cliPath = path.join(pkgRoot, 'lib', 'cjs', 'puppeteer', 'node', 'cli.js');
    const { execFileSync } = await import('child_process');
    execFileSync(process.execPath, [cliPath, 'browsers', 'install', 'chrome'], {
      stdio: 'inherit',
      timeout: 300_000,
    });
    logger.info('Chrome 下载完成');
  }

  async function ensureBrowser(): Promise<any> {
    if (browser) return browser;
    try {
      if (!config.executablePath) {
        await ensureChrome();
      }
      const puppeteer = await import('puppeteer');
      const launchFn = puppeteer.default?.launch ?? puppeteer.launch;
      browser = await launchFn({
        headless: config.headless,
        defaultViewport: { width: config.viewportWidth, height: config.viewportHeight },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        ...(config.executablePath ? { executablePath: config.executablePath } : {}),
      });
      logger.info('浏览器已启动');
      return browser;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`启动浏览器失败: ${msg}`);
      throw new Error(`浏览器启动失败: ${msg}。请确保已安装 Chrome: npx puppeteer browsers install chrome`);
    }
  }

  // ── 获取或创建页面 ──

  async function getOrCreatePage(id?: string): Promise<{ id: string; slot: PageSlot }> {
    if (id && pages.has(id)) {
      const slot = pages.get(id)!;
      slot.lastAccess = Date.now();
      return { id, slot };
    }

    // 超出最大页面数，关闭最早的
    if (pages.size >= config.maxPages) {
      let oldest: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of pages) {
        if (v.lastAccess < oldestTime) {
          oldest = k;
          oldestTime = v.lastAccess;
        }
      }
      if (oldest) {
        try { await pages.get(oldest)!.page.close(); } catch {}
        pages.delete(oldest);
      }
    }

    const b = await ensureBrowser();
    const page = await b.newPage();
    page.setDefaultTimeout(config.defaultTimeout);
    const newId = `page_${++pageCounter}`;
    const slot: PageSlot = { page, url: 'about:blank', title: '', lastAccess: Date.now() };
    pages.set(newId, slot);
    return { id: newId, slot };
  }

  // ── 截断文本 ──

  function truncate(text: string): string {
    if (text.length <= config.maxContentLength) return text;
    return text.slice(0, config.maxContentLength) + `\n... [内容已截断，共 ${text.length} 字符]`;
  }

  // ── 注册工具分组 ──

  ctx.registerToolGroup({
    name: 'browser',
    label: '浏览器',
    description: '使用 Puppeteer 无头浏览器进行网页导航、内容提取、截图等操作',
  });

  // ── 注册工具 ──

  // 1. 导航 (navigate)
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: '在浏览器中打开指定 URL。返回页面标题和文本内容摘要。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要访问的 URL' },
            pageId: { type: 'string', description: '页面 ID（可选，复用已有标签页）' },
            waitFor: { type: 'string', description: '等待的 CSS 选择器（可选）' },
          },
          required: ['url'],
        },
      },
    },
    handler: async (args) => {
      try {
        const targetUrl = args.url as string;
        const urlError = validateUrl(targetUrl, config);
        if (urlError) return JSON.stringify({ error: urlError });
        const { id, slot } = await getOrCreatePage(args.pageId as string);
        await slot.page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: config.defaultTimeout });
        if (args.waitFor) {
          await slot.page.waitForSelector(args.waitFor as string, { timeout: config.defaultTimeout });
        }
        slot.url = slot.page.url();
        slot.title = await slot.page.title();
        const text = await slot.page.evaluate(() => document.body?.innerText ?? '');
        return JSON.stringify({
          pageId: id,
          title: slot.title,
          url: slot.url,
          text: truncate(text),
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 2. 获取页面文本
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_get_text',
        description: '获取当前浏览器页面的文本内容。可通过 CSS 选择器获取特定元素。',
        parameters: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: '页面 ID' },
            selector: { type: 'string', description: 'CSS 选择器（可选，获取特定元素文本）' },
          },
          required: ['pageId'],
        },
      },
    },
    handler: async (args) => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        let text: string;
        if (args.selector) {
          text = await slot.page.evaluate(
            (sel: string) => {
              const el = document.querySelector(sel) as HTMLElement | null;
              return el?.innerText ?? `未找到元素: ${sel}`;
            },
            args.selector as string,
          );
        } else {
          text = await slot.page.evaluate(() => document.body?.innerText ?? '');
        }
        slot.lastAccess = Date.now();
        return JSON.stringify({ text: truncate(text) });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 3. 点击元素
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_click',
        description: '在浏览器页面中点击指定的元素。',
        parameters: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: '页面 ID' },
            selector: { type: 'string', description: '要点击的元素的 CSS 选择器' },
          },
          required: ['pageId', 'selector'],
        },
      },
    },
    handler: async (args) => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        await slot.page.click(args.selector as string);
        await slot.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        slot.url = slot.page.url();
        slot.title = await slot.page.title();
        slot.lastAccess = Date.now();
        return JSON.stringify({ ok: true, url: slot.url, title: slot.title });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 4. 输入文本
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_type',
        description: '在浏览器页面的输入框中输入文本。',
        parameters: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: '页面 ID' },
            selector: { type: 'string', description: '输入框的 CSS 选择器' },
            text: { type: 'string', description: '要输入的文本' },
            clear: { type: 'boolean', description: '是否先清空输入框（默认 true）' },
            submit: { type: 'boolean', description: '输入后是否按回车提交（默认 false）' },
          },
          required: ['pageId', 'selector', 'text'],
        },
      },
    },
    handler: async (args) => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        const selector = args.selector as string;
        if (args.clear !== false) {
          await slot.page.click(selector, { clickCount: 3 });
        }
        await slot.page.type(selector, args.text as string);
        if (args.submit) {
          await slot.page.keyboard.press('Enter');
          await slot.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        }
        slot.lastAccess = Date.now();
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 5. 截图
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description: '对当前浏览器页面截图，返回 base64 编码的 PNG 图片。',
        parameters: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: '页面 ID' },
            fullPage: { type: 'boolean', description: '是否截取整个页面（默认 false，仅视口）' },
            selector: { type: 'string', description: '仅截取指定元素（可选）' },
          },
          required: ['pageId'],
        },
      },
    },
    handler: async (args) => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        let buffer: Buffer;
        if (args.selector) {
          const el = await slot.page.$(args.selector as string);
          if (!el) return JSON.stringify({ error: `未找到元素: ${args.selector}` });
          buffer = await el.screenshot({ encoding: 'binary' });
        } else {
          buffer = await slot.page.screenshot({
            fullPage: args.fullPage === true,
            encoding: 'binary',
          });
        }
        slot.lastAccess = Date.now();
        const base64 = Buffer.from(buffer).toString('base64');
        return JSON.stringify({
          image: `data:image/png;base64,${base64}`,
          size: buffer.length,
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 6. 获取页面链接列表
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_get_links',
        description: '获取当前页面上的所有链接（a 标签），返回 href 和文本。',
        parameters: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: '页面 ID' },
            limit: { type: 'number', description: '返回链接数量上限（默认 50）' },
          },
          required: ['pageId'],
        },
      },
    },
    handler: async (args) => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        const limit = (args.limit as number) || 50;
        const links = await slot.page.evaluate((max: number) => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors.slice(0, max).map(a => ({
            text: (a as HTMLAnchorElement).innerText.trim().slice(0, 100),
            href: (a as HTMLAnchorElement).href,
          }));
        }, limit);
        slot.lastAccess = Date.now();
        return JSON.stringify({ links });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 7. 关闭页面
  ctx.registerTool({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_close_page',
        description: '关闭指定的浏览器页面。',
        parameters: {
          type: 'object',
          properties: {
            pageId: { type: 'string', description: '要关闭的页面 ID' },
          },
          required: ['pageId'],
        },
      },
    },
    handler: async (args) => {
      const id = args.pageId as string;
      const slot = pages.get(id);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try { await slot.page.close(); } catch {}
      pages.delete(id);
      return JSON.stringify({ ok: true });
    },
  });

  // ── WebUI handlers ──

  (apply as any).__webuiHandlerFns = {
    async listPages() {
      return [...pages.entries()].map(([id, slot]) => ({
        id,
        title: slot.title || '(无标题)',
        url: slot.url,
        lastAccessText: new Date(slot.lastAccess).toLocaleString('zh-CN'),
      }));
    },
    async closePage(_ctx: Context, args: Record<string, unknown>) {
      const id = args.id as string;
      const slot = pages.get(id);
      if (!slot) return { error: '页面不存在' };
      try { await slot.page.close(); } catch {}
      pages.delete(id);
      return { ok: true };
    },
    async closeAll() {
      for (const [id, slot] of pages) {
        try { await slot.page.close(); } catch {}
        pages.delete(id);
      }
      return { ok: true };
    },
  };

  // ── 清理 ──

  ctx.on('dispose', async () => {
    for (const [, slot] of pages) {
      try { await slot.page.close(); } catch {}
    }
    pages.clear();
    if (browser) {
      try { await browser.close(); } catch {}
      browser = null;
    }
  });

  logger.info(`浏览器工具已启用 (headless=${config.headless}, maxPages=${config.maxPages})`);
}

// ──────────── webuiHandlers（闭包内需引用 pages，通过插件模块级代理） ────────────

export const webuiHandlers: PluginModule['webuiHandlers'] = {
  async listPages(_ctx) {
    // 通过事件通知获取运行时数据 — 由 apply 内部设置
    const fns = (apply as any).__webuiHandlerFns;
    return fns ? await fns.listPages() : [];
  },
  async closePage(ctx, args) {
    const fns = (apply as any).__webuiHandlerFns;
    return fns ? await fns.closePage(ctx, args) : { error: '插件未初始化' };
  },
  async closeAll(_ctx) {
    const fns = (apply as any).__webuiHandlerFns;
    return fns ? await fns.closeAll() : { error: '插件未初始化' };
  },
};

// ──────────── 辅助函数 ────────────

function resolveConfig(raw: Record<string, unknown>): BrowserConfig {
  return {
    headless: (raw.headless as boolean) ?? true,
    defaultTimeout: (raw.defaultTimeout as number) ?? 30000,
    viewportWidth: (raw.viewportWidth as number) ?? 1280,
    viewportHeight: (raw.viewportHeight as number) ?? 720,
    maxPages: (raw.maxPages as number) ?? 5,
    executablePath: (raw.executablePath as string) ?? '',
    maxContentLength: (raw.maxContentLength as number) ?? 50000,
    allowedProtocols: Array.isArray(raw.allowedProtocols) ? raw.allowedProtocols as string[] : ['http', 'https'],
    blockPrivate: (raw.blockPrivate as boolean | undefined) ?? true,
    allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts as string[] : [],
  };
}

/**
 * URL 安全校验：协议白名单 + 内网/本地封锁
 * @returns 错误描述字符串；null 表示通过
 */
function validateUrl(rawUrl: string, config: BrowserConfig): string | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return `URL 格式不合法: ${rawUrl}`; }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!config.allowedProtocols.includes(protocol)) {
    return `协议 "${protocol}" 不在允许列表 [${config.allowedProtocols.join(', ')}]`;
  }

  if (config.blockPrivate) {
    const host = parsed.hostname.toLowerCase();
    if (config.allowedHosts.includes(host)) return null; // 白名单跳过
    if (isPrivateOrLoopback(host)) {
      return `拒绝访问内网/本地地址 "${host}"（blockPrivate=true）`;
    }
  }
  return null;
}

function isPrivateOrLoopback(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;

  // IPv6
  if (host === '::1' || host === '[::1]') return true;
  if (host.startsWith('[fe80') || host.startsWith('[fc') || host.startsWith('[fd')) return true;
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    if (/^[0-9a-f:]+$/.test(host)) return true;
  }

  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 0) return true;
  return false;
}
