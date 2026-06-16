// node:fs/node:path 仅用于发现前端 dist 静态目录（位于工作区外部），
// 已在 biome.json noRestrictedImports 中作为基础设施例外列出。

import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AppService, ConfigSchema, Context, LogEntry, PluginManagerService } from '@aalis/core';
import { LogHub, parseLogLine } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import type { AuthorityService } from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import type {} from '@aalis/plugin-doctor-api'; // declaration merging：doctor:updated 事件
import type { LLMModel, ModelInfo } from '@aalis/plugin-llm-api';
import type {} from '@aalis/plugin-memory-api'; // declaration merging：history:changed 事件
import type { OutgoingMessage, StreamChunkMessage } from '@aalis/plugin-message-api';
import type { PersonaService } from '@aalis/plugin-persona-api';
import {
  aggregatePlatformDetails,
  getPlatformAdapters,
  getPlatformNames,
  type PlatformAdapter,
  type PlatformConnection,
} from '@aalis/plugin-platform-api';
import { createProcessGateway } from '@aalis/plugin-process-api';
import type {} from '@aalis/plugin-session-manager-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type {} from '@aalis/plugin-todo-list'; // declaration merging：todo:updated 事件
import type { ToolExecuteMessage, ToolService } from '@aalis/plugin-tools-api';
import type { WebUIService, WebuiPage } from '@aalis/plugin-webui-api'; // declaration merging WebuiPage.content
import { DEFAULT_SUBSYSTEM_METADATA } from '@aalis/plugin-webui-api';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createAuthSystem, openBrowser } from './auth.js';
import { createRouteGate } from './gate.js';
import { registerFileRoutes } from './routes/files.js';
import { registerMarketplaceRoutes } from './routes/marketplace.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerUploadedFilesRoutes } from './routes/uploaded-files.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui-server';
export const displayName = 'WebUI 服务端';
export const subsystem = 'platform';
export const provides = ['webui-server', 'platform'];
export const inject = {
  // storage 改为 optional：避免 plugin-storage-local bounce 时级联重启 webui-server
  // （若 required，存储服务暂时消失会让 webui-server 进入 pending，导致 registeredPages
  // 被清空，其他插件的 sidebar 页面在 webui-server 重新激活后无法恢复）。
  // storage gateway 的各操作已有 try-catch，暂时不可用时仅个别文件操作失败，不影响主功能。
  optional: ['storage', 'authority', 'commands', 'platform', 'process'],
};

const webuiPages: WebuiPage[] = [
  { key: 'dashboard', label: '仪表盘', icon: 'dashboard', order: 10, renderer: 'dashboard' },
  { key: 'marketplace', label: '插件市场', icon: 'marketplace', order: 20, renderer: 'marketplace' },
  { key: 'plugin-config', label: '插件配置', icon: 'plugin-config', order: 30, renderer: 'plugin-config' },
  { key: 'platforms', label: '平台接入', icon: 'platforms', order: 40, renderer: 'platforms' },
  { key: 'files', label: '文件管理', icon: 'files', order: 50, renderer: 'files' },
  { key: 'logs', label: '日志', icon: 'logs', order: 60, renderer: 'logs' },
];

export const configSchema: ConfigSchema = {
  port: { type: 'number', label: '端口', default: 3000, description: 'Web 管理界面的 HTTP 端口' },
  host: { type: 'string', label: '监听地址', default: '127.0.0.1', description: '绑定的 IP 地址，0.0.0.0 可对外访问' },
  fileRoot: {
    type: 'string',
    label: '文件浏览根',
    default: 'workspace',
    description: '文件管理页面使用的 storage 根 ID，默认 workspace',
  },
  autoOpen: {
    type: 'boolean',
    label: '启动时自动打开浏览器',
    default: true,
    description: '启动时以含 token 的 URL 自动开启默认浏览器；SSH/headless 环境建议关闭',
  },
  tokenMode: {
    type: 'select',
    label: 'Token 策略',
    default: 'persist',
    options: [
      { label: '每次启动随机生成（重启即轮换）', value: 'ephemeral' },
      { label: '首次生成后持久化（重启不掉登录）', value: 'persist' },
      { label: '使用下方固定 token', value: 'fixed' },
      { label: '禁用 token 登录（仅账户密码；无账户时 token 兜底生效）', value: 'disabled' },
    ],
    description:
      'ephemeral=旧行为；persist=token 写入 data/.webui-token，读取复用；fixed=使用 fixedToken 字段；disabled=多用户部署收口——存在登录账户时 token 全面失效（防 root 后门），无账户时仍以 persist 语义兜底防锁死。所有模式下都会同时写出便利文件 data/webui-access.txt 包含访问 URL。',
  },
  fixedToken: {
    type: 'string',
    label: '固定 Token（仅 tokenMode=fixed 生效）',
    default: '',
    description: '请使用足够长的随机字符串。生产环境强烈建议通过环境变量或受限文件保存。',
  },
  relationGraphDefaultSpacing: {
    type: 'number',
    label: '关系图默认密度',
    default: 120,
    description:
      '关系图（RelationGraph）布局密度的服务器默认值（约等于理想边长 px，建议 60–250；越大越稀疏）。前端每个用户可在图工具栏现场覆盖并保存到本地浏览器；改完此项后，刷新关系图页面或新会话生效。',
  },
  marketplaceRegistry: {
    type: 'string',
    label: '插件市场 npm 源',
    default: 'https://registry.npmjs.org',
    description:
      '插件市场检索用的 npm registry 基址。注意 npm 的 search API 并非所有镜像都支持（淘宝等国内源不支持），默认官方源；国内可填支持 search 的镜像或代理。安装走 package-manager（遵循本机 npm 配置）。',
  },
  client: {
    type: 'string',
    label: '活跃前端（多前端时选用）',
    default: '',
    description:
      '装了多个前端（aalis.client 包）时指定哪个为活跃前端，填包名（如 @aalis/plugin-webui-client）。留空 = 自动选第一个发现到的（默认前端优先）。插件主动 provide(webui-client) 仍优先于此。',
  },
};

export const defaultConfig = {
  port: 3000,
  host: '127.0.0.1',
  fileRoot: 'workspace',
  autoOpen: true,
  tokenMode: 'persist',
  fixedToken: '',
  relationGraphDefaultSpacing: 120,
  marketplaceRegistry: 'https://registry.npmjs.org',
  client: '',
};

// ===== 配置 =====

interface WebUIConfig {
  port: number;
  host: string;
  fileRoot: string;
  autoOpen: boolean;
  tokenMode: 'ephemeral' | 'persist' | 'fixed' | 'disabled';
  fixedToken: string;
  relationGraphDefaultSpacing: number;
  marketplaceRegistry: string;
  /** 多前端时指定活跃前端包名；留空=自动选第一个 */
  client: string;
}

// ===== WebSocket 消息协议 =====

// 入站消息类型 + 校验 schema 见 ./protocol.ts（zod 强校验）
import { type WSIncoming, WSIncomingSchema } from './protocol.js';

export { type WSIncoming, WSIncomingSchema } from './protocol.js';

