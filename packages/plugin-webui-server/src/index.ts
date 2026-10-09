// node:fs/node:path 仅用于发现前端 dist 静态目录（位于工作区外部），
// 已在 biome.json noRestrictedImports 中作为基础设施例外列出。

import { Buffer } from 'node:buffer';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvals } from '@aalis/api-approval';
import { commands } from '@aalis/api-commands';
import { contributions } from '@aalis/api-contributions';
import { hostConfig } from '@aalis/api-host-config';
import { hostPaths } from '@aalis/api-host-paths';
import { llm, type ModelRef, resolveLLMModel } from '@aalis/api-llm';
import { messageArchive } from '@aalis/api-message-archive';
import { packageManager } from '@aalis/api-package-manager';
import {
  aggregatePlatformDetails,
  getPlatformAdapters,
  getPlatformNames,
  type PlatformConnection,
  platform,
  sessionTypesOf,
} from '@aalis/api-platform';
import { pluginSource } from '@aalis/api-plugin-source';
import { createProcessGateway, processService } from '@aalis/api-process';
import { rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { sessionProtocol } from '@aalis/api-session-protocol';
import { createStorageGateway, isStorageUri, storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import {
  type ErrorResponse,
  type OptionDetail,
  type PluginTheme,
  parseTheme,
  type ServiceListResponse,
  type WebUIService,
  webuiClient,
  webuiServer,
} from '@aalis/api-webui';
import {
  appService,
  type BoundOf,
  config,
  definePlugin,
  events,
  type LogEntry,
  LogHub,
  lifecycle,
  logger,
  optional,
  pluginsService,
  provide,
  type ServiceView,
  services,
} from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import {
  type Message,
  type OutgoingMessage,
  outboundMediaMessage,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '@aalis/schema-message';
import express from 'express';
import { type WebSocket, WebSocketServer } from 'ws';
import { ADMIN_PATH, createAdminChannel } from './admin-channel.js';
import { blockedStatus, createAttention } from './attention.js';
import { createAuthSystem, openBrowser, originAllowed } from './auth.js';
import { collectLocalPackageDeps, type DiscoveryEnv, discoverClients, pickFreshClients } from './client-discovery.js';
import { CLIENT_SWITCH_SCRIPT, renderClientSwitchPage } from './client-switch-page.js';
import { createRouteGate } from './gate.js';
import { createLayoutStore } from './layout.js';
import { logMatcher, parseLogFilter, readLogs } from './logs.js';
import { createPageFiles } from './page-files.js';
import { createPageRegistry } from './pages.js';
import { route } from './route.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFrameRoutes } from './routes/frames.js';
import { localPackageLookup, registerMarketplaceRoutes } from './routes/marketplace.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerPluginRoutes, saveAfterApply } from './routes/plugins.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { acceptSessionSocket, SESSION_PATH } from './session-transport.js';
import { createWsHeartbeat } from './ws-heartbeat.js';

/**
 * 工具 / 指令 / 工具组 description 约定：首行 = 人类可读摘要，其余 = 给 agent 的长使用指南。
 * WebUI 管理页只展示首行摘要（避免倾倒整段指南）；完整 description 仍由工具/指令定义抵达 LLM。
 */
function descSummary(d?: string): string | undefined {
  if (!d) return d;
  const s = d.split('\n')[0].trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** 可选项接口的 dependency 查询参数当模型引用读（llm-ref 的取值，JSON）：没带为 undefined，写法不对为 null */
function modelRefOf(raw: unknown): ModelRef | undefined | null {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { provider, model } = value as Record<string, unknown>;
  return (provider === undefined || typeof provider === 'string') && (model === undefined || typeof model === 'string')
    ? { provider, model }
    : null;
}

// ===== 插件元数据 =====

const name = '@aalis/plugin-webui-server';

// 按宿主身份记打开记录：插件 bounce 保留，新 App 独立；弱引用不延长宿主寿命。
const browserOpenedFor = new WeakSet<object>();

/**
 * fixed 模式的 token 最短长度。持有 token 就是 owner，带 cookie 的请求又不限速（见 auth.ts 的登录限速），
 * 防猜靠的是 token 本身够长：32 个十六进制字符是 128 位
 */
const FIXED_TOKEN_MIN_LENGTH = 32;

/** 文档级 CSP */
const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const configSchema = defineConfig({
  port: {
    type: 'number',
    label: '端口',
    default: 3000,
    integer: true,
    min: 0,
    max: 65535,
    onInvalid: 'error',
    description: 'Web 管理界面的 HTTP 端口',
  },
  host: {
    type: 'string',
    label: '监听地址',
    default: '127.0.0.1',
    pattern: '\\S',
    onInvalid: 'error',
    description: '绑定的 IP 地址，0.0.0.0 可对外访问',
  },
  autoOpen: {
    type: 'boolean',
    label: '启动时自动打开浏览器',
    default: true,
    onInvalid: 'error',
    description:
      '每次应用启动后首次监听成功时打开默认浏览器；同一应用内沿用 token 的插件重载不重复打开，重新生成 token 时再次打开以便登录。SSH/headless 环境建议关闭',
  },
  tokenMode: {
    type: 'select',
    label: 'Token 策略',
    default: 'persist',
    onInvalid: 'error',
    secret: false,
    options: [
      { label: '每次启动随机生成（重启即轮换）', value: 'ephemeral' },
      { label: '首次生成后持久化（重启不掉登录）', value: 'persist' },
      { label: '使用下方固定 token', value: 'fixed' },
    ],
    description:
      'ephemeral=每次启动随机；persist=token 写入 data:/webui/token，读取复用；fixed=使用 fixedToken 字段。所有模式都会写出便利文件 data:/webui/access.txt 含访问 URL。',
  },
  fixedToken: {
    type: 'string',
    label: '固定 Token（仅 tokenMode=fixed 生效）',
    default: '',
    onInvalid: 'error',
    secret: true,
    description: `至少 ${FIXED_TOKEN_MIN_LENGTH} 个字符的随机字符串（去掉首尾空白后计），短了插件不启动；留空按 persist 处理。存进 secrets.yaml，WebUI 不回显。`,
  },
  marketplaceRegistry: {
    type: 'string',
    label: '插件市场 npm 源',
    default: 'https://registry.npmjs.org',
    onInvalid: 'error',
    description:
      '插件市场检索用的 npm registry 基址。注意 npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），默认官方源；国内可填支持 search 的镜像或代理。安装走 package-manager（遵循本机 npm 配置），卡片上的最新版与可更新也按安装使用的源查。',
  },
  // 活跃前端不在此配置：前端即 `webui-client` 服务的多 provider，活跃者由「服务偏好」
  // （servicePreferences['webui-client']）决定——在 WebUI 设置「系统」的服务偏好里切换。
});

// ===== 配置 =====

type WebUIConfig = ConfigOf<typeof configSchema>;

// ===== WebUI 会话的收件箱 =====

/**
 * 发往 WebUI 自己会话的出站消息里，要由本插件写进会话历史的部分。WebUI 的收件箱就是会话历史，记不记全不取决于
 * 别的插件是否在场。agent 的文字回复由 agent 存档，这里不再记，免得历史里重复。其余部分：
 * - 不是她说的文字（系统提示、指令回复、宿主通知）记成事件标记：回看时显示成分隔条，不进模型上下文，与其他平台一致；
 * - 图片、视频、音频用 outboundMediaMessage 记，回看时还原成附件；
 * - 给的是存储地址的文件（插件发出的成品等）同样用 outboundMediaMessage 记，描述位记文件名，会话服务据此签发下载句柄。
 *   metadata 另记原样的地址与文件名（登记的键 SentRef、SentName）：占位符里的地址遇到「]」会截断，描述位的「]」「|」换成了全角。这样的文件以
 *   「[文件: 名称 | ref:…]」进模型上下文与记忆，不看全局出站归档记不记文件。不是存储地址的文件
 *   （网址、data URL）签不出句柄，记成事件标记「[文件] 名称」，内容不进历史；
 * - 快照里的 data 未经平台改写，就是页面上显示的那份，直接记它。带 skipArchive 的（history_ref 重发）原图已在
 *   历史里，不再记。她发出的媒体在别的平台由全局出站归档在 outbound:delivered 上记；发往 WebUI 的由这里记，
 *   outbound:delivered 的快照给附件标上 skipArchive，免得全局出站归档再记一份。代价是这些网址图片与视频不再由
 *   全局出站归档在后台补视觉描述
 */
function inboxRecords(msg: OutgoingMessage): Message[] {
  const timestamp = Date.now();
  const marker = (content: string): Message => ({
    role: 'system',
    kind: WellKnownKinds.EventMarker,
    content,
    timestamp,
  });
  const records: Message[] = [];
  if (msg.source !== 'agent' && msg.content.trim()) records.push(marker(msg.content));
  for (const att of msg.attachments ?? []) {
    if (att.skipArchive) continue;
    if (att.kind !== 'file') {
      records.push({
        ...outboundMediaMessage(att.kind, att.data, att.description),
        timestamp,
        metadata: { [WellKnownMetadataKeys.Source]: 'webui-server', [WellKnownMetadataKeys.SentRef]: att.data },
      });
    } else if (isStorageUri(att.data)) {
      records.push({
        ...outboundMediaMessage('file', att.data, att.name),
        timestamp,
        metadata: {
          [WellKnownMetadataKeys.Source]: 'webui-server',
          [WellKnownMetadataKeys.SentRef]: att.data,
          [WellKnownMetadataKeys.SentName]: att.name,
        },
      });
    } else {
      records.push(marker(`[文件] ${att.name ?? att.data.split('/').pop()}`));
    }
  }
  return records;
}

// ===== 插件入口 =====

/**
 * 本地包扫描目录：安装集（host-paths 的 `app`）下的 `packages/` 与 `node_modules/@aalis`，与插件加载器读的是同一处。
 * 宿主不提供 host-paths 时没有可扫的目录。
 *
 * **不可按本文件位置推算**（如 `resolve(dirname(import.meta.url), '../../')`）：那是个位置
 * 假设，只在 webui-server 恰好躺在 `<根>/packages/<包>/dist` 时成立。装进用户项目后它解析成
 * `<proj>/node_modules/@aalis`，与第二条重合、退化成同一目录扫两遍，而**用户自己的
 * `packages/` 从来不在范围内** —— 「私有插件放 packages/、第三方插件从 npm 装」这种混合
 * 形态下，本地插件在市场里将不可见。
 */
function localScanDirs(appDir: string | undefined): string[] {
  return appDir ? [join(appDir, 'packages'), join(appDir, 'node_modules', '@aalis')] : [];
}

// storage 等一律 optional：webui 是管理面，任何被管对象缺席都只该让对应页面降级，不该把
// 整个控制台拖进 pending。storage 尤其不能 required——storage 的提供者 bounce 会让它
// 暂时消失，webui-server 跟着重启会断开所有连接、清空页面登记表（登记门面随后重挂）。
const uses = {
  events,
  logger,
  lifecycle,
  config,
  provide,
  services,
  hostConfig: optional(hostConfig),
  paths: optional(hostPaths),
  app: optional(appService),
  plugins: optional(pluginsService),
  source: optional(pluginSource),
  packageManager: optional(packageManager),
  storage: optional(storage),
  commands: optional(commands),
  // platform 既被本插件提供又被平台页枚举：required 会让激活等一个由自己提供的服务
  platform: optional(platform),
  process: optional(processService),
  /** /session 的连接接到它；每条连接到达时现取，不在时关闭连接并写明原因。会话文件的下载请它核验句柄 */
  sessionProtocol: optional(sessionProtocol),
  /** 登记 webui 审批面：/session 连接上的在场上报与应答记在这个登记身份名下。推出未结的审批进「需要处理」 */
  approvals: optional(approvals),
  /** 会话面板：调用前核会话存在、按会话种类判断适用的页面 */
  sessions: optional(sessionManager),
  tools: optional(tools),
  llm: optional(llm),
  // 发往 WebUI 自己会话的出站消息由本插件写进会话历史（见 inboxRecords）
  archive: optional(messageArchive),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name,
  displayName: 'WebUI 服务端',
  subsystem: 'platform',
  configSchema,
  provides: [webuiServer, platform],
  uses,
  apply: startWebuiServer,
});

async function startWebuiServer(caps: Caps): Promise<void> {
  const { events, logger, lifecycle, provide, services } = caps;
  const cfg = parseConfig(configSchema, caps.config, logger);
  const uiConfig: WebUIConfig = {
    ...cfg,
    marketplaceRegistry: cfg.marketplaceRegistry.trim() || configSchema.marketplaceRegistry.default,
  };
  if (!URL.canParse(uiConfig.marketplaceRegistry)) throw configError('marketplaceRegistry 不是有效 URL');

  // 创建 storage gateway；所有文件读写（token、访问凭据、日志、媒体与会话文件）都走这里
  const storage = createStorageGateway(caps.storage);

  // ---- Token 解析 ----
  // - ephemeral：每次启动随机生成（旧行为）
  // - persist：首次生成后写入 storage data:/webui/token，重启复用（默认）
  // - fixed：使用 fixedToken 配置项，至少 FIXED_TOKEN_MIN_LENGTH 个字符；为空时降级为 persist
  // 所有模式都会写出 data:/webui/access.txt 便于查找访问 URL
  const tokenFileUri = 'data:/webui/token';
  const accessFileUri = 'data:/webui/access.txt';
  const fixedToken = uiConfig.tokenMode === 'fixed' ? uiConfig.fixedToken.trim() : '';
  if (fixedToken && fixedToken.length < FIXED_TOKEN_MIN_LENGTH) {
    throw configError(`fixedToken 至少要 ${FIXED_TOKEN_MIN_LENGTH} 个字符（现在 ${fixedToken.length} 个）`);
  }
  let authToken = fixedToken || Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  /** 监听成功后的访问 URL；持久化 token 晚于监听读回时，据此重写 access.txt */
  let listeningUrl: string | undefined;

  /** 返回是否真的写成了：调用方据此决定能不能宣称「凭据已写入」 */
  async function writeAccessFile(url: string, token: string): Promise<boolean> {
    const lines = [
      '# Aalis WebUI 访问凭据（自动生成）',
      `# 生成时间: ${new Date().toISOString()}`,
      `# Token 模式: ${uiConfig.tokenMode}`,
      '',
      `URL: ${url}`,
      `Token: ${token}`,
      `一键登录: ${url}?token=${token}`,
      '',
      '# 提示：将该一键登录链接粘贴到浏览器即可自动设置 cookie',
    ];
    try {
      await storage.writeFile(accessFileUri, `${lines.join('\n')}\n`);
      return true;
    } catch (err) {
      logger.warn(`写入访问文件失败: ${(err as Error).message}`);
      return false;
    }
  }

  // persist 的读回跟随 storage：storage 是 optional、不参与激活拓扑，可能晚于本插件上线
  // （加载顺序、启动时配置出错后修好、运行时才启用）。只在 apply 里读一次会读空：内存里是新随机
  // token，持久化的那份不生效，已登录的浏览器全部被登出；没有 token 文件时也永远建不起来。
  // follow 对已在线的 storage 同步首挂，晚上线时补读。持久化的那份优先（浏览器里 30 天的 cookie
  // 就是它）；只认第一次成功，之后 storage 换人不再换 token。
  let tokenSettled = uiConfig.tokenMode === 'ephemeral' || fixedToken !== '';
  // token 重新生成后旧页面失效，即使同一 App 已打开过，也要给出新的登录页。
  let tokenFresh = fixedToken === '';
  let tokenLoading: Promise<void> | undefined;
  caps.storage.follow(() => {
    if (tokenSettled) return;
    tokenLoading = (async () => {
      try {
        const raw = await storage.readFile(tokenFileUri, 'utf-8');
        const existing = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
        if (existing) {
          tokenSettled = true;
          tokenFresh = false;
          if (existing !== authToken) {
            authToken = existing;
            if (listeningUrl) void writeAccessFile(listeningUrl, authToken);
          }
          return;
        }
      } catch {
        /* 不存在或读不了 */
      }
      try {
        await storage.writeFile(tokenFileUri, authToken);
        tokenSettled = true;
      } catch (err) {
        logger.warn(`持久化 token 失败，本次仍可使用但重启会再生成: ${(err as Error).message}`);
      }
    })();
  });
  // storage 已在线时 follow 是同步首挂：等读回完成再继续，认证从第一个请求起就用持久化的 token
  if (tokenLoading) await tokenLoading;
  const auth = createAuthSystem(() => authToken);

  const expressApp = express();
  // 文档级 CSP：脚本只许同源，样式放开内联（Mermaid 的输出带内联样式），图片只认同源与本地生成的；不许被别的页面嵌入。
  // 每个响应都带上，前端的 HTML、登录页与恢复页都在其中；媒体路由另设更严的沙箱，插件前端的文件另设框架 CSP
  expressApp.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', DOCUMENT_CSP);
    next();
  });
  // 插件前端的文件：注册在认证之前，凭页面登记时的 token 取，不看 cookie
  registerFrameRoutes(expressApp, token => pages.frameDir(token));
  expressApp.use(express.json({ limit: '10mb' }));
  auth.install(expressApp);
  // REST 路由 owner 闸（连接级认证之上的显式 owner 复核，见 gate.ts）。
  // 当前身份 / 登录态查询统一走 auth.ts 的 GET /api/auth/status（含 identity）。
  const gate = createRouteGate(auth.identify);
  const server = createServer(expressApp);
  // server.close() 只停止 accept 并关掉此刻闲着的连接；拆卸时还在处理请求的 keep-alive 连接（例如重载自己的那次）
  // 应答完会留下来，后面的请求照样落到已拆卸的旧实例。拆卸之后每次应答完就关掉闲下来的连接，浏览器改开新连接
  server.on('request', (_req, res) =>
    res.on('finish', () => {
      if (!server.listening) server.closeIdleConnections();
    }),
  );
  // 一个 WebSocketServer 接全部端点，连接按路径分给各自的处理，来源校验与认证对各端点一样。同一个 HTTP server 上
  // 挂两个带 path 的 WebSocketServer 不行：先挂的那个会把别的路径的升级请求按 400 拒掉。
  const wsPaths = new Set([SESSION_PATH, ADMIN_PATH]);
  const wsPath = (req: IncomingMessage) => (req.url ?? '').split('?')[0];
  const approvalSurface = caps.approvals.registerSurface('webui');
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, cb) => {
      if (!originAllowed(info.req)) cb(false, 403, 'origin not allowed');
      else if (!auth.verifyWsClient(info.req)) cb(false, 401, 'unauthenticated');
      else if (!wsPaths.has(wsPath(info.req))) cb(false, 404);
      else cb(true);
    },
  });
  // 日志按插件筛时用登记表分开后缀实例与插件分出的子作用域
  const matchLogs = logMatcher(instance => caps.plugins.current?.getPlugin(instance) !== undefined);
  const admin = createAdminChannel(logger, matchLogs);
  /** 打开着的 /session 连接：webui 平台的连接状态按它数 */
  const sessionSockets = new Set<WebSocket>();
  // 半开连接回收：清理只挂 'close' 时，睡眠/断网的客户端永远等不到事件，
  // 日志广播持续往死连接的发送缓冲堆数据。详见 ws-heartbeat.ts。
  const heartbeat = createWsHeartbeat<WebSocket>({
    onStale: ws => logger.debug(`WebUI 客户端心跳超时，回收半开连接 (bufferedAmount=${ws.bufferedAmount})`),
    onError: (_ws, err) => logger.warn(`WebUI 客户端连接错误: ${err.message}`),
  });

  // 前端静态文件托管：前端包不是插件（无 apply，纯静态资源），托管权在本插件——
  // app:ready 时由 client-discovery 按 `aalis.client` 标记发现候选，本插件把每个候选注册成
  // 一条 webui-client 服务 provider，再由服务解析（偏好 > 优先级 > 注册顺序）定出活跃前端。
  let clientDist = '';
  let staticMiddleware: express.RequestHandler | null = null;

  function mountStaticDir(dir: string): void {
    if (existsSync(dir)) {
      staticMiddleware = express.static(dir);
      logger.info(`前端静态目录: ${dir}`);
    } else {
      staticMiddleware = null;
      logger.warn(`前端目录不存在: ${dir}`);
    }
  }

  // 已发现的前端候选（app:ready 时填充，逐个注册为 webui-client 服务 provider）。
  const clientCandidates: Array<{ id: string; label: string; dir: string }> = [];
  /**
   * 候选 id → 它那条 webui-client provider 的注销句柄。
   *
   * 单独一张表而不是往 ClientCandidate 上加字段：那个类型是 client-discovery 的产出契约，
   * 「怎么注销」是本文件的注册细节，不该反向污染它。对账时只从数组里删掉候选是不够的——
   * 服务池里那条 provider 还在，仍可能被解析到一个已删除的目录。
   */
  const clientProviderDisposers = new Map<string, () => void>();
  /** 当前活跃前端目录 = 解析后的 webui-client 服务（servicePreferences 偏好 > 优先级 > 注册顺序）。 */
  function currentClientDir(): string | undefined {
    return services.get(webuiClient)?.getClientDir?.();
  }
  /**
   * 活跃前端可能变了时调用（改或清除 webui-client 的服务偏好、摘掉已不在的前端包）：重挂当前活跃前端，
   * 经 /admin 推 client.reload 让页面整页重载，换前端不重启进程。
   */
  function remountActiveClient(): void {
    const dir = currentClientDir();
    if (dir) {
      clientDist = dir;
      mountStaticDir(dir);
    }
    admin.send({ type: 'client.reload' });
  }

  // 动态静态文件中间件（支持运行时切换前端）
  expressApp.use((req, res, next) => {
    if (staticMiddleware) {
      staticMiddleware(req, res, next);
    } else {
      next();
    }
  });

  // ---------- REST API ----------

  // ---------- 插件管理 + 全局配置 ----------
  // fs 扫描 env：discoverClients（app:ready 时）与市场「已装」兜底共用一份，避免两处重复。
  const fsScanEnv = {
    existsSync,
    readdirSync: (p: string) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    readJson: (p: string) => {
      try {
        return JSON.parse(readFileSync(p, 'utf-8'));
      } catch {
        return undefined;
      }
    },
    join: (...parts: string[]) => resolve(...parts),
  };
  // 市场「已装」判定、依赖图、插件列表的版本与前端候选发现共用这一份扫描目录（pnpm 工作区下 require.resolve
  // 从仓库根解析不到工作区包，只能扫盘）。每请求懒扫，量小。host-paths 由宿主在根上提供，不会中途换。
  const appDir = caps.paths.current?.app;
  const scanDirs = localScanDirs(appDir);
  registerPluginRoutes(
    expressApp,
    {
      app: caps.app,
      plugins: caps.plugins,
      source: caps.source,
      hostConfig: caps.hostConfig,
      tools: caps.tools,
      commands: caps.commands,
      services,
      self: lifecycle.id,
      home: caps.paths.current?.home,
      versions: () => {
        if (!appDir) return () => undefined;
        const lookup = localPackageLookup(appDir, collectLocalPackageDeps(scanDirs, fsScanEnv));
        return name => lookup(name)?.version;
      },
      logger,
    },
    gate,
  );
  // 页面：插件经 webui-server 的绑定接口登记，页面的数据源与动作、插件前端的文件、会话面板与布局记录的路由按这张登记表分派
  const pageFiles = createPageFiles(() => storage.listRoots());
  const pages = createPageRegistry({
    logger,
    send: event => admin.send(event),
    sessions: () => caps.sessions.current,
    signFile: pageFiles.sign,
  });
  registerPageRoutes(
    expressApp,
    {
      registry: pages,
      layout: createLayoutStore(storage, logger),
      storageReady: () => caps.storage.current !== undefined,
      send: event => admin.send(event),
      logger,
    },
    auth.identify,
    gate,
  );
  registerMarketplaceRoutes(
    expressApp,
    {
      logger,
      plugins: caps.plugins,
      services,
      packageManager: caps.packageManager,
      appDir,
    },
    gate,
    uiConfig.marketplaceRegistry,
    () => collectLocalPackageDeps(scanDirs, fsScanEnv),
    () => discoverAndProvideClients(),
  );

  // 「需要处理」：推出未结的审批、插件故障与提示，界面的首页摘要、插件详情与标签页标题都读这一个列表
  const attention = createAttention({
    approvals: () => caps.approvals.current?.list() ?? [],
    sessions: () => caps.sessions.current,
    plugins: () => {
      const pm = caps.plugins.current;
      return pm ? blockedStatus({ plugins: pm, services, doc: caps.hostConfig.current }) : [];
    },
    notices: pages.notices,
    send: event => admin.send(event),
  });
  route(expressApp, 'GET /api/attention', gate(), (_req, res) => {
    res.json({ items: attention.items() });
  });

  /** 按查询参数里的筛选读日志的历史回给前端，给了 before 时往前翻；筛选写法不对回 400 */
  const sendLogs = async (
    query: express.Request['query'],
    res: express.Response<LogEntry[] | ErrorResponse>,
    before?: number,
  ) => {
    const filter = parseLogFilter(query);
    if (!filter) {
      res.status(400).json({ error: '日志筛选写法不对：level 只收 debug、info、warn、error，每一项最多给一次' });
      return;
    }
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 5000);
    res.json(await readLogs(storage, matchLogs(filter), limit, before));
  };
  // 日志的历史以 logs/latest.log 为单一数据源：尾部 limit 条
  route(expressApp, 'GET /api/logs/tail', gate(), (req, res) => sendLogs(req.query, res));
  // 往前翻：seq 比 before 小的最后 limit 条
  route(expressApp, 'GET /api/logs/range', gate(), (req, res) => {
    const before = Number(req.query.before);
    if (!Number.isFinite(before)) {
      res.status(400).json({ error: 'before query param required' });
      return;
    }
    return sendLogs(req.query, res, before);
  });

  // 获取服务列表（含提供者信息）
  route(expressApp, 'GET /api/services', gate(), async (_req, res) => {
    const pluginMgr = caps.plugins.current;
    const pluginStatus = pluginMgr ? pluginMgr.getStatus() : [];
    const displayNameMap = new Map<string, string>();
    for (const p of pluginStatus) {
      if (p.displayName) {
        displayNameMap.set(p.name, p.displayName);
        displayNameMap.set(p.instanceId, p.displayName);
      }
    }
    // 根激活归宿主：core 的内置服务与宿主登记的 host-config / plugin-source 都在这里（与市场依赖图同一标签）。
    // 别把内部 id 'root' 裸露给用户。
    displayNameMap.set('root', '宿主');

    const serviceNames = services.names();
    const detail: ServiceListResponse['services'] = {};

    for (const svcName of serviceNames) {
      // 枚举已按「偏好 > 优先级 > 注册顺序」排序，附带 priority 字段；只取登记元数据，不取实例
      const entries = services.inspect(svcName);
      detail[svcName] = {
        providers: entries.map(e => ({
          contextId: e.contextId,
          displayName: displayNameMap.get(e.contextId),
          label: e.label,
          priority: e.priority,
          exclusive: e.exclusive,
        })),
        preferred: services.preferred(svcName) ?? null,
      };
    }

    res.json({ services: detail });
  });

  /**
   * 设置服务偏好。body: { contextId: string }
   * 偏好语义：`preferred > priority > 注册顺序`。持久化到 aalis.config.yaml 的 servicePreferences。
   */
  route(expressApp, 'POST /api/services/:name/prefer', gate(), async (req, res) => {
    const svcName = String(req.params.name);
    const contextId = String((req.body as { contextId?: string })?.contextId ?? '').trim();
    if (!contextId) {
      res.status(400).json({ error: 'contextId required' });
      return;
    }
    // 校验 entry 存在
    const entries = services.inspect(svcName);
    if (!entries.some(e => e.contextId === contextId)) {
      res.status(404).json({ error: `service "${svcName}" has no provider with contextId "${contextId}"` });
      return;
    }
    // 偏好要跨重启保留就得写进文档：宿主没提供文档时不动运行态
    const host = caps.hostConfig.current;
    if (!host) {
      res.status(503).json({ error: '宿主未提供配置文档（host-config），无法保存偏好' });
      return;
    }
    if (!services.prefer(svcName, contextId)) {
      res.status(409).json({ error: `service "${svcName}" rejected provider preference "${contextId}"` });
      return;
    }
    host.setServicePreference(svcName, contextId);
    // 切换前端：webui-client 是「前端」服务，偏好变更需重挂静态目录 + 通知客户端刷新。
    // 重挂与偏好同属内存态，必须在等落盘之前一起生效：save 拒绝时才不会留下「解析选 B、静态挂 A」。
    if (svcName === 'webui-client') remountActiveClient();
    if (!(await saveAfterApply(host, res, 'restart'))) return;
    res.json({ ok: true });
  });

  /** 清除服务偏好 */
  route(expressApp, 'DELETE /api/services/:name/prefer', gate(), async (req, res) => {
    const svcName = String(req.params.name);
    const host = caps.hostConfig.current;
    if (!host) {
      res.status(503).json({ error: '宿主未提供配置文档（host-config），无法保存偏好' });
      return;
    }
    services.unprefer(svcName);
    host.removeServicePreference(svcName);
    if (svcName === 'webui-client') remountActiveClient();
    if (!(await saveAfterApply(host, res, 'restart'))) return;
    res.json({ ok: true });
  });

  // 插件经贡献点提供的主题：与导入的主题同一套校验，不合格式的不列出、每份告警一次。插件停用时贡献随之撤回，
  // 界面收到 plugins.changed 后重取。贡献点服务不在时没有插件主题
  const warnedThemes = new WeakSet<object>();
  route(expressApp, 'GET /api/themes', gate(), (_req, res) => {
    const themes: PluginTheme[] = [];
    for (const { key, spec } of services.get(contributions)?.collect('webui:theme') ?? []) {
      const parsed = parseTheme((spec as { theme?: unknown }).theme);
      if (parsed.ok) themes.push({ id: key, instance: key.slice(0, key.lastIndexOf('/')), theme: parsed.theme });
      else if (!warnedThemes.has(spec)) {
        warnedThemes.add(spec);
        logger.warn(`插件主题 ${key} 不合主题文件的格式，没有列出：${parsed.errors.join('；')}`);
      }
    }
    res.json({ themes });
  });

  // 前端切换已统一到「服务偏好」：前端是 webui-client 服务的多 provider，切换走
  // POST /api/services/webui-client/prefer（见上），webui-server 在该偏好变更时重挂 + 广播刷新。
  // 故不再有独立的 /api/clients* 路由。

  // 获取所有平台适配器及其连接状态
  route(expressApp, 'GET /api/platforms', gate(), (_req, res) => {
    res.json({ platforms: aggregatePlatformDetails(caps.platform) });
  });

  // 触发指定 provider 重新探测远端模型列表（插件配置里模型字段旁的「刷新」按钮）
  // 仅对在 LLMModel 上实现了 refresh() 的 provider 生效（远端动态发现型）。
  // 同 provider 下所有 model entries 共享同一份 refresh 闭包，调任一个 entry 即可。
  // 按 providerId 找条目，与 /api/models/llm 给的 contextId 同一口径：条目自己的 contextId 是 `<provider>/<model>`，不等于 provider
  route(expressApp, 'POST /api/llm-providers/:contextId/refresh', gate(), async (req, res) => {
    const contextId = req.params.contextId;
    try {
      const llmEntries = caps.llm.all().filter(e => e.instance.providerId === contextId);
      const target = llmEntries.find(e => typeof e.instance.refresh === 'function');
      if (!target) {
        res.status(404).json({
          error:
            llmEntries.length > 0
              ? `提供者 ${contextId} 不支持运行时刷新模型列表（例如关闭了模型发现）`
              : `提供者 ${contextId} 当前没有已注册的模型，无法刷新`,
        });
        return;
      }
      const result = await target.instance.refresh!();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 获取某个服务的可用模型/选项列表
  route(expressApp, 'GET /api/models/:service', gate(), async (req, res) => {
    const serviceName = req.params.service;

    // 特殊处理 platform：通过 helper 获取已注册的平台名称
    if (serviceName === 'platform') {
      res.json({ models: getPlatformNames(caps.platform) });
      return;
    }

    // 特殊处理 gateway-scopes：已注册平台与它们的类型名（sessionTypesOf：没声明类型的平台只有一个类型 private）
    // 的笛卡尔积
    if (serviceName === 'gateway-scopes') {
      const platformTypes = new Map<string, string[]>();
      const allTypes = new Set<string>();
      for (const a of getPlatformAdapters(caps.platform)) {
        const types = sessionTypesOf(a).map(t => t.name);
        platformTypes.set(a.platform, types);
        for (const t of types) allTypes.add(t);
      }
      const scopes: OptionDetail[] = [];
      scopes.push({ value: '*', label: '* （全部平台 × 全部类型）' });
      for (const t of [...allTypes].sort()) {
        scopes.push({ value: `*:${t}`, label: `*:${t} （所有平台的 ${t} 会话）` });
      }
      for (const [p, types] of platformTypes) {
        scopes.push({ value: `${p}:*`, label: `${p}:* （${p} 全部类型）` });
        for (const t of types) scopes.push({ value: `${p}:${t}`, label: `${p}:${t}` });
      }
      res.json({ models: scopes.map(s => s.value), details: scopes });
      return;
    }

    // 深度思考的档位：可选项依赖「模型」这一项，dependency 带它的生效值；没带时按服务偏好解析，与对话时同一种解析。
    // 默认档标 default（没设时界面据它写按哪一档跑），模型不能调时没有可选项。labels 是各模型声明过的档位的名字
    // （同一个 id 取先登记的）：换了模型以后存着的档位不在可选项里，界面按它写出名字
    if (serviceName === 'llm-thinking') {
      const ref = modelRefOf(req.query.dependency);
      if (ref === null) {
        res.status(400).json({ error: 'dependency 要是模型引用 { provider, model } 的 JSON' });
        return;
      }
      const thinking = resolveLLMModel(caps.llm, ref, ['chat'])?.instance.thinking;
      const levels = thinking?.levels ?? [];
      const labels: Record<string, string> = {};
      for (const entry of caps.llm.all()) {
        for (const level of entry.instance.thinking?.levels ?? []) labels[level.id] ??= level.label;
      }
      res.json({
        models: levels.map(level => level.id),
        details: levels.map(level =>
          level.id === thinking?.default
            ? { value: level.id, label: level.label, default: true }
            : { value: level.id, label: level.label },
        ),
        labels,
      });
      return;
    }

    // 特殊处理 toolGroups：优先从工具分组注册表获取，回退到扫描工具
    if (serviceName === 'toolGroups') {
      const groups = caps.tools.current?.getGroups() ?? [];
      // '*' = 全部分组（api-tools 的分组约定），与会话范围选项的「* （全部平台）」同一写法
      if (groups.length > 0) {
        res.json({
          models: ['*', ...groups.map(g => g.name).sort()],
          details: [
            { value: '*', label: '* （全部分组）' },
            ...groups.map(g => ({
              value: g.name,
              label: g.label,
              description: descSummary(g.description),
              pluginName: g.pluginName,
            })),
          ],
        });
      } else {
        // 回退：从已注册工具中提取分组名称
        const allTools = caps.tools.current?.getAll() ?? [];
        const groupSet = new Set<string>();
        for (const t of allTools) {
          t.groups?.forEach((g: string) => {
            groupSet.add(g);
          });
        }
        res.json({ models: ['*', ...[...groupSet].sort()] });
      }
      return;
    }

    // LLM 走 per-model entry 枚举（每个 entry 已对应一个具体 model，不再依赖 provider.listModels）。
    // contextId 给提供者的实例 id（条目自己的是 `<实例 id>/<模型 id>`）：llm-ref 的取值 { provider, model } 认的是它
    if (serviceName === 'llm') {
      try {
        const entries = caps.llm.all();
        const providers = entries.map(e => ({
          model: e.instance.id,
          provider: e.label ?? e.contextId,
          contextId: e.instance.providerId,
          capabilities: [...e.instance.capabilities],
        }));
        res.json({ providers });
      } catch {
        res.json({ providers: [] });
      }
      return;
    }

    // 合起各提供者的取值（人设卡等服务走 listModels()）
    const allProviders = services.all(serviceName) as Array<ServiceView<{ listModels?(): Promise<unknown[]> }>>;
    const models: string[] = [];
    for (const provider of allProviders) {
      if (typeof provider.instance.listModels !== 'function') continue;
      try {
        models.push(...(await provider.instance.listModels()).map(String));
      } catch (err) {
        // 单个提供者获取失败不影响整体，它的取值从下拉里消失：记下是谁、为什么
        logger.warn(`取 ${serviceName} 的可选值时 ${provider.contextId} 失败，它的取值不在下拉里:`, err);
      }
    }
    res.json({ models });
  });

  registerProxyRoutes(expressApp, logger, gate);
  registerMediaRoutes(expressApp, storage, logger, gate);
  registerFileRoutes(expressApp, storage, { sessions: caps.sessionProtocol, pages: pageFiles }, logger, gate);

  // ---------- WebSocket ----------

  wss.on('connection', (ws, req) => {
    // 连接建立时解析一次调用者身份（cookie 在升级请求里；verifyClient 已保证已认证）
    const wsIdentity = auth.identify(req) ?? { platform: 'webui', userId: 'console' };
    logger.debug(`WebUI 客户端已连接: ${wsIdentity.platform}:${wsIdentity.userId}`);
    // 每条连接都过心跳：回收半开连接，track 同时挂上 'error' 兜底监听（见 ws-heartbeat.ts）
    heartbeat.track(ws);
    ws.on('close', () => heartbeat.untrack(ws));
    if (wsPath(req) === ADMIN_PATH) {
      admin.accept(ws);
      return;
    }
    sessionSockets.add(ws);
    ws.on('close', () => sessionSockets.delete(ws));
    acceptSessionSocket(ws, { identity: wsIdentity, surface: approvalSurface }, caps.sessionProtocol.current);
  });

  // 管理面推送（/admin）：日志、插件状态、「需要处理」、重启。页面登记表与提示的变化、invalidate 在页面登记表（pages.ts）里推，
  // 布局记录的变化在它的路由里推，换前端在 remountActiveClient 里推
  const removeAdminLogListener = LogHub.default.onEntry(entry => admin.send({ type: 'log', entry }));
  events.on('plugins:changed', () => {
    admin.send({ type: 'plugins.changed' });
    attention.pluginsChanged();
  });
  events.on('approval:created', () => attention.changed());
  events.on('approval:settled', () => attention.changed());
  events.on('app:restarting', () => admin.send({ type: 'app.restarting' }));

  // 发往 WebUI 自己会话的出站消息：会话历史就是 WebUI 的收件箱，页面只是查看器，打开着的页面由会话服务推送。
  // 回执表示这条消息已经进了会话历史，不看有没有页面在线。owner 从 WebUI 驱动的 IM 房间（根会话记下了出生平台）
  // 由那个平台的适配器认领
  events.on('outbound:message', (msg: OutgoingMessage) => {
    if (msg.delivery || msg.platform !== 'webui') return;
    const sm = caps.sessions.current;
    const root = sm && rootSessionOf(sm.getSession(msg.sessionId), id => sm.getSession(id));
    if (root?.originPlatform !== undefined) return;
    // 同步挂上 Promise，始终 resolve，即使其他 outbound 监听器随后耗时，也不会产生未处理的 rejection。
    msg.delivery = (async () => {
      try {
        // 保存快照：下游处理不应受生产者或其他适配器后续改写影响。
        const snapshot: OutgoingMessage = { ...msg, attachments: msg.attachments?.map(att => ({ ...att })) };
        const archive = caps.archive.current;
        if (!archive) return { ok: false as const, error: '消息存档服务不在场，这条消息没有存进 WebUI 会话的历史' };
        for (const record of inboxRecords(snapshot)) await archive.saveMessage(msg.sessionId, record);
        if (snapshot.attachments?.length) {
          // 附件已由上面记进会话历史（见 inboxRecords），标上 skipArchive，免得全局出站归档再记一份
          const attachments = snapshot.attachments.map(att => ({ ...att, skipArchive: true }));
          void events.emit('outbound:delivered', { ...snapshot, attachments, delivery: undefined });
        }
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    })();
  });

  // 前端切换「逃生页」：由 webui-server 直出、独立于任何可被切换的前端，故任意前端（哪怕
  // 极简第三方前端无切换 UI）卡住时都能在此切回。受全局 auth 中间件登录保护；切换走既有 owner
  // 闸的 POST /api/services/webui-client/prefer，本页零新增后端逻辑（见 client-switch-page.ts）。
  // 注册在 SPA 兜底之前，故 `/__clients` 被本路由先接走、不落到前端 index.html。
  route(expressApp, 'GET /__clients', (_req, res) => {
    res.type('html').send(renderClientSwitchPage());
  });
  route(expressApp, 'GET /__clients.js', (_req, res) => {
    res.type('application/javascript').send(CLIENT_SWITCH_SCRIPT);
  });

  // API 未命中：回 404 JSON，不落到 SPA 兜底（否则客户端拿到 HTML 去解析 JSON）。不是路由：任何方法都回它
  expressApp.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    res.status(404).json({ error: `未知 API: ${req.method} ${req.path}` } satisfies ErrorResponse);
  });

  // SPA fallback: 所有非 API 路径返回 index.html；/assets/ 下缺失的文件回 404（旧页面引用的资源换了构建就不在了，
  // 回 index.html 只会让浏览器把 HTML 当脚本执行）
  route(expressApp, 'GET /{*path}', (req, res) => {
    if (req.path.startsWith('/assets/')) {
      res.status(404).end();
      return;
    }
    // 还没有选中的前端时 clientDist 为空：不能拼出相对 cwd 的 index.html
    const indexPath = clientDist ? join(clientDist, 'index.html') : undefined;
    if (indexPath && existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: '前端未就绪：请安装一个带 aalis.client 标记的前端包' });
    }
  });

  // 路由与中间件抛出的错误（请求体不是 JSON 或太大、路径参数解不开、处理函数出错）：/api/ 下回 ErrorResponse，别处回纯文本，
  // 都不带堆栈，原因只进日志。挂在全部路由之后（插件前端的挂载另有自己的，紧跟在挂载之后）
  expressApp.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const { status, expose, message } = err as { status?: unknown; expose?: unknown; message?: unknown };
    const code = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) logger.error(`${req.method} ${req.path} 处理出错:`, err);
    else logger.debug(`${req.method} ${req.path} 请求被拒 (${code}): ${String(message)}`);
    const reason =
      code >= 500
        ? '处理这个请求时出错，原因见日志'
        : expose === true && typeof message === 'string'
          ? message
          : '请求的写法不对';
    if (req.path.startsWith('/api/')) res.status(code).json({ error: reason } satisfies ErrorResponse);
    else res.status(code).type('text').send(reason);
  });

  /**
   * 全动态发现前端：按 `aalis.client:true` 标记扫描，**不硬编码任何前端包名**
   * （忒修斯之船——任意第三方前端带标记+dist 即被发现）。
   * 覆盖三种拓扑：monorepo（扫 packages 同级目录）/ 独立项目（扫 node_modules/@aalis + 根 deps）。
   *
   * **幂等**，可重复调用：装完一个 `aalis-interface` 包后要立刻重跑，否则它不会出现在服务偏好
   * 的下拉里、必须重启才看得见。幂等是硬要求而非优化——重复 `fork().provide()` 会在服务
   * 容器里堆同名重复项。已登记过的 id 直接跳过。
   *
   * 只登记新候选，**不切换活跃前端**：换前端是用户在服务偏好里的显式选择，装了个新的不该把
   * 他正在用的顶掉。
   */
  function discoverAndProvideClients(): void {
    // 宿主不提供安装集目录时没有依赖表可读，只按扫描目录发现
    const projectRequire = appDir ? createRequire(pathToFileURL(join(appDir, 'package.json'))) : undefined;
    const env: DiscoveryEnv = {
      ...fsScanEnv,
      dirname,
      resolvePkgJson: id => {
        try {
          return projectRequire?.resolve(`${id}/package.json`);
        } catch {
          return undefined;
        }
      },
    };
    let depIds: string[] = [];
    if (appDir) {
      try {
        // 每次重读：装完新包后根 dependencies 已变，缓存会让新前端发现不到。
        const rootPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8')) as {
          dependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
        };
        depIds = Object.keys({ ...rootPkg.dependencies, ...rootPkg.optionalDependencies });
      } catch {
        /* 安装集没有 package.json，跳过 deps 扫描 */
      }
    }

    const scanned = discoverClients(scanDirs, depIds, env);

    // 对账：本轮扫不到的候选要摘掉，不能只增不删。卸载现在会真删 node_modules，
    // 留着的候选指向一个已不存在的目录——它仍在服务池里，被解析到就是整站 404。
    const scannedIds = new Set(scanned.map(c => c.id));
    let removed = 0;
    for (let i = clientCandidates.length - 1; i >= 0; i--) {
      const stale = clientCandidates[i];
      if (scannedIds.has(stale.id)) continue;
      clientProviderDisposers.get(stale.id)?.();
      clientProviderDisposers.delete(stale.id);
      clientCandidates.splice(i, 1);
      removed++;
      logger.info(`前端已消失，摘除候选: ${stale.label} (${stale.dir})`);
    }
    // 摘掉 provider 只改了「服务解析结果」，**真正服务 HTTP 的是 clientDist / staticMiddleware**，
    // 它们在 app:ready 时绑定、之后只由 remountActiveClient 更新。不重挂的话，被摘掉的正好是当前
    // 活跃前端时，express.static 仍指向已删目录 —— 请求落到 SPA 兜底、`index.html` 不存在
    // → 整站 404，而服务池里明明还有别的可用前端。切换偏好那条路径早就这么做了，这里对齐。
    if (removed > 0) remountActiveClient();

    const fresh = pickFreshClients(
      clientCandidates.map(c => c.id),
      scanned,
    );
    clientCandidates.push(...fresh);
    // 把每个新发现的前端注册为 webui-client 服务的一个 provider（带 label，供服务偏好里切换）。
    // 外部插件在 apply 里主动提供 webui-client 的也已在服务池中（注册更早 → 默认胜出，仍可被偏好切换）。
    //
    // 代前端包登记：条目身份是前端**包名本身**——它是服务偏好里展示的 contextId，也是
    // servicePreferences['webui-client'] 里持久化的键，还是装卸闸按包名比对的对象。
    for (const candidate of fresh) {
      clientProviderDisposers.set(
        candidate.id,
        provide(
          webuiClient,
          { getClientDir: () => candidate.dir },
          { label: candidate.label, onBehalfOf: candidate.id },
        ),
      );
      logger.info(`发现前端: ${candidate.label} (${candidate.dir})`);
    }
  }

  // 启动服务器
  events.on('app:ready', async () => {
    // 冷启动时 storage 的激活在 app:ready 之前收敛；等晚到的读回落定，listen / autoOpen /
    // access.txt 用的就是持久化的 token
    if (tokenLoading) await tokenLoading;
    discoverAndProvideClients();
    // 活跃前端 = 解析后的 webui-client 服务（servicePreferences 偏好 > 优先级 > 注册顺序）；零前端则 404。
    const activeDir = currentClientDir();
    if (activeDir) {
      clientDist = activeDir;
      mountStaticDir(activeDir);
      logger.info(`活跃前端: ${activeDir}`);
    } else {
      logger.warn('未发现任何前端（webui-client provider）；前端路由将 404，请安装一个 aalis.client 包');
    }

    // 监听失败（典型 EADDRINUSE：3000 被别的 dev server 占了）是 bind 之后**异步 emit** 的，
    // 不在任何调用栈内，外层 try/catch 接不住 —— 无人处理即 uncaughtException →
    // runtime 的 process.exit(1)，把聊天适配器、定时任务连同整个 bot 一起打死。
    // 契约本该是「WebUI 起不来、其余照跑」（plugin-activation 的插件失败隔离）。
    //
    // **必须挂在 wss 上，挂 server 上是死代码。** `new WebSocketServer({ server })` 构造时
    // 已给 http server 挂了一条 'error' 监听（内容是 `this.emit.bind(this, 'error')`，转发给
    // wss）并排在最前；EventEmitter 按注册顺序调用，它 emit 到无监听器的 wss 上会同步抛出、
    // 中断 emit 循环，后注册在 server 上的 handler 因此永远轮不到。
    wss.on('error', (err: Error) => {
      logger.error(`WebUI 监听 ${uiConfig.host}:${uiConfig.port} 失败: ${err.message}；WebUI 不可用，其余功能照常运行`);
    });
    server.listen(uiConfig.port, uiConfig.host, () => {
      // 通配绑定地址（0.0.0.0 / ::）是"听在哪"，不是"从哪访问"——直接拼进 URL 会让
      // autoOpen 打开空白页、access.txt 给出不可点的链接（host 改 0.0.0.0 后实测）。
      // 展示/打开一律用回环；局域网访问地址由用户按本机 IP 自行替换。
      const displayHost = uiConfig.host === '0.0.0.0' || uiConfig.host === '::' ? '127.0.0.1' : uiConfig.host;
      const url = `http://${displayHost}:${uiConfig.port}/`;
      listeningUrl = url;
      const accessUrl = `${url}?token=${authToken}`;
      logger.info(`WebUI 已启动: ${url}`);
      // 多前端时提示恢复页 URL：万一切到无切换 UI 的前端被卡住，可在此切回（详见 client-switch-page.ts）。
      if (clientCandidates.length > 1) {
        logger.info(`检测到多个前端；若卡在某前端无切换入口，可访问恢复页切回: ${url}__clients`);
      }
      const tokenHint =
        uiConfig.tokenMode === 'ephemeral'
          ? 'token 仅本次启动有效，重启轮换'
          : uiConfig.tokenMode === 'fixed'
            ? 'token 来自配置 fixedToken，固定不变'
            : 'token 已持久化到 storage data:/webui/token，重启沿用';
      // 不把 token 打进日志（会落 latest.log / 被 /api/logs/* 回放 / 贴日志求助时外泄）。
      // 仅打不带 token 的 URL，完整一键登录链接见 access.txt（该文件应 0o600，见 token 落盘）。
      logger.info(`首次访问 URL（${tokenHint}）: ${url} —— 完整一键登录链接见 ${accessFileUri}`);
      void (async () => {
        // 先把文件写出来，再解析它的绝对路径：resolveLocalPath 走 realpath，文件尚未落盘会抛
        // ENOENT 被吞掉，于是「绝对路径」退化成原样重复一遍 URI——偏偏首启（新用户唯一需要
        // 这行的时刻）必然命中，二次启动因文件已在反而正常。两者原先都是 void，谁先到看调度。
        if (!(await writeAccessFile(url, authToken))) {
          // 写失败上面已 warn 过；再打一条「已写入」只会让人去找一个不存在的文件
          logger.warn(
            `访问凭据未能写入 ${accessFileUri}：修好家目录 state/webui/ 的写权限后重启；` +
              `或把 tokenMode 设为 fixed、在 fixedToken 里填一个至少 ${FIXED_TOKEN_MIN_LENGTH} 个字符的 token，用它在登录页登录`,
          );
          return;
        }
        let absHint = accessFileUri;
        try {
          if (storage.resolveLocalPath) {
            absHint = await storage.resolveLocalPath(accessFileUri, 'read');
          }
        } catch (err) {
          logger.debug(`解析访问凭据文件绝对路径失败: ${(err as Error).message}`);
        }
        logger.info(`访问凭据已写入: ${accessFileUri}（绝对路径: ${absHint}）`);
      })();
      const host = caps.app.current;
      if (uiConfig.autoOpen && (tokenFresh || !host || !browserOpenedFor.has(host))) {
        if (host) browserOpenedFor.add(host);
        openBrowser(accessUrl, createProcessGateway(caps.process));
      }
    });
  });

  lifecycle.onDispose(() => {
    heartbeat.dispose();
    pages.dispose();
    removeAdminLogListener();
    // 先把已建立的连接收口再关服务端：ws 的 close() 在 {server} 模式下只摘监听器、对
    // this.clients 一个都不动，server.close() 也只停止 accept。不主动关的话，旧 socket 在插件卸载后
    // 仍然活着，照常把帧转给会话服务，发出的消息照样进入站事件。
    // 发 1001 触发前端既有的 onclose 重连路径，bounce 之后自动接回新实例。各端点的连接都在 wss.clients 里，
    // /session 的连接关闭时撤掉会话服务那头的连接。
    for (const ws of wss.clients) {
      try {
        ws.close(1001, 'webui 正在卸载');
      } catch {
        /* 单条连接关不掉不应阻塞拆卸 */
      }
    }
    wss.close();
    server.close();
  });

  // 平台名 webui 标明说话的是从 WebUI 来的 owner。登记成平台，平台档、会话范围的候选与用户关系认的平台名里才有它；
  // 连接状态数的是打开着的 /session 连接。WebUI 的会话不经适配器收发：页面走会话协议，出站消息由上面的收件箱认领
  provide(platform, {
    adapterName: 'WebUI',
    platform: 'webui',
    getConnections(): PlatformConnection[] {
      const clients = sessionSockets.size;
      return clients === 0 ? [] : [{ id: 'webui', platform: 'webui', status: 'online', detail: { clients } }];
    },
    async sendMessage() {
      throw new Error('WebUI 的会话不经平台适配器发消息：页面经会话协议收发，发往 WebUI 会话的出站消息写进会话历史');
    },
  });

  // === 注册 WebUI 服务 ===
  const webuiService: WebUIService = {
    getPort: () => uiConfig.port,
    getHost: () => uiConfig.host,
    addPage: pages.addPage,
    invalidate: pages.invalidate,
    addNotice: pages.addNotice,
  };
  provide(webuiServer, webuiService);
}
