import { createHash } from 'node:crypto';
import { type AddressInfo, connect, createServer, isIP, type Socket } from 'node:net';
import { createProcessGateway, processService } from '@aalis/api-process';
import { createStorageGateway, storage as storageService } from '@aalis/api-storage';
import { tools as toolsService, wrapUntrustedContent } from '@aalis/api-tools';
// WebuiPage 一并带来 declaration merging：SchemaField 表单属性（allowCustom）
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import {
  type BoundOf,
  config as configService,
  definePlugin,
  type Logger,
  lifecycle as lifecycleService,
  logger as loggerService,
  optional,
} from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { assertAddressesSafe, assertPortAllowed, isPrivateHost, pinnedLookup } from '@aalis/util-network-guard';

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
  // biome-ignore lint/suspicious/noExplicitAny: puppeteer Page 类型动态导入，避免在顶层 import puppeteer 增加启动负担
  page: any; // puppeteer Page
  url: string;
  title: string;
  lastAccess: number;
}

// ──────────── 插件元数据 ────────────

const configSchema: ConfigSchema = {
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
    description: '同时打开的最大页面数量。超出后关闭最早打开的页面。',
  },
  executablePath: {
    type: 'string',
    label: 'Chrome 路径',
    description: '自定义 Chrome/Chromium 可执行文件路径。留空则使用 Puppeteer 内置 Chromium。',
    default: '',
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
  allowedProtocols: {
    type: 'multiselect',
    label: '允许的协议',
    default: ['http', 'https'],
    options: [
      { label: 'http', value: 'http' },
      { label: 'https', value: 'https' },
    ],
    description: '浏览器只允许访问这些协议的 URL。',
  },
  allowedHosts: {
    type: 'multiselect',
    label: '主机白名单',
    default: [],
    allowCustom: true,
    description: '允许访问的主机（含内网时需在此显式列出）。留空 = 仅按 blockPrivate 判定。',
  },
};

// ──────────── WebUI 页面 ────────────

const webuiPages: WebuiPage[] = [
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
        actions: [{ label: '关闭', method: 'closePage', confirm: '确定关闭该页面？' }],
        refresh: 15,
      },
      {
        type: 'actions',
        label: '操作',
        items: [{ label: '关闭所有页面', method: 'closeAll', confirm: '确定关闭所有页面？', danger: true }],
      },
    ],
  },
];

// ──────────── 插件入口 ────────────

// tools / webui-server 全部声明为 optional：登记面在提供者缺席时排队，上线后自动补挂，
// 不必把激活闸架在它们身上。storage 仅截图落盘用（不接图的调用方那一路），
// process 仅首次自动下载 Chrome 时用（execFile 走网关面，缺席则自动下载这步不可用）。
const uses = {
  config: configService,
  logger: loggerService,
  lifecycle: lifecycleService,
  tools: optional(toolsService),
  webui: optional(webuiServer),
  proc: optional(processService),
  storage: optional(storageService),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-tool-browser',
  displayName: '浏览器工具',
  subsystem: 'tools',
  configSchema,
  uses,
  apply: runBrowserTools,
});

