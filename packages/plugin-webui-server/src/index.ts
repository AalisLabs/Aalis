import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, ConfigSchema, Context, LogEntry } from '@aalis/core';
import { getLogBuffer, onLogEntry } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import type { AuthorityService } from '@aalis/plugin-authority-api';
import type { CommandService } from '@aalis/plugin-commands-api';
import type { LLMService } from '@aalis/plugin-llm-api';
import type { OutgoingMessage, StreamChunkMessage } from '@aalis/plugin-message-api';
import type { PersonaService } from '@aalis/plugin-persona';
import type { PlatformAdapter, PlatformConnection, PlatformService } from '@aalis/plugin-platform';
import type {} from '@aalis/plugin-session-manager-api';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { ToolExecuteMessage, ToolService } from '@aalis/plugin-tools-api';
import type { WebUIService, WebuiPage } from '@aalis/plugin-webui-api'; // declaration merging WebuiPage.content
import { DEFAULT_SUBSYSTEM_CATALOG } from '@aalis/plugin-webui-api';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createAuthSystem, openBrowser } from './auth.js';
import { registerFileRoutes } from './routes/files.js';
import { registerPluginRoutes } from './routes/plugins.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui-server';
export const displayName = 'WebUI 服务端';
export const provides = ['webui-server', 'platform'];
export const inject = {
  optional: ['authority', 'commands', 'storage', 'platform'],
};

export const webuiPages: WebuiPage[] = [
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
  workspaceRoot: {
    type: 'string',
    label: '兼容文件根目录',
    default: 'workspace',
    description: '缺少 storage 服务时的兼容文件根目录',
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
    ],
    description:
      'ephemeral=旧行为；persist=token 写入 data/.webui-token，读取复用；fixed=使用 fixedToken 字段。所有模式下都会同时写出便利文件 data/webui-access.txt 包含访问 URL。',
  },
  fixedToken: {
    type: 'string',
    label: '固定 Token（仅 tokenMode=fixed 生效）',
    default: '',
    description: '请使用足够长的随机字符串。生产环境强烈建议通过环境变量或受限文件保存。',
  },
};

export const defaultConfig = {
  port: 3000,
  host: '127.0.0.1',
  fileRoot: 'workspace',
  workspaceRoot: 'workspace',
  autoOpen: true,
  tokenMode: 'persist',
  fixedToken: '',
};

// ===== 配置 =====

interface WebUIConfig {
  port: number;
  host: string;
  fileRoot: string;
  autoOpen: boolean;
  tokenMode: 'ephemeral' | 'persist' | 'fixed';
  fixedToken: string;
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
    | 'compressing';
  content?: string;
  sessionId?: string;
  reasoningContent?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
  toolLimitReached?: boolean;
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
  todoItems?: unknown[];
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

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const uiConfig: WebUIConfig = {
    port: (config.port as number) ?? 3000,
    host: (config.host as string) ?? '127.0.0.1',
    fileRoot: (config.fileRoot as string) || 'workspace',
    autoOpen: (config.autoOpen as boolean | undefined) ?? true,
    tokenMode:
      (config.tokenMode as string) === 'ephemeral' || (config.tokenMode as string) === 'fixed'
        ? (config.tokenMode as 'ephemeral' | 'fixed')
        : 'persist',
    fixedToken: (config.fixedToken as string) ?? '',
  };

  // ---- Token 解析 ----
  // - ephemeral：每次启动随机生成（旧行为）
  // - persist：首次生成后写入 data/.webui-token，重启复用（默认）
  // - fixed：使用 fixedToken 配置项；为空时降级为 persist
  // 所有模式都会写出 data/webui-access.txt 便于查找访问 URL（不写日志要求）
  const dataDir = resolve(process.cwd(), 'data');
  const tokenFile = join(dataDir, '.webui-token');
  const accessFile = join(dataDir, 'webui-access.txt');