interface WSOutgoing {
  type:
    | 'message'
    | 'stream'
    | 'stream_resume'
    | 'status'
    | 'log'
    | 'tool_call'
    | 'state_changed'
    | 'sessions_changed'
    | 'history_changed'
    | 'todo_updated'
    | 'restarting'
    | 'reload'
    | 'confirm'
    | 'token_usage'
    | 'compressing'
    | 'page_refresh';
  content?: string;
  sessionId?: string;
  reasoningContent?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
  toolLimitReached?: boolean;
  /** 流式生成期间：本次增量更新的单个工具调用进度（OpenAI/DeepSeek 在 tool_call 阶段不发文本，UI 显示「正在生成」）。
   *  多工具并发场景下，每个 chunk 只携带其中一个 index 的更新；客户端按 index 维护自己的 Map。 */
  toolCallProgress?: {
    index: number;
    name: string;
    charsAccumulated: number;
  };
  /** 仅 stream_resume 携带：重连时所有仍在生成中的工具调用快照（按 index 升序） */
  toolCallsProgress?: Array<{
    index: number;
    name: string;
    charsAccumulated: number;
    startedAt: number;
  }>;
  status?: Record<string, unknown>;
  log?: LogEntry;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolPhase?: 'start' | 'end';
  segments?: Array<
    | { type: 'text'; content: string }
    | { type: 'reasoning_text'; content: string }
    | {
        type: 'tool_call';
        name: string;
        args: Record<string, unknown>;
        result?: string;
        startTime?: number;
        endTime?: number;
      }
  >;
  /** assistant 消息附件（agent 通过 send_attachment 等工具产生的图片/媒体） */
  attachments?: Array<{
    kind: 'image' | 'audio' | 'video' | 'file';
    data: string;
    mimeType?: string;
    name?: string;
  }>;
  todoItems?: unknown[];
  /** 仅 message 类型携带：本轮 LLM 元数据，实时展示模型名/token 用量/耗时 */
  modelInfo?: {
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    elapsedMs?: number;
  };
  /** page_refresh：通知前端某个插件相关的动态页面刷新数据源。pluginName 缺省 = 全部。 */
  pluginName?: string;
  // token_usage 字段
  tokenUsage?: {
    contextWindow: number;
    maxTokens: number;
    tokenBudget: number;
    used: number;
    usageRatio: number;
    breakdown: {
      system: number;
      persona: number;
      memorySummary: number;
      memoryVector: number;
      skills: number;
      platform: number;
      subtask: number;
      systemOther: number;
      history: number;
      toolResults: number;
      toolDefs: number;
      reservedForReply: number;
    };
  };
}

// ===== 日志文件读取（与 src/runtime/file-logger.ts 的格式对偶）=====
// 行格式契约（format ↔ parse）由 @aalis/core 的 parseLogLine 唯一持有，此处只负责
// 读取 data/latest.log（启动覆盖的单一历史源）并按 cursor 尾读分页。

const LOG_FILE_PATH = resolve(process.cwd(), 'data/latest.log');