function runBrowserTools(caps: Caps): void {
  const { tools, webui, lifecycle } = caps;
  const config = resolveConfig(caps.config);
  const logger = caps.logger.child('browser');
  const proc = createProcessGateway(caps.proc);
  const storage = createStorageGateway(caps.storage);

  // 注册 WebUI 页面
  for (const page of webuiPages) webui.registerPage(page);

  // biome-ignore lint/suspicious/noExplicitAny: puppeteer Browser 类型动态导入
  let browser: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: puppeteer Browser 类型动态导入
  let launching: Promise<any> | null = null;
  let gate: NetworkGate | null = null;
  const pages = new Map<string, PageSlot>();
  let pageCounter = 0;

  // ── 动态加载 puppeteer ──

  async function ensureChrome(): Promise<void> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const puppeteer = await import('puppeteer');
    const execPath = puppeteer.executablePath?.() ?? puppeteer.default?.executablePath?.();
    if (execPath && fs.existsSync(execPath)) return;

    logger.info('Chrome 未安装，正在自动下载...');
    // 通过 puppeteer 包路径找到其内置 CLI
    const puppeteerPkg = path.dirname((await import('node:url')).fileURLToPath(import.meta.resolve('puppeteer')));
    // 向上找到 puppeteer 包根目录（含 package.json）
    let pkgRoot = puppeteerPkg;
    while (!fs.existsSync(path.join(pkgRoot, 'package.json'))) {
      const parent = path.dirname(pkgRoot);
      if (parent === pkgRoot) break;
      pkgRoot = parent;
    }
    const cliPath = path.join(pkgRoot, 'lib', 'cjs', 'puppeteer', 'node', 'cli.js');
    // 走 ProcessService.execFile，避免直接 import node:child_process
    await proc.execFile(process.execPath, [cliPath, 'browsers', 'install', 'chrome'], {
      stdio: 'inherit',
      timeout: 300_000,
    });
    logger.info('Chrome 下载完成');
  }

  // biome-ignore lint/suspicious/noExplicitAny: puppeteer Browser 类型动态导入
  function ensureBrowser(): Promise<any> {
    // 只判句柄非空不够：Chromium 崩溃/被杀后句柄常驻，所有 browser_* 会永久失效到插件 bounce
    if (browser?.connected) return Promise.resolve(browser);
    // 单飞：并发的调用共用同一次启动，不各起一个 Chromium（后赋值的会盖掉前一个，前一个就没人关了）
    launching ??= launchBrowser().finally(() => {
      launching = null;
    });
    return launching;
  }

  // biome-ignore lint/suspicious/noExplicitAny: puppeteer Browser 类型动态导入
  async function launchBrowser(): Promise<any> {
    // 停用后才到的调用不再起闸与浏览器：onDispose 已经收过尾，这时起的东西没人关
    if (lifecycle.signal.aborted) throw new Error('浏览器工具已停用');
    // 重新启动时页面表一起清，否则列出的是已经不存在的死页面
    browser = null;
    pages.clear();
    // 仅 blockPrivate 时起网络闸（关掉即零开销、本地全通，便于 owner 测本地）。
    // 闸先于浏览器起好，起不来就不启动浏览器：浏览器不会在没有闸的情况下运行
    const gateArgs: string[] = [];
    if (config.blockPrivate) {
      try {
        gate ??= await openNetworkGate(config.allowedHosts, logger);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`浏览器网络闸启动失败: ${msg}`);
        throw new Error(`浏览器网络闸启动失败，未启动浏览器: ${msg}`);
      }
      gateArgs.push(
        `--proxy-server=socks5://127.0.0.1:${gate.port}`,
        // Chrome 默认让 localhost、回环与链路本地地址绕过代理，<-loopback> 撤掉这条默认，它们同样经闸
        '--proxy-bypass-list=<-loopback>',
        // WebRTC 的 UDP 不走代理：只许它经代理连接（即只剩经闸的 TCP）
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      );
    }
    let instance: import('puppeteer').Browser;
    try {
      if (!config.executablePath) {
        await ensureChrome();
      }
      const puppeteer = await import('puppeteer');
      const launchFn = puppeteer.default?.launch ?? puppeteer.launch;
      instance = await launchFn({
        headless: config.headless,
        defaultViewport: { width: config.viewportWidth, height: config.viewportHeight },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...gateArgs],
        ...(config.executablePath ? { executablePath: config.executablePath } : {}),
        // 单条 CDP 命令的时限（puppeteer 默认 180 秒）。正常操作里最长的单条命令是等选择器与导航，都受 defaultTimeout 约束；
        // 取它的两倍，让操作自己的超时先报，挂住的命令以此为上限。defaultTimeout 为 0（不设时限）时它也是 0，同样不设时限
        protocolTimeout: config.defaultTimeout * 2,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`启动浏览器失败: ${msg}`);
      throw new Error(`浏览器启动失败: ${msg}。请确保已安装 Chrome: npx puppeteer browsers install chrome`);
    }
    // 启动期间插件被停用：onDispose 只关得到已交出的实例，这一代在这里关掉。
    // 不等关闭落定：onDispose 要等这次启动落定才关闸，关闭挂住会把闸一起拖住
    if (lifecycle.signal.aborted) {
      instance
        .close()
        .catch(err => logger.warn(`停用时关闭新启动的浏览器失败: ${err instanceof Error ? err.message : String(err)}`));
      throw new Error('浏览器工具已停用');
    }
    browser = instance;
    instance.on('disconnected', () => {
      // 只清自己那一代：迟到的旧实例事件不能把刚起来的新实例与它的页面一起清掉
      if (browser !== instance) return;
      browser = null;
      pages.clear();
    });
    logger.info('浏览器已启动');
    return browser;
  }

  /**
   * 关掉这一代浏览器，不等关闭落定（浏览器进程本身卡住时，puppeteer 在 protocolTimeout 后强杀进程），
   * 页面表一起清，下次调用重新启动。挂着的 CDP 调用随连接断开失败，它们持有的锁随之释放
   */
  // biome-ignore lint/suspicious/noExplicitAny: puppeteer Browser 类型动态导入
  function retireBrowser(instance: any, reason: string): void {
    // 已不是当前这一代（崩溃后已重启、已被关掉）：它的页面已不在表里，关闭也不归这里
    if (browser !== instance) return;
    browser = null;
    pages.clear();
    logger.warn(`${reason}，关闭这一代浏览器，下次调用时重新启动`);
    instance
      .close()
      .catch((err: unknown) => logger.warn(`关闭浏览器失败: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * 截图（含切前台与找元素）的时限，取 defaultTimeout；为 0 时不设时限，与 puppeteer 对 0 的约定一致。
   * 截图卡住（如渲染进程卡死）时底层调用一直挂着，并持有浏览器级的锁，同一浏览器里开新页、关页面与别的截图
   * 都排在它后面，所以时限一到就关掉这一代浏览器，而不只是让这次调用先失败
   */
  async function withScreenshotTimeout<T>(slot: PageSlot, capture: Promise<T>): Promise<T> {
    if (!config.defaultTimeout) return capture;
    const instance = slot.page.browser();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        retireBrowser(instance, `截图超过 ${config.defaultTimeout}ms 未完成`);
        reject(
          new Error(
            `截图超过 ${config.defaultTimeout}ms 未完成，已关闭浏览器，全部页面随之关闭；下次调用时重新启动，需重新 browser_navigate 打开页面`,
          ),
        );
      }, config.defaultTimeout);
    });
    try {
      return await Promise.race([capture, timeout]);
    } finally {
      clearTimeout(timer);
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
        try {
          await pages.get(oldest)!.page.close();
        } catch {}
        pages.delete(oldest);
      }
    }

    const b = await ensureBrowser();
    // 每页独占一个窗口：同一窗口里的标签页会互相压到后台，而后台页上的点击等操作会一直挂住（见 browser_click）
    const page = await b.newPage({ type: 'window' });
    page.setDefaultTimeout(config.defaultTimeout);
    const newId = `page_${++pageCounter}`;
    const slot: PageSlot = { page, url: 'about:blank', title: '', lastAccess: Date.now() };
    pages.set(newId, slot);
    return { id: newId, slot };
  }

  // ── 截断文本 ──

  function truncate(text: string): string {
    if (text.length <= config.maxContentLength) return text;
    return `${text.slice(0, config.maxContentLength)}\n... [内容已截断，共 ${text.length} 字符]`;
  }

  // ── 注册工具分组 ──

  tools.registerGroup({
    name: 'browser',
    label: '浏览器',
    description: '使用 Puppeteer 无头浏览器进行网页导航、内容提取、截图等操作',
  });

  // ── 注册工具 ──

  // 1. 导航 (navigate)
  tools.register({
    groups: ['browser'],
    // 浏览器页面池是**进程级共享**、取页时不校验会话归属：拿到 pageId 就能操作
    // 别人（含 owner）打开的页面，那页面可能带着登录态。写类浏览器操作一律 sensitive(L1)。
    // 导航本身有 SSRF 闸（入口 isPrivateHost 快判 + 浏览器网络闸），但仍会占用与复用共享页面槽位。
    risk: 'sensitive',
    definition: {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: '在浏览器中打开指定 URL。返回页面标题和文本内容摘要。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要访问的 URL' },
            pageId: { type: 'string', description: '页面 ID（可选，复用已有页面）' },
            waitFor: { type: 'string', description: '等待的 CSS 选择器（可选）' },
          },
          required: ['url'],
        },
      },
    },
    handler: async args => {
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
        slot.title = (await slot.page.title()).slice(0, 300); // 截断防超长 <title> 夹带注入
        const text = await slot.page.evaluate(() => document.body?.innerText ?? '');
        return JSON.stringify({
          pageId: id,
          title: slot.title,
          url: slot.url,
          text: wrapUntrustedContent(truncate(text), `网页 ${slot.url}`),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 起了网络闸时，闸的拒绝与目标连不上在浏览器侧是同一个错误码，补一句说明
        return JSON.stringify({
          error:
            config.blockPrivate && msg.includes('net::ERR_SOCKS_CONNECTION_FAILED')
              ? `${msg}（浏览器网络闸未接通：目标是内网或本机地址时被 blockPrivate 拦截，目标无法解析或无法连接时也报此错）`
              : msg,
        });
      }
    },
  });

  // 2. 获取页面文本
  tools.register({
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
    handler: async args => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        let text: string;
        if (args.selector) {
          text = await slot.page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            return el?.innerText ?? `未找到元素: ${sel}`;
          }, args.selector as string);
        } else {
          text = await slot.page.evaluate(() => document.body?.innerText ?? '');
        }
        slot.lastAccess = Date.now();
        return JSON.stringify({ text: wrapUntrustedContent(truncate(text), `网页 ${slot.url}`) });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 3. 点击元素
  tools.register({
    groups: ['browser'],
    // 对共享页面池里的任意页面点击——见 browser_navigate 处的说明。
    risk: 'sensitive',
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
    handler: async args => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        // 页面自己开出的窗口或标签页会把它压到后台，后台页不跑渲染，puppeteer 的点击等它进入视口会一直挂住
        await slot.page.bringToFront();
        await slot.page.click(args.selector as string);
        await slot.page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        slot.url = slot.page.url();
        slot.title = (await slot.page.title()).slice(0, 300); // 截断防超长 <title> 夹带注入
        slot.lastAccess = Date.now();
        return JSON.stringify({ ok: true, url: slot.url, title: slot.title });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 4. 输入文本
  tools.register({
    groups: ['browser'],
    // 向共享页面池里的任意页面输入文本（可能是他人已登录的表单）。
    risk: 'sensitive',
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
    handler: async args => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        const selector = args.selector as string;
        await slot.page.bringToFront(); // 同 browser_click
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
  tools.register({
    groups: ['browser'],
    definition: {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description:
          '对当前浏览器页面截图。PNG 一律落盘，结果里恒带 storage_uri，可交给看图工具（如有）查看或用 send_attachment 发送；你能看图时截图同时随结果呈现给你。',
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
    handler: async (args, callCtx) => {
      const slot = pages.get(args.pageId as string);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        const buffer: Buffer | null = await withScreenshotTimeout(
          slot,
          (async () => {
            await slot.page.bringToFront(); // 同 browser_click：按选择器截图同样先等元素进入视口
            if (!args.selector) {
              return slot.page.screenshot({ fullPage: args.fullPage === true, encoding: 'binary' });
            }
            const el = await slot.page.$(args.selector as string);
            return el ? el.screenshot({ encoding: 'binary' }) : null;
          })(),
        );
        if (!buffer) return JSON.stringify({ error: `未找到元素: ${args.selector}` });
        slot.lastAccess = Date.now();
        const png = Buffer.from(buffer);
        // 交付形态（定死）：base64 绝不进 content——整张 PNG 的 base64 有几十万字符，
        // 模型看不到图，还会灌满上下文并落进历史。所以一律先落盘 tmp 根拿 URI，
        // content 恒带 storage_uri；调用方接得住图（agent 工具循环）时再把图随结果附上，
        // note 按两条路分别写实：接得住写「图已随结果附上」，接不住写「图未随结果附上」。
        // 文件名取内容 sha256 前 16 位：同一张图重截复用同一文件，零增量。
        // 只有落盘失败才退回只给 images。base64 只在真要交图的分支上现算。
        const digest = createHash('sha256').update(png).digest('hex').slice(0, 16);
        const safeSession = (callCtx.sessionId || 'unknown').replace(/[:/\\]/g, '_');
        const uri = `tmp:/browser/${safeSession}/shot-${digest}.png`;
        let storedUri: string | undefined;
        try {
          await storage.writeFile(uri, png);
          storedUri = uri;
        } catch (err) {
          logger.warn(`截图落盘失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (storedUri) {
          const meta = { ok: true, url: slot.url, size: png.length, storage_uri: storedUri };
          if (callCtx.acceptsImages) {
            return {
              content: JSON.stringify({
                ...meta,
                note: '图已随结果附上；若你看不到图，可把 storage_uri 交给看图工具（如有）或 send_attachment',
              }),
              images: [`data:image/png;base64,${png.toString('base64')}`],
            };
          }
          return JSON.stringify({
            ...meta,
            note: '图未随结果附上，可把 storage_uri 交给看图工具（如有）查看或 send_attachment 发送',
          });
        }
        if (callCtx.acceptsImages) {
          return {
            content: JSON.stringify({
              ok: true,
              url: slot.url,
              size: png.length,
              note: '截图落盘失败，图仅在本回合随结果呈现；历史中不保留图片本身，需要时重新截图',
            }),
            images: [`data:image/png;base64,${png.toString('base64')}`],
          };
        }
        return JSON.stringify({ error: '截图落盘失败，且调用方接不住图片' });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 6. 获取页面链接列表
  tools.register({
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
    handler: async args => {
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
        return JSON.stringify({ links: wrapUntrustedContent(JSON.stringify(links), `网页 ${slot.url}`) });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 7. 关闭页面
  tools.register({
    groups: ['browser'],
    // 关闭他人正在用的页面。
    risk: 'sensitive',
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
    handler: async args => {
      const id = args.pageId as string;
      const slot = pages.get(id);
      if (!slot) return JSON.stringify({ error: '页面不存在' });
      try {
        await slot.page.close();
      } catch {}
      pages.delete(id);
      return JSON.stringify({ ok: true });
    },
  });

  // ── WebUI 页面动作 ──

  webui.registerAction('listPages', async () =>
    [...pages.entries()].map(([id, slot]) => ({
      id,
      title: slot.title || '(无标题)',
      url: slot.url,
      lastAccessText: new Date(slot.lastAccess).toLocaleString('zh-CN'),
    })),
  );

  webui.registerAction('closePage', async args => {
    const id = args.id as string;
    const slot = pages.get(id);
    if (!slot) return { error: '页面不存在' };
    try {
      await slot.page.close();
    } catch {}
    pages.delete(id);
    return { ok: true };
  });

  webui.registerAction('closeAll', async () => {
    for (const [id, slot] of pages) {
      try {
        await slot.page.close();
      } catch {}
      pages.delete(id);
    }
    return { ok: true };
  });

  // ── 清理 ──

  lifecycle.onDispose(async () => {
    // 在途的启动先落定：它看到信号已断会自己关掉那一代浏览器；它的失败已经交给发起它的那次工具调用
    await launching?.catch(() => {});
    // 闸先关，不排在页面与浏览器的关闭后面（那两步没有时限，挂住时闸就一直开着）。
    // 浏览器固定经闸连网，闸关了连接即失败，不会改为直连
    await gate?.close();
    gate = null;
    for (const [, slot] of pages) {
      try {
        await slot.page.close();
      } catch {}
    }
    pages.clear();
    if (browser) {
      try {
        await browser.close();
      } catch {}
      browser = null;
    }
  });

  logger.info(`浏览器工具已启用 (headless=${config.headless}, maxPages=${config.maxPages})`);
}

// ──────────── 辅助函数 ────────────

function resolveConfig(raw: Readonly<Record<string, unknown>>): BrowserConfig {
  return {
    headless: (raw.headless as boolean) ?? true,
    defaultTimeout: (raw.defaultTimeout as number) ?? 30000,
    viewportWidth: (raw.viewportWidth as number) ?? 1280,
    viewportHeight: (raw.viewportHeight as number) ?? 720,
    maxPages: (raw.maxPages as number) ?? 5,
    executablePath: (raw.executablePath as string) ?? '',
    maxContentLength: (raw.maxContentLength as number) ?? 50000,
    allowedProtocols: Array.isArray(raw.allowedProtocols) ? (raw.allowedProtocols as string[]) : ['http', 'https'],
    blockPrivate: (raw.blockPrivate as boolean | undefined) ?? true,
    allowedHosts: Array.isArray(raw.allowedHosts) ? (raw.allowedHosts as string[]) : [],
  };
}

/**
 * URL 安全校验：协议白名单 + 内网/本地封锁
 * @returns 错误描述字符串；null 表示通过
 */
function validateUrl(rawUrl: string, config: BrowserConfig): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `URL 格式不合法: ${rawUrl}`;
  }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!config.allowedProtocols.includes(protocol)) {
    return `协议 "${protocol}" 不在允许列表 [${config.allowedProtocols.join(', ')}]`;
  }

  if (config.blockPrivate) {
    const host = parsed.hostname.toLowerCase();
    if (config.allowedHosts.includes(host)) return null; // 白名单跳过
    // 仅字符串级快判（不做 DNS 解析）；DNS 级判定由浏览器网络闸（openNetworkGate）负责。
    if (isPrivateHost(host)) {
      return `拒绝访问内网/本地地址 "${host}"（blockPrivate=true）`;
    }
  }
  return null;
}

// ── SSRF 闸：浏览器的全部连接经本进程的网络闸 ──

interface NetworkGate {
  readonly port: number;
  /** 停止监听并断开全部在途连接 */
  close(): Promise<void>;
}

const SOCKS_SUCCESS = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
/** 失败应答一律回「一般性失败」：浏览器对任何失败应答都报 net::ERR_SOCKS_CONNECTION_FAILED */
const SOCKS_FAILURE = Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
/** 问候与请求须在这个时限内收齐，否则断开：只连不发的连接不能一直占着闸 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 在 127.0.0.1 的随机端口起浏览器网络闸：浏览器经 `--proxy-server` 把全部 TCP 连接交给它，页面、弹出窗口、
 * 各类 worker 的 http(s) 请求、重定向的每一跳与 WebSocket 都在内。只实现浏览器用到的那部分 SOCKS5：无认证 + CONNECT，
 * 目标只收域名形式（ATYP=3）——Chrome 一律以这种形式交出目标，IP 字面量也是（IPv6 不带方括号、已是规范写法）。
 *
 * 端口先经 assertPortAllowed 判定，allowedHosts 里的主机也不例外。主机判定沿用 validateUrl 的 blockPrivate + allowedHosts：
 * allowedHosts 里的主机按名字直连；IP 字面量须是规范写法，再经 assertAddressesSafe 判定；域名经 pinnedLookup 解析并判定
 * 全部地址，连接只用这次解析的结果，堵住 DNS 重绑定（判定时解析到公网、连接时再解析到内网）。判定遵循进程级网络策略
 * （blockPrivate、denyCidrs 与 allowedPorts）；判定不过、解析失败或连不上都回失败应答。
 */
async function openNetworkGate(allowedHosts: readonly string[], logger: Logger): Promise<NetworkGate> {
  const sockets = new Set<Socket>();
  const track = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // 接通后的连接层错误（对端重置等）随 close 拆掉两端，浏览器侧以网络错误呈现
    socket.on('error', () => {});
    return socket;
  };

  function openUpstream(host: string, port: number): Socket {
    assertPortAllowed(port);
    const family = isIP(host);
    // allowedHosts 与 validateUrl 同一写法比较：IPv6 字面量带方括号
    if (allowedHosts.includes(family === 6 ? `[${host}]` : host)) return connect({ host, port });
    if (family) {
      // 判定按规范写法认段：0::1、带 zone id 的 ::1%lo0 会被判成公网，连接却照样到 ::1。Chrome 交出的都是规范写法
      if (family === 6 && (host.includes('%') || new URL(`http://[${host}]`).hostname !== `[${host}]`)) {
        throw new Error(`IPv6 字面量不是规范写法: ${host}`);
      }
      assertAddressesSafe(host, [host]);
      return connect({ host, port });
    }
    return connect({ host, port, lookup: pinnedLookup });
  }

  function serve(client: Socket): void {
    let buf = Buffer.alloc(0);
    let greeted = false;
    // 问候与请求限时收齐；请求收齐即清掉，接通后的连接不受这个时限约束
    const handshake = setTimeout(() => client.destroy(), HANDSHAKE_TIMEOUT_MS);
    client.once('close', () => clearTimeout(handshake));
    // 回失败应答后关闭连接：写完即销毁，不等对端关写端，否则对端不关时连接会半开留到停用
    const refuse = (reply: Buffer): void => {
      client.off('data', onData);
      client.end(reply, () => client.destroy());
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (!greeted) {
        // 问候：VER NMETHODS METHODS…，只接受无认证（0x00）
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        if (buf[0] !== 5 || !buf.subarray(2, 2 + buf[1]).includes(0)) {
          refuse(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 0]));
        buf = buf.subarray(2 + buf[1]);
        greeted = true;
      }
      // 请求：VER CMD RSV ATYP LEN HOST PORT，只接受 CONNECT + 域名形式
      if (buf.length < 5) return;
      if (buf[0] !== 5 || buf[1] !== 1 || buf[3] !== 3) {
        refuse(SOCKS_FAILURE);
        return;
      }
      if (buf.length < 7 + buf[4]) return;
      clearTimeout(handshake);
      client.off('data', onData);
      client.pause();
      const host = buf.toString('latin1', 5, 5 + buf[4]);
      const port = buf.readUInt16BE(5 + buf[4]);
      // 与请求同包到达、排在请求之后的数据，接通后先交给上游再接上转发
      const early = buf.subarray(7 + buf[4]);
      const fail = (err: unknown): void => {
        logger.debug(`浏览器网络闸未接通 ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`);
        refuse(SOCKS_FAILURE);
      };
      let upstream: Socket;
      try {
        upstream = track(openUpstream(host, port));
      } catch (err) {
        fail(err);
        return;
      }
      // 浏览器先断开时（解析或连接还在途）一并销毁上游，不让它迟到接通后悬空
      client.once('close', () => upstream.destroy());
      upstream.once('error', fail);
      upstream.once('connect', () => {
        upstream.off('error', fail);
        upstream.once('close', () => client.destroy());
        client.write(SOCKS_SUCCESS);
        if (early.length > 0) upstream.write(early);
        client.pipe(upstream).pipe(client);
      });
    };
    client.on('data', onData);
  }

  const server = createServer(client => serve(track(client)));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', err => logger.warn(`浏览器网络闸出错: ${err.message}`));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