  function ensureDataDir(): void {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  function resolveAuthToken(): string {
    if (uiConfig.tokenMode === 'fixed' && uiConfig.fixedToken.trim()) {
      return uiConfig.fixedToken.trim();
    }
    if (uiConfig.tokenMode === 'persist' || uiConfig.tokenMode === 'fixed') {
      ensureDataDir();
      try {
        if (existsSync(tokenFile)) {
          const existing = readFileSync(tokenFile, 'utf-8').trim();
          if (existing) return existing;
        }
      } catch {
        /* ignore */
      }
      const fresh = randomBytes(24).toString('hex');
      try {
        writeFileSync(tokenFile, fresh, { encoding: 'utf-8' });
        try {
          chmodSync(tokenFile, 0o600);
        } catch {
          /* ignore */
        }
      } catch (err) {
        ctx.logger.warn(`持久化 token 失败，本次仍可使用但重启会再生成: ${(err as Error).message}`);
      }
      return fresh;
    }
    // ephemeral
    return randomBytes(24).toString('hex');
  }

  function writeAccessFile(url: string, token: string): void {
    ensureDataDir();
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
      writeFileSync(accessFile, `${lines.join('\n')}\n`, { encoding: 'utf-8' });
      try {
        chmodSync(accessFile, 0o600);
      } catch {
        /* ignore */
      }
    } catch (err) {
      ctx.logger.warn(`写入访问文件失败: ${(err as Error).message}`);
    }
  }

  const authToken = resolveAuthToken();
  const auth = createAuthSystem(authToken, ctx.logger.child('auth'));

  const expressApp = express();
  expressApp.use(express.json({ limit: '10mb' }));
  expressApp.use(auth.middleware);
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
    { content: string; reasoningContent: string; segments: BufferSegment[]; generating: boolean }
  >();

  // Token 用量缓存：记录每个 session 最近一次的 token 用量，用于刷新/切换会话后立即展示
  const tokenUsageCache = new Map<string, WSOutgoing>();