async function readAllLogEntries(): Promise<LogEntry[]> {
  if (!existsSync(LOG_FILE_PATH)) return [];
  const raw = await readFile(LOG_FILE_PATH, 'utf8');
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const entry = parseLogLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

async function readLogFileTail(limit: number): Promise<LogEntry[]> {
  const all = await readAllLogEntries();
  return all.slice(-limit);
}

async function readLogFileBefore(beforeSeq: number, limit: number): Promise<LogEntry[]> {
  const all = await readAllLogEntries();
  const filtered = all.filter(e => e.seq < beforeSeq);
  return filtered.slice(-limit);
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const uiConfig: WebUIConfig = {
    port: (config.port as number) ?? 3000,
    host: (config.host as string) ?? '127.0.0.1',
    fileRoot: (config.fileRoot as string) || 'workspace',
    autoOpen: (config.autoOpen as boolean | undefined) ?? true,
    tokenMode: ['ephemeral', 'fixed', 'disabled'].includes(config.tokenMode as string)
      ? (config.tokenMode as 'ephemeral' | 'fixed' | 'disabled')
      : 'persist',
    fixedToken: (config.fixedToken as string) ?? '',
    relationGraphDefaultSpacing: (() => {
      const v = Number(config.relationGraphDefaultSpacing);
      return Number.isFinite(v) && v > 0 ? v : 120;
    })(),
    marketplaceRegistry: (config.marketplaceRegistry as string)?.trim() || 'https://registry.npmjs.org',
    client: (config.client as string)?.trim() ?? '',
  };

  // 创建 storage gateway；所有文件读写（token、access、文件管理）都走这里
  const storage: StorageService = createStorageGateway(ctx);

  // ---- Token 解析 ----
  // - ephemeral：每次启动随机生成（旧行为）
  // - persist：首次生成后写入 storage data:/webui/token，重启复用（默认）
  // - fixed：使用 fixedToken 配置项；为空时降级为 persist
  // 所有模式都会写出 data:/webui/access.txt 便于查找访问 URL
  const tokenFileUri = 'data:/webui/token';
  const accessFileUri = 'data:/webui/access.txt';

  async function resolveAuthToken(): Promise<string> {
    if (uiConfig.tokenMode === 'fixed' && uiConfig.fixedToken.trim()) {
      return uiConfig.fixedToken.trim();
    }
    // disabled 模式仍按 persist 语义产出 token：无账户时作为兜底登录方式
    if (uiConfig.tokenMode === 'persist' || uiConfig.tokenMode === 'fixed' || uiConfig.tokenMode === 'disabled') {
      try {
        const raw = await storage.readFile(tokenFileUri, 'utf-8');
        const existing = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
        if (existing) return existing;
      } catch {
        /* not exists or unreadable */
      }
      const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
      try {
        await storage.writeFile(tokenFileUri, fresh);
      } catch (err) {
        ctx.logger.warn(`持久化 token 失败，本次仍可使用但重启会再生成: ${(err as Error).message}`);
      }
      return fresh;
    }
    // ephemeral
    return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
  }

  async function writeAccessFile(url: string, token: string): Promise<void> {
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
    } catch (err) {
      ctx.logger.warn(`写入访问文件失败: ${(err as Error).message}`);
    }
  }

  const authToken = await resolveAuthToken();
  // 账户校验惰性委托 authority 服务（可能晚于本插件激活/被热替换），账户即
  // platform='webui' 且带密码凭据的用户记录。
  const auth = createAuthSystem(
    authToken,
    ctx.logger.child('auth'),
    {
      verify: (username, password) =>
        ctx.getService<AuthorityService>('authority')?.verifyPassword('webui', username, password) ?? false,
      hasAccounts: () =>
        (ctx.getService<AuthorityService>('authority')?.listUsers() ?? []).some(
          u => u.platform === 'webui' && u.hasPassword,
        ),
    },
    // disabled：存在账户时 token 全面失效（auth 内部留有"无账户兜底"防锁死）
    () => uiConfig.tokenMode !== 'disabled',
  );

  const expressApp = express();
  expressApp.use(express.json({ limit: '10mb' }));
  expressApp.use(auth.middleware);
  // REST 路由权限闸（连接级认证之上的身份级裁决，见 gate.ts 分层说明）
  const gate = createRouteGate(ctx, auth.identify);

  // 当前调用者信息（middleware 已拦未认证；identity 必存在）
  expressApp.get('/api/auth/me', (req, res) => {
    const identity = auth.identify(req) ?? { platform: 'webui', userId: 'console' };
    const authority = ctx.getService<AuthorityService>('authority');
    res.json({
      identity,
      isOwner: authority?.isOwner(identity.platform, identity.userId) ?? false,
    });
  });
  const server = createServer(expressApp);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, cb) => {
      if (auth.verifyWsClient(info.req)) cb(true);
      else cb(false, 401, 'unauthenticated');
    },
  });
  const sessions = new Map<string, Set<WebSocket>>();
  const logSubscribers = new Set<WebSocket>();
  const allClients = new Set<WebSocket>();

  // 流式生成缓冲区：记录每个 session 正在生成中的累积内容，用于刷新后恢复。
  // segments 是按到达顺序追加的统一时间线：text / reasoning_text / tool_call 三种段都按真实时序混排。
  // content / reasoningContent 仅作为派生镜像（供老路径读取与 LLM 调用边界使用）。
  type BufferSegment =
    | { type: 'text'; content: string }
    | { type: 'reasoning_text'; content: string }
    | {
        type: 'tool_call';
        name: string;
        args: Record<string, unknown>;
        result?: string;
        startTime?: number;
        endTime?: number;
      };
  const streamBuffers = new Map<
    string,
    {
      content: string;
      reasoningContent: string;
      segments: BufferSegment[];
      generating: boolean;
      /** 当前正在生成的所有 tool_call 进度（按 index 索引，done 或首个 phase='start' 后清空） */
      toolCallsProgress: Map<number, { name: string; charsAccumulated: number; startedAt: number }>;
    }
  >();

  // 延迟清理 streamBuffers：捕获要删的 buf 引用，10s 后仅当 (a) 该 session 仍是
  // 同一个 buf 且 (b) 未重新进入生成态 时才删——防止 10s 内开始的新一轮生成被旧
  // 定时器误删（审计 HIGH #8 竞态）。
  const scheduleBufferCleanup = (sid: string, captured: { generating: boolean }): void => {
    setTimeout(() => {
      if (streamBuffers.get(sid) === captured && !captured.generating) streamBuffers.delete(sid);
    }, 10_000);
  };

  // Token 用量缓存：记录每个 session 最近一次的 token 用量，用于刷新/切换会话后立即展示
  const tokenUsageCache = new Map<string, WSOutgoing>();

  // 获取核心服务（通过服务注册获取）
  const getApp = (): AppService | undefined => ctx.getService<AppService>('app');
  const getPluginMgr = (): PluginManagerService | undefined => ctx.getService<PluginManagerService>('plugins');

  // 前端静态文件托管（由 webui-client 插件通过 setClientDir 挂载）
  // server 注册服务名 'webui-server'，client 通过 capabilities 匹配版本
  let clientDist = '';
  let staticMiddleware: express.RequestHandler | null = null;

  function mountStaticDir(dir: string): void {
    if (existsSync(dir)) {
      staticMiddleware = express.static(dir);
      ctx.logger.info(`前端静态目录: ${dir}`);
    } else {
      staticMiddleware = null;
      ctx.logger.warn(`前端目录不存在: ${dir}`);
    }
  }

  // 已发现的前端候选 + 当前活跃 id（供「切换活跃前端」UI 读/写；ready 时填充）。
  const clientCandidates: Array<{ id: string; label: string; dir: string }> = [];
  let activeClientId = '';
  /** 切换活跃前端：实时重挂静态目录 + 更新 SPA 回退 + 持久化 webui.client，下次启动沿用。 */
  function activateClient(id: string): boolean {
    const c = clientCandidates.find(x => x.id === id);
    if (!c) return false;
    clientDist = c.dir;
    mountStaticDir(c.dir);
    activeClientId = id;
    ctx.config.setPluginConfig(name, { ...ctx.config.getPluginConfig(name), client: id });
    ctx.config.save();
    ctx.logger.info(`活跃前端切换为: ${c.label} (${id})`);
    return true;
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

  // 获取系统状态
  expressApp.get('/api/status', gate('webui:status:read', 'public'), (_req, res) => {
    const persona = ctx.getService<PersonaService>('persona');
    // 判断上传能力
    const hasMedia = ctx.hasService('media');
    const llmHasVision = ctx.getServiceCapabilities('llm').includes('vision');
    const hasFileReader = ctx.hasService('file-reader');

    res.json({
      name: persona?.getPersonaName() ?? ctx.config.get('name'),
      services: {
        'webui-server': ctx.hasService('webui-server'),
        cli: ctx.hasService('cli'),
        llm: ctx.hasService('llm'),
        agent: ctx.hasService('agent'),
        memory: ctx.hasService('memory'),
        persona: ctx.hasService('persona'),
      },
      /** 上传能力：客户端据此决定显示哪些上传按钮 */
      uploadCapabilities: {
        /** 是否支持图片上传（media 可用 或 LLM 声明了 vision） */
        image: hasMedia || llmHasVision,
        /** 是否支持文件上传（file-reader 可用） */
        file: hasFileReader,
      },
      tools:
        ctx
          .getService<ToolService>('tools')
          ?.getAll()
          .map(t => t.name) ?? [],
      commands: ctx
        .getService<CommandService>('commands')
        ?.getAll()
        .map(c => ({
          name: c.name,
          description: c.description,
          visibility: c.visibility,
        })),
    });
  });

  // ---------- 插件管理 + 全局配置 ----------
  registerPluginRoutes(expressApp, ctx, getApp, getPluginMgr, auth.identify, gate);
  registerMarketplaceRoutes(expressApp, ctx, getPluginMgr, gate, uiConfig.marketplaceRegistry);

  // 获取历史日志：从 data/latest.log 读尾部 N 条（lazy load）。
  // 单进程内 LogHub 不再缓存 buffer——历史以文件为单一数据源。
  expressApp.get('/api/logs', gate('webui:logs:read', 'restricted'), async (_req, res) => {
    try {
      const entries = await readLogFileTail(200);
      res.json(entries);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 尾部 N 条（首屏 / 显式刷新）
  expressApp.get('/api/logs/tail', gate('webui:logs:read', 'restricted'), async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 5000);
    try {
      res.json(await readLogFileTail(limit));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 历史分页：返回 seq < before 的最近 limit 条（向上滚动加载更早）
  expressApp.get('/api/logs/range', gate('webui:logs:read', 'restricted'), async (req, res) => {
    const before = Number(req.query.before);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 5000);
    if (!Number.isFinite(before)) {
      res.status(400).json({ error: 'before query param required' });
      return;
    }
    try {
      res.json(await readLogFileBefore(before, limit));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // 获取服务列表（含提供者信息）
  expressApp.get('/api/services', gate('webui:services:read', 'public'), async (_req, res) => {
    const pluginMgr = getPluginMgr();
    const pluginStatus = pluginMgr ? pluginMgr.getStatus() : [];
    const displayNameMap = new Map<string, string>();
    for (const p of pluginStatus) {
      if (p.displayName) {
        displayNameMap.set(p.name, p.displayName);
        displayNameMap.set(p.instanceId, p.displayName);
      }
    }

    const serviceNames = ctx.getServiceNames();
    const services: Record<
      string,
      {
        providers: Array<{
          contextId: string;
          capabilities: string[];
          displayName?: string;
          label?: string;
          priority: number;
        }>;
        preferred: string | null;
      }
    > = {};

    for (const svcName of serviceNames) {
      // getServiceEntries 已经按「偏好 > 优先级 > 注册顺序」排序，附带 priority 字段
      const entries = ctx.getServiceEntries(svcName);
      services[svcName] = {
        providers: entries.map(e => ({
          contextId: e.contextId,
          capabilities: [...e.capabilities],
          displayName: displayNameMap.get(e.contextId),
          label: e.label,
          priority: e.priority,
        })),
        preferred: ctx.getPreferredService(svcName) ?? null,
      };
    }

    res.json({ services });
  });

  /**
   * 设置服务偏好。body: { contextId: string }
   * 偏好语义：`preferred > priority > 注册顺序`。持久化到 aalis.config.yaml 的 servicePreferences。
   */
  expressApp.post('/api/services/:name/prefer', gate('webui:services:manage', 'restricted'), async (req, res) => {
    const svcName = String(req.params.name);
    const contextId = String((req.body as { contextId?: string })?.contextId ?? '').trim();
    if (!contextId) {
      res.status(400).json({ ok: false, error: 'contextId required' });
      return;
    }
    // 校验 entry 存在
    const entries = ctx.getServiceEntries(svcName);
    if (!entries.some(e => e.contextId === contextId)) {
      res.status(404).json({ ok: false, error: `service "${svcName}" has no provider with contextId "${contextId}"` });
      return;
    }
    ctx.preferService(svcName, contextId);
    ctx.config.setServicePreference(svcName, contextId);
    ctx.config.save();
    res.json({ ok: true });
  });

  /** 清除服务偏好 */
  expressApp.delete('/api/services/:name/prefer', gate('webui:services:manage', 'restricted'), async (req, res) => {
    const svcName = String(req.params.name);
    ctx.unpreferService(svcName);
    ctx.config.removeServicePreference(svcName);
    ctx.config.save();
    res.json({ ok: true });
  });

  // 前端切换：列出已发现的前端 + 当前活跃（多前端时 UI 展示）。只回 id/label/active，不泄露 fs 路径。
  expressApp.get('/api/clients', gate('webui:status:read', 'public'), (_req, res) => {
    res.json({
      clients: clientCandidates.map(c => ({ id: c.id, label: c.label, active: c.id === activeClientId })),
      active: activeClientId,
    });
  });
  // 设活跃前端（owner）：实时重挂 + 持久化；前端切完自行 reload 即加载新前端。
  expressApp.post('/api/clients/active', gate('webui:clients:manage', 'restricted'), (req, res) => {
    const id = String((req.body as { id?: string })?.id ?? '').trim();
    if (!activateClient(id)) {
      res.status(404).json({ ok: false, error: `未找到已发现的前端 "${id}"` });
      return;
    }
    res.json({ ok: true, active: id });
  });

  // 获取所有平台适配器及其连接状态
  expressApp.get('/api/platforms', gate('webui:status:read', 'public'), (_req, res) => {
    res.json({ platforms: aggregatePlatformDetails(ctx) });
  });

  // 获取已注册的工具分组（含元数据 + 各组工具数量 + 贡献插件列表）
  expressApp.get('/api/tool-groups', gate('webui:status:read', 'public'), (_req, res) => {
    const groups = ctx.getService<ToolService>('tools')?.getGroups() ?? [];
    const allTools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    const knownNames = new Set(groups.map(g => g.name));
    const result = groups.map(g => {
      const toolsInGroup = allTools.filter(t => t.groups?.includes(g.name));
      // 贡献插件 = 该分组下所有工具的 pluginName 去重（可能跨多个插件，
      // 例如 'session-history' 同时被 plugin-tool-session 与 plugin-memory-history 贡献）
      const contributingPlugins = [...new Set(toolsInGroup.map(t => t.pluginName))].sort();
      return { ...g, toolCount: toolsInGroup.length, contributingPlugins };
    });
    // 兜底：未声明任何 group 或 group 不在已注册集合中的工具，聚成 "other" 组
    const orphans = allTools.filter(t => {
      const gs = t.groups ?? [];
      return gs.length === 0 || gs.every(n => !knownNames.has(n));
    });
    if (orphans.length > 0) {
      result.push({
        name: 'other',
        label: '其他',
        description: '未声明分组的工具',
        pluginName: '(system)',
        toolCount: orphans.length,
        contributingPlugins: [...new Set(orphans.map(t => t.pluginName))].sort(),
      });
    }
    res.json({ groups: result });
  });

  // 获取服务分组（manifest 驱动：每个插件自己声明 subsystem，本路由仅聚合）
  expressApp.get('/api/service-groups', gate('webui:status:read', 'public'), (_req, res) => {
    const pluginMgr = getPluginMgr();
    const pluginStatus = pluginMgr ? pluginMgr.getStatus() : [];
    // 按插件 subsystem 归组（未声明 → 'external'）。subsystem 是 WebUI 展示概念、
    // 由 @aalis/plugin-webui-api 声明合并到 PluginModule，core 状态契约不含——从 module 直接读。
    const groupsMap = new Map<string, Array<{ name: string; provides: string[] }>>();
    for (const p of pluginStatus) {
      const sub = pluginMgr?.getPlugin(p.instanceId)?.module?.subsystem ?? 'external';
      if (!groupsMap.has(sub)) groupsMap.set(sub, []);
      groupsMap.get(sub)!.push({ name: p.name, provides: p.provides ?? [] });
    }
    // 排序：DEFAULT_SUBSYSTEM_METADATA 已知 id 优先按 order 排，未知 id 以 id 作为 label，order=9999
    const meta = new Map(DEFAULT_SUBSYSTEM_METADATA.map(e => [e.id, e]));
    const sorted = [...groupsMap.keys()]
      .map(id => {
        const m = meta.get(id);
        return m ? { id, label: m.label, order: m.order } : { id, label: id, order: 9999 };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    // First-claim-wins：服务名只归入最先（order 最小）声明它的组，避免同一服务出现在多个分组
    const servicesClaimed = new Set<string>();
    const groups = sorted.map(({ id, label }) => {
      const plugins = groupsMap.get(id)!;
      const services = [...new Set(plugins.flatMap(p => p.provides))].filter(s => {
        if (servicesClaimed.has(s)) return false;
        servicesClaimed.add(s);
        return true;
      });
      return { id, label, plugins, services };
    });
    // 系统内建服务（app、plugins 等由 core 直接 provide，不属于任何插件）
    const systemServices = ctx.getServiceNames().filter(n => !servicesClaimed.has(n));
    if (systemServices.length > 0) {
      const sysLabel = meta.get('system')?.label ?? '系统';
      groups.unshift({ id: 'system', label: sysLabel, plugins: [], services: systemServices });
    }
    res.json({ groups });
  });

  // 获取所有 LLM 模型（枚举所有注册的 per-model entry）
  expressApp.get('/api/llm-models', gate('webui:llm:read', 'restricted'), async (_req, res) => {
    try {
      const entries = ctx.getAllServices<LLMModel>('llm');
      const models: ModelInfo[] = entries.map(e => ({
        id: e.instance.id,
        capabilities: e.capabilities,
        provider: e.instance.providerId,
        contextId: e.contextId,
      }));
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  });

  // LLM providers + per-provider models（供 schema type='llm-ref' 联动 select 使用）
  expressApp.get('/api/llm-providers', gate('webui:llm:read', 'restricted'), async (_req, res) => {
    try {
      const entries = ctx.getAllServices<LLMModel>('llm');
      type ProvAgg = {
        contextId: string;
        label?: string;
        models: Array<{ id: string; capabilities: string[]; contextLength?: number }>;
      };
      const byProvider = new Map<string, ProvAgg>();
      // entry.label 形如 "Ollama (localhost:11434) / qwen3.6:35b-mlx"；
      // 取第一个 " / " 之前的部分作为 providerLabel（避免把 model id 也带进去）。
      const extractProviderLabel = (raw?: string): string | undefined => {
        if (!raw) return undefined;
        const slash = raw.indexOf(' / ');
        return slash > 0 ? raw.slice(0, slash) : raw;
      };
      for (const e of entries) {
        const providerId = e.instance.providerId;
        let agg = byProvider.get(providerId);
        if (!agg) {
          agg = { contextId: providerId, label: extractProviderLabel(e.label), models: [] };
          byProvider.set(providerId, agg);
        } else if (!agg.label) {
          agg.label = extractProviderLabel(e.label);
        }
        agg.models.push({
          id: e.instance.id,
          capabilities: e.capabilities,
          contextLength: e.instance.contextLength,
        });
      }
      res.json({ providers: [...byProvider.values()] });
    } catch {
      res.json({ providers: [] });
    }
  });

  // 触发指定 provider 重新探测远端模型列表（用于 webui 上的"刷新模型"按钮）
  // 仅对在 LLMModel 上实现了 refresh() 的 provider 生效（远端动态发现型，如 Ollama / OpenAI）。
  // 同 provider 下所有 model entries 共享同一份 refresh 闭包，调任一个 entry 即可。
  expressApp.post('/api/llm-providers/:contextId/refresh', gate('webui:llm:manage', 'restricted'), async (req, res) => {
    const contextId = req.params.contextId;
    if (!contextId) {
      res.status(400).json({ error: 'contextId is required' });
      return;
    }
    try {
      const llmEntries = ctx.getAllServices<LLMModel>('llm');
      const target = llmEntries.find(e => e.contextId === contextId && typeof e.instance.refresh === 'function');
      if (!target) {
        res.status(404).json({
          error: `no refreshable LLM provider registered for contextId="${contextId}" (provider 可能为静态注册型，不支持运行时刷新)`,
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
  expressApp.get('/api/models/:service', gate('webui:models:read', 'public'), async (req, res) => {
    const serviceName = req.params.service;

    // 特殊处理 platform：通过 helper 获取已注册的平台名称
    if (serviceName === 'platform') {
      res.json({ models: getPlatformNames(ctx) });
      return;
    }

    // 特殊处理 gateway-scopes：基于已注册 adapter.sessionTypes 真实声明生成
    // platform×sessionType 的笛卡尔积。无声明的 adapter 视为单会话（不展开 sessionType）。
    if (serviceName === 'gateway-scopes') {
      const adapters = getPlatformAdapters(ctx);
      const platformTypes = new Map<string, readonly string[]>();
      const allTypes = new Set<string>();
      for (const a of adapters) {
        const types = a.sessionTypes ?? [];
        platformTypes.set(a.platform, types);
        for (const t of types) allTypes.add(t);
      }
      const scopes: Array<{ value: string; label: string }> = [];
      scopes.push({ value: '*', label: '* （全部平台 × 全部类型）' });
      for (const t of [...allTypes].sort()) {
        scopes.push({ value: `*:${t}`, label: `*:${t} （所有平台的 ${t} 会话）` });
      }
      for (const [p, types] of platformTypes) {
        if (types.length === 0) {
          // 单会话平台 (cli/webui)：只列 platform 通配
          scopes.push({ value: `${p}:*`, label: `${p}:* （${p} 单会话）` });
        } else {
          scopes.push({ value: `${p}:*`, label: `${p}:* （${p} 全部类型）` });
          for (const t of types) scopes.push({ value: `${p}:${t}`, label: `${p}:${t}` });
        }
      }
      res.json({ models: scopes.map(s => s.value), details: scopes });
      return;
    }

    // 特殊处理 toolGroups：优先从工具分组注册表获取，回退到扫描工具
    if (serviceName === 'toolGroups') {
      const groups = ctx.getService<ToolService>('tools')?.getGroups() ?? [];
      if (groups.length > 0) {
        res.json({
          models: groups.map(g => g.name).sort(),
          details: groups.map(g => ({
            value: g.name,
            label: g.label,
            description: g.description,
            pluginName: g.pluginName,
          })),
        });
      } else {
        // 回退：从已注册工具中提取分组名称
        const tools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
        const groupSet = new Set<string>();
        for (const t of tools) {
          t.groups?.forEach((g: string) => {
            groupSet.add(g);
          });
        }
        res.json({ models: [...groupSet].sort() });
      }
      return;
    }

    // LLM 走 per-model entry 枚举（每个 entry 已对应一个具体 model，不再依赖 provider.listModels）
    if (serviceName === 'llm') {
      try {
        const entries = ctx.getAllServices<LLMModel>('llm');
        const aggregated = entries.map(e => ({
          value: `${e.contextId}::${e.instance.id}`,
          model: e.instance.id,
          provider: e.label ?? e.contextId,
          contextId: e.contextId,
          capabilities: e.capabilities,
        }));
        res.json({ models: aggregated.map(a => a.value), providers: aggregated });
      } catch {
        res.json({ models: [] });
      }
      return;
    }

    const service = ctx.getService<{ listModels?(): Promise<unknown[]> }>(serviceName);
    if (!service || typeof service.listModels !== 'function') {
      res.json({ models: [] });
      return;
    }
    try {
      // 聚合所有提供者的模型列表（embedding 等服务仍走 listModels()）。
      const allProviders = ctx.getAllServices<{ listModels?(): Promise<unknown[]> }>(serviceName);
      const aggregated: Array<{
        value: string;
        model: string;
        provider: string;
        contextId: string;
        capabilities: string[];
      }> = [];
      const flatValues: string[] = [];

      for (const provider of allProviders) {
        if (typeof provider.instance.listModels !== 'function') continue;
        try {
          const models = await provider.instance.listModels();
          for (const m of models) {
            const isModelInfo = typeof m === 'object' && m !== null && 'id' in m;
            const modelId = isModelInfo ? ((m as Record<string, unknown>).id as string) : String(m);
            const modelCaps = isModelInfo
              ? ((m as Record<string, unknown>).capabilities as string[])
              : provider.capabilities;
            aggregated.push({
              value: modelId,
              model: modelId,
              provider: provider.label ?? provider.contextId,
              contextId: provider.contextId,
              capabilities: modelCaps,
            });
            flatValues.push(modelId);
          }
        } catch {
          // 单个提供者获取模型失败不影响整体
        }
      }

      res.json({ models: flatValues, providers: aggregated });
    } catch {
      res.json({ models: [] });
    }
  });

  // ---------- 受限操作交互式确认（内联对话式；restricted 能力的临时委托） ----------

  const CONFIRM_TIMEOUT = 60_000; // 60 秒超时
  /** 每个 session 最多一个待确认请求 */
  type PendingConfirmResult =
    | boolean
    | { allowed: boolean; grant?: { scope: 'once' | 'session'; durationSeconds?: number; maxUses?: number } };
  const pendingSessionConfirms = new Map<
    string,
    { resolve: (v: PendingConfirmResult) => void; timer: ReturnType<typeof setTimeout> }
  >();

  ctx.getService<AuthorityService>('authority')?.setConfirmHandler('webui', async request => {
    const typeLabel = request.type === 'command' ? '指令' : '工具';
    const nameStr = request.type === 'command' ? `/${request.name}` : request.name;
    const prompt = `⚠️ ${typeLabel} ${nameStr} 是受限操作。回复 Y 仅允许本次；回复 YS 允许本会话 10 分钟；其他任意输入取消。`;

    // 以确认消息形式发送（不影响客户端 loading/streaming 状态）
    const payload: WSOutgoing = {
      type: 'confirm',
      content: prompt,
      sessionId: request.sessionId,
    };
    const json = JSON.stringify(payload);

    const sockets = sessions.get(request.sessionId);
    const targets = sockets && sockets.size > 0 ? sockets : allClients;
    let sent = false;
    for (const ws of targets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
        sent = true;
      }
    }
    if (!sent) return false;

    // 同一 session 已有未决确认时，先取消旧的（清 timer + resolve false），避免新
    // set 覆盖后旧 Promise 永远 pending 且旧 timer 误删新条目（审计 HIGH #7 竞态）。
    const stale = pendingSessionConfirms.get(request.sessionId);
    if (stale) {
      clearTimeout(stale.timer);
      pendingSessionConfirms.delete(request.sessionId);
      stale.resolve(false);
    }

    return new Promise<PendingConfirmResult>(resolve => {
      const timer = setTimeout(() => {
        pendingSessionConfirms.delete(request.sessionId);
        // 超时后向会话发送提示
        const timeoutPayload: WSOutgoing = {
          type: 'confirm',
          content: '⏰ 受限操作确认已超时，已自动取消。',
          sessionId: request.sessionId,
        };
        const timeoutJson = JSON.stringify(timeoutPayload);
        for (const ws of targets) {
          if (ws.readyState === WebSocket.OPEN) ws.send(timeoutJson);
        }
        resolve(false);
      }, CONFIRM_TIMEOUT);
      pendingSessionConfirms.set(request.sessionId, { resolve, timer });
    });
  });

  // ---------- 文件管理 API ----------
  registerFileRoutes(expressApp, ctx, { storage, fileRoot: uiConfig.fileRoot }, gate);
  registerUploadedFilesRoutes(expressApp, ctx, { storage }, gate);
  registerProxyRoutes(expressApp, ctx, gate);

  // ---------- WebSocket ----------

  wss.on('connection', (ws, req) => {
    // 连接建立时解析一次调用者身份（cookie 在升级请求里；verifyClient 已保证已认证）
    const wsIdentity = auth.identify(req) ?? { platform: 'webui', userId: 'console' };
    ctx.logger.debug(`WebUI 客户端已连接: ${wsIdentity.platform}:${wsIdentity.userId}`);
    allClients.add(ws);

    ws.on('message', async data => {
      try {
        const parseResult = WSIncomingSchema.safeParse(JSON.parse(data.toString()));
        if (!parseResult.success) {
          ctx.logger.warn(
            `WebUI 收到协议违规消息: ${parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
          return;
        }
        const msg: WSIncoming = parseResult.data;

        if (msg.type === 'subscribe_logs') {
          logSubscribers.add(ws);
          return;
        }

        // 客户端连接时主动注册会话，确保 scheduler 等异步消息能推送
        if (msg.type === 'subscribe_session') {
          const sid = msg.sessionId || 'webui-default';
          if (!sessions.has(sid)) {
            sessions.set(sid, new Set());
          }
          sessions.get(sid)!.add(ws);
          // 如果该会话正在生成中，发送已累积的内容供客户端恢复
          const buf = streamBuffers.get(sid);
          if (
            buf &&
            (buf.content || buf.reasoningContent || buf.segments.length > 0 || buf.toolCallsProgress.size > 0)
          ) {
            const resume: WSOutgoing = {
              type: 'stream_resume',
              sessionId: sid,
              content: buf.content,
              reasoningContent: buf.reasoningContent,
              segments: buf.segments.length > 0 ? buf.segments : undefined,
              toolCallsProgress:
                buf.toolCallsProgress.size > 0
                  ? [...buf.toolCallsProgress.entries()]
                      .sort((a, b) => a[0] - b[0])
                      .map(([index, v]) => ({
                        index,
                        name: v.name,
                        charsAccumulated: v.charsAccumulated,
                        startedAt: v.startedAt,
                      }))
                  : undefined,
              done: !buf.generating,
            };
            ws.send(JSON.stringify(resume));
          }
          // 发送缓存的 token 用量，刷新/切换会话后立即展示
          const cachedUsage = tokenUsageCache.get(sid);
          if (cachedUsage) {
            ws.send(JSON.stringify(cachedUsage));
          } else {
            // 无缓存（服务重启后），请求 agent 重新计算
            ctx.emit('token:request', { sessionId: sid }).catch(() => {});
          }
          return;
        }

        if (msg.type === 'unsubscribe_session') {
          const sid = msg.sessionId || 'webui-default';
          sessions.get(sid)?.delete(ws);
          return;
        }

        if (msg.type === 'abort') {
          const sessionId = msg.sessionId || 'webui-default';
          const agent = ctx.getService<AgentService>('agent');
          if (agent?.abort) agent.abort(sessionId);
          return;
        }

        if (msg.type === 'compress') {
          const sessionId = msg.sessionId || 'webui-default';
          ctx.logger.info(`收到手动压缩请求: session=${sessionId}`);
          // 触发压缩事件（memory-summary 监听此事件，并发出 session:compressing 通知）
          ctx
            .emit('session:compress', { sessionId, reason: 'manual' })
            .then(() => {
              // 压缩完成后重新计算 token 用量并推送给客户端
              ctx.emit('token:request', { sessionId }).catch(() => {});
            })
            .catch(() => {});
          return;
        }

        if (msg.type !== 'message' || !msg.content) return;

        const sessionId = msg.sessionId || 'webui-default';
        const trimmed = msg.content.trim();

        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, new Set());
        }
        sessions.get(sessionId)!.add(ws);

        // 检查是否有待确认的受限操作（拦截用户输入作为确认/取消）
        const pending = pendingSessionConfirms.get(sessionId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingSessionConfirms.delete(sessionId);
          const answer = trimmed.toLowerCase();
          if (answer === 'ys' || answer === 'y session') {
            pending.resolve({ allowed: true, grant: { scope: 'session', durationSeconds: 600, maxUses: 30 } });
          } else {
            pending.resolve(answer === 'y');
          }
          // 不继续处理此消息，交给原始命令/工具执行流返回结果
          return;
        }

        // 指令解析已统一到全局 inbound:command 相位（plugin-commands 注册）。
        // 适配器不再内联解析命令——未注册的命令会被该相位放行为普通消息进入
        // agent，命中的命令由该相位执行并经 outbound:message 回送，与 onebot
        // 平台行为完全一致。客户端只通过 attachments 发送多模态内容。
        await ctx.emit('inbound:message', {
          content: trimmed,
          sessionId,
          platform: wsIdentity.platform,
          userId: wsIdentity.userId,
          nickname: undefined,
          ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
        });
      } catch (err) {
        ctx.logger.warn('WebUI 消息处理失败:', err);
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      logSubscribers.delete(ws);
      for (const [sid, sockets] of sessions) {
        sockets.delete(ws);
        if (sockets.size === 0) sessions.delete(sid);
      }
    });
  });

  // 实时推送日志给订阅者
  const removeLogListener = LogHub.default.onEntry((entry: LogEntry) => {
    const payload: WSOutgoing = { type: 'log', log: entry };
    const json = JSON.stringify(payload);
    for (const ws of logSubscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 插件状态级联变更后，广播通知所有前端刷新
  ctx.on('plugins:changed', () => {
    const payload: WSOutgoing = { type: 'state_changed' };
    const json = JSON.stringify(payload);
    for (const ws of allClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 重启通知：广播给所有客户端
  ctx.on('restarting', () => {
    const payload: WSOutgoing = { type: 'restarting' };
    const json = JSON.stringify(payload);
    for (const ws of allClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 会话列表变更：广播给所有客户端，让前端即时刷新
  const broadcastSessionsChanged = () => {
    const payload: WSOutgoing = { type: 'sessions_changed' };
    const json = JSON.stringify(payload);
    for (const ws of allClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  };
  // Todo 列表变更：推送给订阅了该会话的客户端
  ctx.on('todo:updated', (...args: unknown[]) => {
    const sessionId = args[0] as string;
    const items = args[1] as unknown[];
    const sockets = sessions.get(sessionId);
    if (!sockets) return;
    const payload: WSOutgoing = { type: 'todo_updated', sessionId, todoItems: items };
    const json = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  ctx.on('session:created', broadcastSessionsChanged);
  ctx.on('session:updated', broadcastSessionsChanged);
  ctx.on('session:deleted', broadcastSessionsChanged);
  ctx.on('session:completed', broadcastSessionsChanged);

  // 动态页面刷新通知：插件可通过广播 'page_refresh' 让前端无感刷新对应页面数据
  // 当前已知发射方：plugin-doctor（'doctor:updated'）。新增同类需求时按相同模式订阅即可。
  const broadcastPageRefresh = (pluginName?: string) => {
    const payload: WSOutgoing = { type: 'page_refresh', pluginName };
    const json = JSON.stringify(payload);
    for (const ws of allClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  };
  ctx.on('doctor:updated', () => broadcastPageRefresh('@aalis/plugin-doctor'));

  // 会话历史变更（如 checkpoint 回滚整轮对话）：推送给订阅该会话的客户端，让前端重新拉取历史
  ctx.on('history:changed', (...args: unknown[]) => {
    const data = args[0] as { sessionId?: string };
    const sessionId = data?.sessionId;
    if (!sessionId) return;
    const sockets = sessions.get(sessionId);
    if (!sockets) return;
    const payload: WSOutgoing = { type: 'history_changed', sessionId };
    const json = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 压缩状态通知：memory-summary 发出 session:compressing 事件，广播给订阅该会话的客户端
  ctx.on('session:compressing', (...args: unknown[]) => {
    const data = args[0] as { sessionId: string; status: string };
    const sockets = sessions.get(data.sessionId);
    if (!sockets) return;
    const payload: WSOutgoing = { type: 'compressing', sessionId: data.sessionId, content: data.status };
    const json = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 会话切换不再跨客户端广播：每个 webui 客户端独立持有自己的活跃会话（localStorage
  // 持久化 + 每条消息自带 sessionId），互不干扰。全局 activeSessionId 退化为 CLI 概念，
  // 不再驱动 webui。这样多人同时使用时，他人新建/切换会话不会把你的窗口切走。

  // 监听 AI 回复
  ctx.on('outbound:message', (msg: OutgoingMessage) => {
    // 生成完成，延迟清理缓冲区（给客户端重连拉取历史留出时间窗口）
    const buf = streamBuffers.get(msg.sessionId);
    if (buf) {
      buf.generating = false;
      buf.content = msg.content ?? buf.content;
      buf.reasoningContent = msg.reasoningContent ?? buf.reasoningContent;
      scheduleBufferCleanup(msg.sessionId, buf);
    }
    const sockets = sessions.get(msg.sessionId);
    if (!sockets) return;

    // 仅信任 msg 本身携带的 segments。不要回退到 buf?.segments：
    // 工具循环中 agent tool（如 send_attachment / commands 回复）会直接 emit 'outbound:message'，
    // 但 streamBuffers[sid].segments 累积的是当前回合的完整时间线（含本工具之前的 reasoning/tool_call）。
    // 若回退使用 buf，会把整条时间线"借尸还魂"挂到工具消息上 → 前端 REPLACE 当前 assistant 后，
    // 真正的 agent final outbound:message 再到达时被识别为新消息 APPEND，导致整条时间线渲染两遍。
    // agent 的 final emit 已显式带 segments=turnSegments，不需要这个隐式 fallback。
    const segments = msg.segments;
    const payload: WSOutgoing = {
      type: 'message',
      content: msg.content,
      sessionId: msg.sessionId,
      reasoningContent: msg.reasoningContent,
      segments: segments && segments.length > 0 ? segments : undefined,
      attachments: msg.attachments?.length
        ? msg.attachments.map(a => ({
            kind: a.kind,
            data: a.data,
            mimeType: a.mimeType,
            name: a.name,
          }))
        : undefined,
      modelInfo: msg.modelInfo,
    };
    const json = JSON.stringify(payload);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 监听流式增量推送
  ctx.on('outbound:stream', (chunk: StreamChunkMessage) => {
    // 累积到缓冲区
    if (!chunk.done) {
      let buf = streamBuffers.get(chunk.sessionId);
      if (!buf) {
        buf = { content: '', reasoningContent: '', segments: [], generating: true, toolCallsProgress: new Map() };
        streamBuffers.set(chunk.sessionId, buf);
      }
      if (chunk.contentDelta) {
        // 进入文本生成阶段：清空所有 tool 进度
        buf.toolCallsProgress.clear();
        buf.content += chunk.contentDelta;
        // 追加到 segments：合并连续 text
        const last = buf.segments[buf.segments.length - 1];
        if (last && last.type === 'text') {
          last.content += chunk.contentDelta;
        } else {
          buf.segments.push({ type: 'text', content: chunk.contentDelta });
        }
      }
      if (chunk.reasoningDelta) {
        buf.toolCallsProgress.clear();
        buf.reasoningContent += chunk.reasoningDelta;
        // 同样追加到统一时间线：合并连续 reasoning_text
        const last = buf.segments[buf.segments.length - 1];
        if (last && last.type === 'reasoning_text') {
          last.content += chunk.reasoningDelta;
        } else {
          buf.segments.push({ type: 'reasoning_text', content: chunk.reasoningDelta });
        }
      }
      if (chunk.toolCallProgress) {
        const { index, name, charsAccumulated } = chunk.toolCallProgress;
        const prev = buf.toolCallsProgress.get(index);
        buf.toolCallsProgress.set(index, {
          name,
          charsAccumulated,
          startedAt: prev?.startedAt ?? Date.now(),
        });
      }
    } else {
      // done：回合终态收口。无论本回合是正常完成、空回复、还是被用户中止，
      // agent 都会发一次 outbound:stream{done:true}（见 plugin-agent 的成功/中止/未处理三条路径）。
      // 这里必须把 generating 翻 false 并安排清理，否则刷新后 subscribe_session 仍读到
      // generating=true 的残留 buffer → 回 stream_resume{done:false} → 前端永远显示"可停止"。
      // （正常路径的 outbound:message 也会做同样的事；此处补全保证中止/静默路径对称。）
      const buf = streamBuffers.get(chunk.sessionId);
      if (buf) {
        buf.toolCallsProgress.clear();
        buf.generating = false;
        scheduleBufferCleanup(chunk.sessionId, buf);
      }
    }
    const sockets = sessions.get(chunk.sessionId);
    if (!sockets) return;

    const payload: WSOutgoing = {
      type: 'stream',
      sessionId: chunk.sessionId,
      contentDelta: chunk.contentDelta,
      reasoningDelta: chunk.reasoningDelta,
      toolCallProgress: chunk.toolCallProgress,
      done: chunk.done,
      toolLimitReached: chunk.toolLimitReached,
    };
    const json = JSON.stringify(payload);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 监听工具调用事件
  ctx.on('tool:execute', (info: ToolExecuteMessage) => {
    // 缓存工具调用到 segments
    let buf = streamBuffers.get(info.sessionId);
    if (!buf) {
      buf = { content: '', reasoningContent: '', segments: [], generating: true, toolCallsProgress: new Map() };
      streamBuffers.set(info.sessionId, buf);
    }
    if (info.phase === 'start') {
      // 工具进入实际执行阶段：清掉生成中进度（占位卡 → ToolCallBlock 切换）
      buf.toolCallsProgress.clear();
      buf.segments.push({ type: 'tool_call', name: info.toolName, args: info.args ?? {}, startTime: Date.now() });
    } else if (info.phase === 'end') {
      // 找到最后一个同名且无结果的 tool_call segment，填充结果
      for (let i = buf.segments.length - 1; i >= 0; i--) {
        const seg = buf.segments[i];
        if (seg.type === 'tool_call' && seg.name === info.toolName && seg.result == null) {
          seg.result = info.result;
          seg.endTime = Date.now();
          break;
        }
      }
    }

    const sockets = sessions.get(info.sessionId);
    if (!sockets) return;

    const payload: WSOutgoing = {
      type: 'tool_call',
      sessionId: info.sessionId,
      toolName: info.toolName,
      toolArgs: info.args,
      toolPhase: info.phase,
      toolResult: info.result,
    };
    const json = JSON.stringify(payload);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 监听 token 使用量统计事件
  ctx.on('token:usage', (...args: unknown[]) => {
    const usage = args[0] as {
      sessionId: string;
      platform: string;
      contextWindow: number;
      maxTokens: number;
      tokenBudget: number;
      used: number;
      usageRatio: number;
      breakdown: {
        system: number;
        persona: number;
        memorySummary: number;
        memoryVector: number;
        skills: number;
        platform: number;
        subtask: number;
        systemOther: number;
        history: number;
        toolResults: number;
        toolDefs: number;
        reservedForReply: number;
      };
    };
    const sockets = sessions.get(usage.sessionId);
    if (!sockets) return;

    const payload: WSOutgoing = {
      type: 'token_usage',
      sessionId: usage.sessionId,
      tokenUsage: {
        contextWindow: usage.contextWindow,
        maxTokens: usage.maxTokens,
        tokenBudget: usage.tokenBudget,
        used: usage.used,
        usageRatio: usage.usageRatio,
        breakdown: usage.breakdown,
      },
    };
    // 缓存最新的 token 用量
    tokenUsageCache.set(usage.sessionId, payload);
    const json = JSON.stringify(payload);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // SPA fallback: 所有非 API 路径返回 index.html
  expressApp.get('{*path}', (_req, res) => {
    const indexPath = resolve(clientDist, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: '前端未就绪，请安装 webui-client 插件 (如 @aalis/plugin-webui-client)' });
    }
  });

  // 启动服务器
  ctx.on('ready', () => {
    // 自动发现 webui-client 包并注册为 webui-client 服务提供者。
    // 解析以「项目根 package.json」为基准（与 runtime 的 node-modules 加载器同源），
    // 这样 npm 扁平 / pnpm 隔离 / monorepo 软链三种 node_modules 拓扑都自洽——
    // client 是项目顶层依赖（create-aalis 选 WebUI 时自动带），从项目根能 resolve 到。
    // 回退：webui-server 同级目录（cwd≠项目根等边角场景兜底）。
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const projectRequire = createRequire(pathToFileURL(resolve(process.cwd(), 'package.json')));
    const resolveClientDir = (id: string): string | undefined => {
      try {
        return resolve(dirname(projectRequire.resolve(`${id}/package.json`)), 'dist');
      } catch {
        const sibling = resolve(__dirname, `../../${id.replace('@aalis/', '')}/dist`);
        return existsSync(sibling) ? sibling : undefined;
      }
    };
    const addCandidate = (id: string, label: string, dir: string | undefined): void => {
      if (!dir || clientCandidates.some(c => c.id === id)) return;
      if (existsSync(dir) && existsSync(resolve(dir, 'index.html'))) clientCandidates.push({ id, label, dir });
    };
    // ① 已知 @aalis 前端（保证 monorepo/默认拓扑可用——根 deps 未必列 client）
    addCandidate('@aalis/plugin-webui-client', 'Aalis 默认前端', resolveClientDir('@aalis/plugin-webui-client'));
    addCandidate(
      '@aalis/plugin-webui-client-napcat',
      'NapCat 前端',
      resolveClientDir('@aalis/plugin-webui-client-napcat'),
    );
    // ② 追加发现：项目 deps 里任何带 aalis.client marker 的第三方前端（忒修斯之船可换）
    try {
      const rootPkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
      const deps = Object.keys({ ...rootPkg.dependencies, ...rootPkg.optionalDependencies });
      for (const dep of deps) {
        if (clientCandidates.some(c => c.id === dep)) continue;
        try {
          const pkgPath = projectRequire.resolve(`${dep}/package.json`);
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg?.aalis?.client !== true) continue;
          addCandidate(dep, pkg.displayName ?? pkg.description ?? dep, resolve(dirname(pkgPath), 'dist'));
        } catch {
          /* 该 dep 无法解析/读取，跳过 */
        }
      }
    } catch {
      /* 无项目根 package.json（如 monorepo 直跑），跳过 dep 扫描 */
    }

    // 如果已有外部插件主动注册了 webui-client 服务（apply 覆盖路径），则跳过自动发现
    const hasExternalClient = ctx.hasService('webui-client');
    if (!hasExternalClient && clientCandidates.length > 0) {
      // 活跃前端：config.client 指定者优先，否则取第一个（默认前端排在最前）
      const preferred = uiConfig.client && clientCandidates.find(c => c.id === uiConfig.client);
      const active = preferred || clientCandidates[0];
      for (const candidate of clientCandidates) {
        const childCtx = ctx.fork(candidate.id);
        childCtx.provide('webui-client', { getClientDir: () => candidate.dir }, { label: candidate.label });
        ctx.logger.info(`发现前端: ${candidate.label} (${candidate.dir})`);
      }
      clientDist = active.dir;
      mountStaticDir(active.dir);
      activeClientId = active.id;
      ctx.logger.info(`活跃前端: ${active.label}${preferred ? '（config.client 指定）' : ''}`);
    }

    // 若已有外部 webui-client 服务，使用其提供的目录
    if (hasExternalClient) {
      const activeClient = ctx.getService<{ getClientDir(): string }>('webui-client');
      if (activeClient?.getClientDir) {
        const dir = activeClient.getClientDir();
        clientDist = dir;
        mountStaticDir(dir);
        ctx.logger.info(`活跃前端(服务): ${dir}`);
      }
    }

    server.listen(uiConfig.port, uiConfig.host, () => {
      const url = `http://${uiConfig.host}:${uiConfig.port}/`;
      const accessUrl = `${url}?token=${authToken}`;
      void writeAccessFile(url, authToken);
      ctx.logger.info(`WebUI 已启动: ${url}`);
      const tokenHint =
        uiConfig.tokenMode === 'ephemeral'
          ? 'token 仅本次启动有效，重启轮换'
          : uiConfig.tokenMode === 'fixed'
            ? 'token 来自配置 fixedToken，固定不变'
            : 'token 已持久化到 storage data:/webui/token，重启沿用';
      ctx.logger.info(`首次访问请使用以下 URL（${tokenHint}）: ${accessUrl}`);
      void (async () => {
        let absHint = accessFileUri;
        try {
          if (storage.resolveLocalPath) {
            absHint = await storage.resolveLocalPath(accessFileUri, 'read');
          }
        } catch {
          /* ignore */
        }
        ctx.logger.info(`访问凭据已写入: ${accessFileUri}（绝对路径: ${absHint}）`);
      })();
      if (uiConfig.autoOpen) openBrowser(accessUrl, createProcessGateway(ctx));
    });
  });

  ctx.onDispose(() => {
    removeLogListener();
    wss.close();
    server.close();
  });

  // 构造 PlatformAdapter 实例
  const adapter: PlatformAdapter = {
    adapterName: 'WebUI',
    platform: 'webui',
    sessionTypes: [], // WebUI 单会话，不区分 sessionType
    getConnections(): PlatformConnection[] {
      // 统计所有活跃 WebSocket 客户端
      const activeCount = [...allClients].filter(ws => ws.readyState === WebSocket.OPEN).length;
      if (activeCount === 0) return [];
      return [
        {
          id: 'webui',
          platform: 'webui',
          status: 'online',
          detail: { clients: activeCount },
        },
      ];
    },
    async sendMessage(sessionId: string, content: string): Promise<void> {
      const sockets = sessions.get(sessionId);
      if (!sockets) return;
      const payload: WSOutgoing = {
        type: 'message',
        content,
        sessionId,
      };
      const json = JSON.stringify(payload);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(json);
        }
      }
    },
  };

  ctx.provide('platform', adapter, { capabilities: ['webui', 'text', 'image', 'file'] });

  // === 注册 WebUI 服务 ===
  const registeredPages = new Map<string, Array<WebuiPage & { pluginName: string }>>();

  // 内建页面归属为 webui-server 本身
  for (const page of webuiPages) {
    const list = registeredPages.get(name) ?? [];
    list.push({ ...page, pluginName: name });
    registeredPages.set(name, list);
  }

  const webuiService: WebUIService = {
    getPort: () => uiConfig.port,
    getHost: () => uiConfig.host,
    setClientDir(dir: string): void {
      clientDist = dir;
      mountStaticDir(dir);
      ctx.logger.info(`前端已切换: ${dir}`);
    },
    registerPage(page, pluginName) {
      const list = registeredPages.get(pluginName) ?? [];
      list.push({ ...page, pluginName });
      registeredPages.set(pluginName, list);
      return () => {
        const cur = registeredPages.get(pluginName);
        if (!cur) return;
        const idx = cur.findIndex(p => p.key === page.key);
        if (idx >= 0) cur.splice(idx, 1);
        if (cur.length === 0) registeredPages.delete(pluginName);
      };
    },
    getPages() {
      const out: Array<WebuiPage & { pluginName: string }> = [];
      for (const list of registeredPages.values()) out.push(...list);
      return out;
    },
    unregisterByPlugin(pluginName) {
      registeredPages.delete(pluginName);
    },
  };
  ctx.provide('webui-server', webuiService, { capabilities: ['api-v1'] });
}