  // 获取 App 实例（通过服务注册获取）
  const getApp = (): App | undefined => ctx.getService<App>('app');

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
  expressApp.get('/api/status', (_req, res) => {
    const persona = ctx.getService<PersonaService>('persona');
    // 判断上传能力
    const hasImageRecognition = ctx.hasService('image-recognition');
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
        /** 是否支持图片上传（image-recognition 可用 或 LLM 声明了 vision） */
        image: hasImageRecognition || llmHasVision,
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
          authority: c.authority,
          safety: c.safety,
        })),
    });
  });

  // ---------- 插件管理 + 全局配置 ----------
  registerPluginRoutes(expressApp, ctx, getApp);

  // 获取历史日志
  expressApp.get('/api/logs', (_req, res) => {
    res.json(getLogBuffer());
  });

  // 获取服务列表（含提供者信息）
  expressApp.get('/api/services', async (_req, res) => {
    const app = getApp();
    const pluginStatus = app ? app.plugins.getStatus() : [];
    const displayNameMap = new Map<string, string>();
    for (const p of pluginStatus) {
      if (p.displayName) {
        displayNameMap.set(p.name, p.displayName);
        displayNameMap.set(p.instanceId, p.displayName);
      }
    }

    const serviceNames = ctx.listServices();
    const services: Record<
      string,
      {
        providers: Array<{ contextId: string; capabilities: string[]; displayName?: string }>;
        active: string | undefined;
      }
    > = {};

    for (const svcName of serviceNames) {
      const entries = ctx.getServiceEntries(svcName);
      services[svcName] = {
        providers: entries.map(e => ({
          contextId: e.contextId,
          capabilities: [...e.capabilities],
          displayName: displayNameMap.get(e.contextId),
          label: e.label,
        })),
        active: entries.length > 0 ? entries[0].contextId : undefined,
      };
    }

    res.json({ services });
  });

  // 获取所有平台适配器及其连接状态
  expressApp.get('/api/platforms', (_req, res) => {
    const pm = ctx.getService<PlatformService>('platform');
    res.json({ platforms: pm?.getDetails() ?? [] });
  });

  // 获取已注册的工具分组（含元数据 + 各组工具数量）
  expressApp.get('/api/tool-groups', (_req, res) => {
    const groups = ctx.getService<ToolService>('tools')?.getGroups() ?? [];
    const allTools = ctx.getService<ToolService>('tools')?.getAll() ?? [];
    const result = groups.map(g => {
      const toolCount = allTools.filter(t => t.groups?.includes(g.name)).length;
      return { ...g, toolCount };
    });
    res.json({ groups: result });
  });

  // 获取服务分组（中央目录消费，见 ADR-0003）
  expressApp.get('/api/service-groups', (_req, res) => {
    const app = getApp();
    const pluginStatus = app ? app.plugins.getStatus() : [];
    // 反向索引：plugin name → subsystem id（来自 DEFAULT_SUBSYSTEM_CATALOG）
    const pluginToSubsystem = new Map<string, string>();
    for (const entry of DEFAULT_SUBSYSTEM_CATALOG) {
      for (const pluginName of entry.plugins) pluginToSubsystem.set(pluginName, entry.id);
    }
    // 按 subsystem 归组（未命中目录 → 'unknown'）
    const groupsMap = new Map<string, Array<{ name: string; provides: string[] }>>();
    for (const p of pluginStatus) {
      const sub = pluginToSubsystem.get(p.name) ?? 'unknown';
      if (!groupsMap.has(sub)) groupsMap.set(sub, []);
      groupsMap.get(sub)!.push({ name: p.name, provides: p.provides ?? [] });
    }
    // 排序：目录 order 优先，未命中条目 order=9999
    const catalog = new Map(DEFAULT_SUBSYSTEM_CATALOG.map(e => [e.id, e]));
    const sorted = [...groupsMap.keys()]
      .map(id => {
        const entry = catalog.get(id);
        return entry ? { id, label: entry.label, order: entry.order } : { id, label: '其他', order: 9999 };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const groups = sorted.map(({ id, label }) => ({
      id,
      label,
      plugins: groupsMap.get(id)!,
    }));
    res.json({ groups });
  });

  // 切换服务的偏好提供者（同时持久化到配置文件）
  expressApp.post('/api/services/:name/prefer', (req, res) => {
    const serviceName = req.params.name;
    const contextId = req.body?.contextId;
    if (!contextId || typeof contextId !== 'string') {
      res.status(400).json({ error: 'contextId 必须是字符串' });
      return;
    }
    const ok = ctx.preferService(serviceName, contextId);
    if (ok) {
      // 持久化到配置文件
      const app = getApp();
      if (app) {
        ctx.config.setServicePreference(serviceName, contextId);
        app.saveConfig();
      }

      // 切换 webui-client 时，需要通知 webui-server 更新静态目录
      if (serviceName === 'webui-client') {
        const newClient = ctx.getService<{ getClientDir(): string }>('webui-client');
        if (newClient?.getClientDir) {
          const dir = newClient.getClientDir();
          clientDist = dir;
          mountStaticDir(dir);
          ctx.logger.info(`前端已切换: ${dir}`);
        }
        // 通知所有前端刷新页面以加载新客户端（使用 reload 而非 restarting，客户端无需等待重连）
        const reloadPayload: WSOutgoing = { type: 'reload' };
        const reloadJson = JSON.stringify(reloadPayload);
        for (const ws of allClients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(reloadJson);
          }
        }
      }

      res.json({ ok: true, message: `${serviceName} 已切换到 ${contextId}` });
    } else {
      res.status(404).json({ error: `服务 ${serviceName} 或提供者 ${contextId} 不存在` });
    }
  });

  // 获取所有 LLM 模型（聚合所有 LLM 提供者）
  expressApp.get('/api/llm-models', async (_req, res) => {
    try {
      const models = await (ctx.getService<LLMService>('llm')?.listModels?.() ?? Promise.resolve([]));
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  });

  // 获取某个服务的可用模型/选项列表
  expressApp.get('/api/models/:service', async (req, res) => {
    const serviceName = req.params.service;

    // 特殊处理 platform：通过 core 的 getPlatformNames() 获取已注册的平台名称
    if (serviceName === 'platform') {
      const pm = ctx.getService<PlatformService>('platform');
      res.json({ models: pm?.getPlatformNames() ?? [] });
      return;
    }

    // 特殊处理 gateway-scopes：基于已注册 adapter.sessionTypes 真实声明生成
    // platform×sessionType 的笛卡尔积。无声明的 adapter 视为单会话（不展开 sessionType）。
    if (serviceName === 'gateway-scopes') {
      const adapters = ctx.getService<PlatformService>('platform')?.getAdapters() ?? [];
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

    const service = ctx.getService<{ listModels?(): Promise<unknown[]> }>(serviceName);
    if (!service || typeof service.listModels !== 'function') {
      res.json({ models: [] });
      return;
    }
    try {
      // 聚合所有提供者的模型列表
      // - LLM 路由要求精确锁定 (provider, model)，所以 value 编码为 "<contextId>::<modelId>"
      //   复合 ref（见 @aalis/core parseModelRef/formatModelRef）。同 model id 在多 provider
      //   中并存时不会被合并——前端 select 会同时列出供用户精确选择。
      // - 其他服务（embedding 等）listModels 返回 string[]，保持原样（plain id）。
      const allProviders = ctx.getAllServices<{ listModels?(): Promise<unknown[]> }>(serviceName);
      const aggregated: Array<{
        value: string;
        model: string;
        provider: string;
        contextId: string;
        capabilities: string[];
      }> = [];
      const flatValues: string[] = [];
      const isLLM = serviceName === 'llm';

      for (const provider of allProviders) {
        if (typeof provider.instance.listModels !== 'function') continue;
        try {
          const models = await provider.instance.listModels();
          for (const m of models) {
            // LLM listModels() returns ModelInfo[]，embedding 等返回 string[]
            const isModelInfo = typeof m === 'object' && m !== null && 'id' in m;
            const modelId = isModelInfo ? ((m as Record<string, unknown>).id as string) : String(m);
            const modelCaps = isModelInfo
              ? ((m as Record<string, unknown>).capabilities as string[])
              : provider.capabilities;
            const value = isLLM ? `${provider.contextId}::${modelId}` : modelId;
            aggregated.push({
              value,
              model: modelId,
              provider: provider.label ?? provider.contextId,
              contextId: provider.contextId,
              capabilities: modelCaps,
            });
            flatValues.push(value);
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

  // ---------- 斜杠命令处理 (通过指令注册表) ----------

  async function handleCommand(ctx: Context, input: string, sessionId: string): Promise<string | undefined> {
    const parsed = ctx.getService<CommandService>('commands')?.parseCommand(input);
    if (!parsed) return undefined;

    return ctx.getService<CommandService>('commands')!.execute(parsed.name, {
      sessionId,
      platform: 'webui',
      userId: 'console',
      args: parsed.args,
      raw: parsed.raw,
    });
  }

  // ---------- 高危操作交互式确认（内联对话式） ----------

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
    const prompt = `⚠️ ${typeLabel} ${nameStr} 是高危操作。回复 Y 仅允许本次；回复 YS 允许本会话 10 分钟；其他任意输入取消。`;

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

    return new Promise<PendingConfirmResult>(resolve => {
      const timer = setTimeout(() => {
        pendingSessionConfirms.delete(request.sessionId);
        // 超时后向会话发送提示
        const timeoutPayload: WSOutgoing = {
          type: 'confirm',
          content: '⏰ 高危操作确认已超时，已自动取消。',
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
  const storage = ctx.getService<StorageService>('storage') ?? undefined;
  const workspaceRootCfg = (config.workspaceRoot as string) || 'workspace';
  const workspaceRoot = resolve(process.cwd(), workspaceRootCfg);
  registerFileRoutes(expressApp, ctx, { storage, fileRoot: uiConfig.fileRoot, workspaceRoot });

  // ---------- WebSocket ----------

  wss.on('connection', ws => {
    ctx.logger.debug('WebUI 客户端已连接');
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
          if (buf && (buf.content || buf.reasoningContent || buf.segments.length > 0)) {
            const resume: WSOutgoing = {
              type: 'stream_resume',
              sessionId: sid,
              content: buf.content,
              reasoningContent: buf.reasoningContent,
              segments: buf.segments.length > 0 ? buf.segments : undefined,
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

        // 检查是否有待确认的高危操作（拦截用户输入作为确认/取消）
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

        // 指令处理
        const cmdResult = await handleCommand(ctx, trimmed, sessionId);
        if (cmdResult !== undefined) {
          const reply: WSOutgoing = {
            type: 'message',
            content: cmdResult,
            sessionId,
          };
          ws.send(JSON.stringify(reply));
          return;
        }

        await ctx.emit('inbound:message', {
          content: trimmed,
          sessionId,
          platform: 'webui',
          userId: 'console',
          nickname: undefined,
          ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
          ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
          ...(msg.attachmentOrder && msg.attachmentOrder.length > 0 ? { attachmentOrder: msg.attachmentOrder } : {}),
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
  const removeLogListener = onLogEntry((entry: LogEntry) => {
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

  // 会话切换通知：广播给所有客户端
  ctx.on('session:switched', (sessionId: string) => {
    const json = JSON.stringify({ type: 'session_switched', sessionId });
    for (const ws of allClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 监听 AI 回复
  ctx.on('outbound:message', (msg: OutgoingMessage) => {
    // 生成完成，延迟清理缓冲区（给客户端重连拉取历史留出时间窗口）
    const buf = streamBuffers.get(msg.sessionId);
    if (buf) {
      buf.generating = false;
      buf.content = msg.content ?? buf.content;
      buf.reasoningContent = msg.reasoningContent ?? buf.reasoningContent;
      setTimeout(() => streamBuffers.delete(msg.sessionId), 10_000);
    }
    const sockets = sessions.get(msg.sessionId);
    if (!sockets) return;

    // 优先使用 agent 显式提供的 segments；否则回退到累积缓冲（保留交错顺序）
    const segments = msg.segments ?? buf?.segments;
    const payload: WSOutgoing = {
      type: 'message',
      content: msg.content,
      sessionId: msg.sessionId,
      reasoningContent: msg.reasoningContent,
      segments: segments && segments.length > 0 ? segments : undefined,
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
        buf = { content: '', reasoningContent: '', segments: [], generating: true };
        streamBuffers.set(chunk.sessionId, buf);
      }
      if (chunk.contentDelta) {
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
        buf.reasoningContent += chunk.reasoningDelta;
        // 同样追加到统一时间线：合并连续 reasoning_text
        const last = buf.segments[buf.segments.length - 1];
        if (last && last.type === 'reasoning_text') {
          last.content += chunk.reasoningDelta;
        } else {
          buf.segments.push({ type: 'reasoning_text', content: chunk.reasoningDelta });
        }
      }
    }
    const sockets = sessions.get(chunk.sessionId);
    if (!sockets) return;

    const payload: WSOutgoing = {
      type: 'stream',
      sessionId: chunk.sessionId,
      contentDelta: chunk.contentDelta,
      reasoningDelta: chunk.reasoningDelta,
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
      buf = { content: '', reasoningContent: '', segments: [], generating: true };
      streamBuffers.set(info.sessionId, buf);
    }
    if (info.phase === 'start') {
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
    // 自动发现同级 webui-client 包并注册为 webui-client 服务提供者
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const clientCandidates: Array<{ id: string; label: string; dir: string }> = [
      {
        id: '@aalis/plugin-webui-client',
        label: 'Aalis 默认前端',
        dir: resolve(__dirname, '../../plugin-webui-client/dist'),
      },
      {
        id: '@aalis/plugin-webui-client-napcat',
        label: 'NapCat 前端',
        dir: resolve(__dirname, '../../plugin-webui-client-napcat/dist'),
      },
    ];

    // 如果已有外部插件注册了 webui-client 服务，则跳过自动发现
    const hasExternalClient = ctx.hasService('webui-client');
    if (!hasExternalClient) {
      let isFirst = true;
      for (const candidate of clientCandidates) {
        if (existsSync(candidate.dir) && existsSync(resolve(candidate.dir, 'index.html'))) {
          const childCtx = ctx.fork(candidate.id);
          childCtx.provide(
            'webui-client',
            {
              getClientDir: () => candidate.dir,
            },
            { label: candidate.label },
          );
          ctx.logger.info(`发现前端: ${candidate.label} (${candidate.dir})`);

          if (isFirst) {
            clientDist = candidate.dir;
            mountStaticDir(candidate.dir);
            ctx.logger.info(`活跃前端: ${candidate.label}`);
            isFirst = false;
          }
        }
      }
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

    // 应用配置中的 webui-client 偏好
    const clientPref = ctx.config.getServicePreferences()['webui-client'];
    if (clientPref) {
      ctx.preferService('webui-client', clientPref);
      const preferred = ctx.getService<{ getClientDir(): string }>('webui-client');
      if (preferred?.getClientDir) {
        const dir = preferred.getClientDir();
        clientDist = dir;
        mountStaticDir(dir);
        ctx.logger.info(`活跃前端(偏好): ${dir}`);
      }
    }

    server.listen(uiConfig.port, uiConfig.host, () => {
      const url = `http://${uiConfig.host}:${uiConfig.port}/`;
      const accessUrl = `${url}?token=${authToken}`;
      writeAccessFile(url, authToken);
      ctx.logger.info(`WebUI 已启动: ${url}`);
      const tokenHint =
        uiConfig.tokenMode === 'ephemeral'
          ? 'token 仅本次启动有效，重启轮换'
          : uiConfig.tokenMode === 'fixed'
            ? 'token 来自配置 fixedToken，固定不变'
            : 'token 已持久化到 data/.webui-token，重启沿用';
      ctx.logger.info(`首次访问请使用以下 URL（${tokenHint}）: ${accessUrl}`);
      ctx.logger.info(`访问凭据已写入: ${accessFile}`);
      if (uiConfig.autoOpen) openBrowser(accessUrl);
    });
  });

  ctx.on('dispose', () => {
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

  ctx.provide('platform', adapter, { capabilities: ['webui'] });

  // === 注册 WebUI 服务 ===
  const webuiService: WebUIService = {
    getPort: () => uiConfig.port,
    getHost: () => uiConfig.host,
    setClientDir(dir: string): void {
      clientDist = dir;
      mountStaticDir(dir);
      ctx.logger.info(`前端已切换: ${dir}`);
    },
  };
  ctx.provide('webui-server', webuiService, { capabilities: ['api-v1'] });
}
