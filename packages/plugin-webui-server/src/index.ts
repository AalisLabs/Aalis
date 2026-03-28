import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Context, OutgoingMessage, StreamChunkMessage, ToolExecuteMessage, LogEntry, App, ConfigSchema, PlatformAdapter, PlatformConnection, WebUIService, AgentService, PlatformManagerService, WebuiPage, PersonaService } from '@aalis/core';
import type { AuthorityService } from '@aalis/plugin-authority';
import { getLogBuffer, onLogEntry, CORE_CONFIG_SCHEMA } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui-server';
export const displayName = 'WebUI 服务端';
export const provides = ['webui-server', 'platform'];
export const inject = {
  optional: ['authority', 'commands'],
};

export const webuiPages: WebuiPage[] = [
  { key: 'dashboard', label: '仪表盘', icon: 'dashboard', order: 10 },
  { key: 'marketplace', label: '插件市场', icon: 'marketplace', order: 20 },
  { key: 'plugin-config', label: '插件配置', icon: 'plugin-config', order: 30 },
  { key: 'platforms', label: '平台接入', icon: 'platforms', order: 40 },
  { key: 'logs', label: '日志', icon: 'logs', order: 60 },
];

export const configSchema: ConfigSchema = {
  port: { type: 'number', label: '端口', default: 3000, description: 'Web 管理界面的 HTTP 端口' },
  host: { type: 'string', label: '监听地址', default: '127.0.0.1', description: '绑定的 IP 地址，0.0.0.0 可对外访问' },
};

export const defaultConfig = {
  port: 3000,
  host: '127.0.0.1',
};

// ===== 配置 =====

interface WebUIConfig {
  port: number;
  host: string;
}

// ===== WebSocket 消息协议 =====

interface WSIncoming {
  type: 'message' | 'subscribe_logs' | 'abort';
  content?: string;
  sessionId?: string;
  /** base64 data URL 或 HTTP URL 列表 */
  images?: string[];
  /** 上传的文件列表 */
  files?: Array<{ name: string; data: string; mimeType?: string }>;
}

interface WSOutgoing {
  type: 'message' | 'stream' | 'status' | 'log' | 'tool_call' | 'state_changed' | 'restarting' | 'reload';
  content?: string;
  sessionId?: string;
  reasoningContent?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
  status?: Record<string, unknown>;
  log?: LogEntry;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolPhase?: 'start' | 'end';
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const uiConfig: WebUIConfig = {
    port: (config.port as number) ?? 3000,
    host: (config.host as string) ?? '127.0.0.1',
  };

  const expressApp = express();
  expressApp.use(express.json());
  const server = createServer(expressApp);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sessions = new Map<string, Set<WebSocket>>();
  const logSubscribers = new Set<WebSocket>();
  const allClients = new Set<WebSocket>();

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
      tools: ctx.tools?.getDefinitions().map(t => t.function.name) ?? [],
      commands: ctx.commands?.getAll().map(c => ({
        name: c.name,
        description: c.description,
        authority: c.authority,
        safety: c.safety,
        asTools: c.asTools,
      })),
    });
  });

  // 获取插件列表及状态
  expressApp.get('/api/plugins', (_req, res) => {
    const app = getApp();
    if (!app) {
      res.json({ plugins: [] });
      return;
    }
    const plugins = app.plugins.getStatus().map(p => ({
      name: p.name,
      instanceId: p.instanceId,
      displayName: p.displayName,
      state: p.state,
      provides: p.provides ?? [],
      core: p.core ?? false,
      reusable: p.reusable ?? false,
      config: p.config,
      configSchema: p.configSchema,
      defaultConfig: p.defaultConfig,
      error: p.error,
    }));
    res.json({ plugins });
  });

  // 获取可用的 WebUI 页面（由活跃插件的 webuiPages 声明汇总，包含声明式内容）
  expressApp.get('/api/pages', (_req, res) => {
    const app = getApp();
    if (!app) { res.json([]); return; }

    const pages: (WebuiPage & { plugin: string })[] = [];
    for (const plugin of app.plugins.getStatus()) {
      if (plugin.state === 'active' && plugin.webuiPages) {
        for (const page of plugin.webuiPages) {
          pages.push({ ...page, plugin: plugin.name });
        }
      }
    }
    pages.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    res.json(pages);
  });

  // 通用声明式页面操作：调用插件的 webuiHandlers
  expressApp.post('/api/page-action/:plugin/:method', async (req, res) => {
    const { plugin: pluginName, method } = req.params;
    const args: Record<string, unknown> = req.body ?? {};

    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }

    const entry = app.plugins.getPlugin(pluginName);
    if (!entry || entry.state !== 'active') {
      res.status(404).json({ error: `插件 ${pluginName} 不存在或未激活` });
      return;
    }

    const handler = entry.module.webuiHandlers?.[method];
    if (typeof handler !== 'function') {
      res.status(404).json({ error: `处理器 ${method} 不存在` });
      return;
    }

    if (!entry.context) {
      res.status(500).json({ error: `插件 ${pluginName} 上下文不可用` });
      return;
    }

    try {
      const result = await handler(entry.context, args);
      res.json({ ok: true, data: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 获取当前全局配置
  expressApp.get('/api/config', (_req, res) => {
    const allConfig = ctx.config.getAll();
    res.json({ ...allConfig, _schema: CORE_CONFIG_SCHEMA });
  });

  // 更新全局配置字段
  expressApp.put('/api/config', (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: '请求体必须是对象' });
      return;
    }

    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }

    // 只允许更新安全的顶级字段
    const allowed = ['name', 'logLevel'] as const;
    for (const key of allowed) {
      if (key in updates) {
        ctx.config.set(key, updates[key]);
      }
    }

    // 检查是否有需要重启才能生效的字段
    const restartNeeded = ['name', 'persona', 'logLevel'].some(k => k in updates);

    try {
      app.saveConfig();
      if (restartNeeded) {
        res.json({ ok: true, message: '全局配置已更新，正在重启应用以生效…', restart: true });
        app.restart();
      } else {
        res.json({ ok: true, message: '全局配置已更新并保存' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 获取单个插件的原始配置（未脱敏，给编辑器用）
  expressApp.get('/api/plugins/:name/config', (req, res) => {
    const pluginName = req.params.name;
    const pluginConfig = ctx.config.getPluginConfig(pluginName);
    res.json({ name: pluginName, config: pluginConfig });
  });

  // 更新插件配置
  expressApp.put('/api/plugins/:name/config', async (req, res) => {
    const pluginName = req.params.name;
    const newConfig = req.body?.config;
    if (!newConfig || typeof newConfig !== 'object') {
      res.status(400).json({ error: 'config 字段必须是对象' });
      return;
    }

    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }

    const success = await app.plugins.updatePluginConfig(pluginName, newConfig as Record<string, unknown>);
    if (success) {
      app.saveConfig();
      res.json({ ok: true, message: `插件 ${pluginName} 配置已更新` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
    }
  });

  // 启用插件
  expressApp.post('/api/plugins/:name/enable', async (req, res) => {
    const pluginName = req.params.name;
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const success = await app.plugins.enablePlugin(pluginName);
    if (success) {
      app.saveConfig();
      res.json({ ok: true, message: `插件 ${pluginName} 已启用` });
    } else {
      res.status(404).json({ error: `插件 ${pluginName} 不存在` });
    }
  });

  // 禁用插件
  expressApp.post('/api/plugins/:name/disable', async (req, res) => {
    const pluginName = req.params.name;
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const success = await app.plugins.disablePlugin(pluginName);
    if (success) {
      app.saveConfig();
      res.json({ ok: true, message: `插件 ${pluginName} 已禁用` });
    } else {
      res.status(400).json({ error: `核心插件不能被禁用` });
    }
  });

  // 重新扫描 packages/ 并加载新插件
  expressApp.post('/api/plugins/scan', async (_req, res) => {
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    try {
      const loaded = await app.rescanPlugins();
      res.json({ ok: true, loaded, message: loaded.length > 0 ? `新加载 ${loaded.length} 个插件` : '无新插件' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 安装插件（从 npm 下载到 packages/ 并加载）
  expressApp.post('/api/plugins/install', async (req, res) => {
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const npmPkg = req.body?.name;
    if (!npmPkg || typeof npmPkg !== 'string') {
      res.status(400).json({ error: 'name 字段必须是 npm 包名字符串' });
      return;
    }
    // 基础校验：只允许合法的 npm 包名
    if (!/^(@[a-z0-9\-_.]+\/)?[a-z0-9\-_.]+$/i.test(npmPkg)) {
      res.status(400).json({ error: '非法包名' });
      return;
    }
    try {
      const result = await app.installPlugin(npmPkg);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 卸载插件
  expressApp.post('/api/plugins/:name/uninstall', async (req, res) => {
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const pluginName = req.params.name;
    try {
      const result = await app.uninstallPlugin(pluginName);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // 创建插件多实例
  expressApp.post('/api/plugins/:name/instances', async (req, res) => {
    const moduleName = req.params.name;
    const suffix = req.body?.suffix;
    const config = req.body?.config ?? {};
    if (!suffix || typeof suffix !== 'string') {
      res.status(400).json({ error: 'suffix 必须是非空字符串' });
      return;
    }
    if (!/^[\w-]+$/.test(suffix)) {
      res.status(400).json({ error: 'suffix 只能包含字母、数字、下划线和连字符' });
      return;
    }
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const instanceId = await app.plugins.createInstance(moduleName, suffix, config as Record<string, unknown>);
    if (instanceId) {
      app.saveConfig();
      res.json({ ok: true, instanceId, message: `已创建实例 ${instanceId}` });
    } else {
      res.status(400).json({ error: `无法创建实例（模块不存在、未声明 reusable 或实例已存在）` });
    }
  });

  // 删除插件多实例
  expressApp.delete('/api/plugins/:instanceId/instance', async (req, res) => {
    const instanceId = req.params.instanceId;
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const ok = await app.plugins.removeInstance(instanceId);
    if (ok) {
      app.saveConfig();
      res.json({ ok: true, message: `已删除实例 ${instanceId}` });
    } else {
      res.status(400).json({ error: `无法删除（实例不存在或不允许删除主实例）` });
    }
  });

  // 保存配置到磁盘
  expressApp.post('/api/config/save', (_req, res) => {
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    try {
      app.saveConfig();
      res.json({ ok: true, message: '配置已保存到磁盘' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

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
    const services: Record<string, {
      providers: Array<{ contextId: string; capabilities: string[]; displayName?: string }>;
      active: string | undefined;
    }> = {};

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
    res.json({ platforms: ctx.getPlatformDetails() });
  });

  // 获取已注册的工具分组（含元数据 + 各组工具数量）
  expressApp.get('/api/tool-groups', (_req, res) => {
    const groups = ctx.tools?.getGroups() ?? [];
    const allTools = ctx.tools?.getAll() ?? [];
    const result = groups.map(g => {
      const toolCount = allTools.filter(t => t.groups?.includes(g.name)).length;
      return { ...g, toolCount };
    });
    res.json({ groups: result });
  });

  // 获取服务分组（自动分层 Dashboard 用）
  expressApp.get('/api/service-groups', (_req, res) => {
    const app = getApp();
    const pluginStatus = app ? app.plugins.getStatus() : [];
    // 构建 instanceId → provides 映射
    const providesMap = new Map<string, string[]>();
    for (const p of pluginStatus) {
      if (p.provides) providesMap.set(p.instanceId, p.provides);
    }

    const claimed = new Set<string>();
    const groups: Array<{ label: string; services: string[] }> = [];

    // 1. 核心服务（基础设施）
    const coreServices = ['commands', 'authority', 'tools'];
    groups.push({ label: '核心', services: coreServices });
    coreServices.forEach(s => claimed.add(s));

    // 2. Agent 子系统
    const agent = ctx.getService<AgentService>('agent');
    if (agent?.getPluginGroups) {
      const agentGroups = agent.getPluginGroups();
      const agentServices = new Set<string>();
      agentServices.add('agent'); // Agent 自身
      for (const g of agentGroups) {
        for (const pid of g.plugins) {
          const svcs = providesMap.get(pid);
          if (svcs) svcs.forEach(s => agentServices.add(s));
        }
      }
      const agentList = [...agentServices].filter(s => !claimed.has(s));
      if (agentList.length > 0) {
        groups.push({ label: 'Agent', services: agentList });
        agentList.forEach(s => claimed.add(s));
      }
    }

    // 3. 平台子系统
    const platformMgr = ctx.getService<PlatformManagerService>('platform-manager');
    if (platformMgr?.getPluginGroups) {
      const platGroups = platformMgr.getPluginGroups();
      const platServices = new Set<string>();
      platServices.add('platform-manager');
      // webui-client 属于平台子系统
      if (ctx.hasService('webui-client')) platServices.add('webui-client');
      for (const g of platGroups) {
        for (const pid of g.plugins) {
          const svcs = providesMap.get(pid);
          if (svcs) svcs.forEach(s => platServices.add(s));
        }
      }
      const platList = [...platServices].filter(s => !claimed.has(s));
      if (platList.length > 0) {
        groups.push({ label: '平台', services: platList });
        platList.forEach(s => claimed.add(s));
      }
    }

    // 4. 其他服务
    const allServiceNames = ctx.listServices();
    const other = allServiceNames.filter(s => !claimed.has(s) && s !== 'app');
    if (other.length > 0) {
      groups.push({ label: '其他', services: other });
    }

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
      const models = await ctx.listAllModels();
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
      res.json({ models: ctx.getPlatformNames() });
      return;
    }

    // 特殊处理 toolGroups：优先从工具分组注册表获取，回退到扫描工具
    if (serviceName === 'toolGroups') {
      const groups = ctx.tools?.getGroups() ?? [];
      if (groups.length > 0) {
        res.json({
          models: groups.map(g => g.name).sort(),
          details: groups.map(g => ({ value: g.name, label: g.label, description: g.description, pluginName: g.pluginName })),
        });
      } else {
        // 回退：从已注册工具中提取分组名称
        const tools = ctx.tools?.getAll() ?? [];
        const groupSet = new Set<string>();
        for (const t of tools) {
          t.groups?.forEach((g: string) => groupSet.add(g));
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
      const allProviders = ctx.getAllServices<{ listModels?(): Promise<unknown[]> }>(serviceName);
      const aggregated: Array<{ model: string; provider: string; capabilities: string[] }> = [];
      const flatModels: string[] = [];

      for (const provider of allProviders) {
        if (typeof provider.instance.listModels !== 'function') continue;
        try {
          const models = await provider.instance.listModels();
          for (const m of models) {
            // LLM listModels() returns ModelInfo[], embedding returns string[]
            const isModelInfo = typeof m === 'object' && m !== null && 'id' in m;
            const modelId = isModelInfo ? (m as Record<string, unknown>).id as string : String(m);
            const modelCaps = isModelInfo ? (m as Record<string, unknown>).capabilities as string[] : provider.capabilities;
            aggregated.push({ model: modelId, provider: provider.contextId, capabilities: modelCaps });
            flatModels.push(modelId);
          }
        } catch {
          // 单个提供者获取模型失败不影响整体
        }
      }

      res.json({ models: flatModels, providers: aggregated });
    } catch {
      res.json({ models: [] });
    }
  });

  // ---------- 斜杠命令处理 (通过指令注册表) ----------

  async function handleCommand(
    ctx: Context,
    input: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const parsed = ctx.commands?.parseCommand(input);
    if (!parsed) return undefined;

    return ctx.commands!.execute(parsed.name, {
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
  const pendingSessionConfirms = new Map<string, { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  ctx.getService<AuthorityService>('authority')?.setConfirmHandler('webui', async (request) => {
    const typeLabel = request.type === 'command' ? '指令' : '工具';
    const nameStr = request.type === 'command' ? `/${request.name}` : request.name;
    const prompt = `⚠️ ${typeLabel} ${nameStr} 是高危操作，确认执行请输入 Y，否则输入其他任意值。`;

    // 以普通聊天消息形式发送确认提示
    const payload: WSOutgoing = {
      type: 'message',
      content: prompt,
      sessionId: request.sessionId,
    };
    const json = JSON.stringify(payload);

    const sockets = sessions.get(request.sessionId);
    const targets = (sockets && sockets.size > 0) ? sockets : allClients;
    let sent = false;
    for (const ws of targets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
        sent = true;
      }
    }
    if (!sent) return false;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingSessionConfirms.delete(request.sessionId);
        // 超时后向会话发送提示
        const timeoutPayload: WSOutgoing = {
          type: 'message',
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

  // ---------- WebSocket ----------

  wss.on('connection', (ws) => {
    ctx.logger.debug('WebUI 客户端已连接');
    allClients.add(ws);

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSIncoming;

        if (msg.type === 'subscribe_logs') {
          logSubscribers.add(ws);
          return;
        }

        if (msg.type === 'abort') {
          const sessionId = msg.sessionId || 'webui-default';
          const agent = ctx.getService<AgentService>('agent');
          if (agent?.abort) agent.abort(sessionId);
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
          const confirmed = trimmed.toLowerCase() === 'y';
          pending.resolve(confirmed);
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

        await ctx.emit('message:received', {
          content: trimmed,
          sessionId,
          platform: 'webui',
          userId: 'console',
          ...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
          ...(msg.files && msg.files.length > 0 ? { files: msg.files } : {}),
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

  // 监听 AI 回复
  ctx.on('message:send', (msg: OutgoingMessage) => {
    const sockets = sessions.get(msg.sessionId);
    if (!sockets) return;

    const payload: WSOutgoing = {
      type: 'message',
      content: msg.content,
      sessionId: msg.sessionId,
      reasoningContent: msg.reasoningContent,
    };
    const json = JSON.stringify(payload);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  });

  // 监听流式增量推送
  ctx.on('message:stream', (chunk: StreamChunkMessage) => {
    const sockets = sessions.get(chunk.sessionId);
    if (!sockets) return;

    const payload: WSOutgoing = {
      type: 'stream',
      sessionId: chunk.sessionId,
      contentDelta: chunk.contentDelta,
      reasoningDelta: chunk.reasoningDelta,
      done: chunk.done,
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
      { id: '@aalis/plugin-webui-client', label: 'Aalis 默认前端', dir: resolve(__dirname, '../../plugin-webui-client/dist') },
      { id: '@aalis/plugin-webui-client-napcat', label: 'NapCat 前端', dir: resolve(__dirname, '../../plugin-webui-client-napcat/dist') },
    ];

    // 如果已有外部插件注册了 webui-client 服务，则跳过自动发现
    const hasExternalClient = ctx.hasService('webui-client');
    if (!hasExternalClient) {
      let isFirst = true;
      for (const candidate of clientCandidates) {
        if (existsSync(candidate.dir) && existsSync(resolve(candidate.dir, 'index.html'))) {
          const childCtx = ctx.fork(candidate.id);
          childCtx.provide('webui-client', {
            getClientDir: () => candidate.dir,
          }, { label: candidate.label });
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
      ctx.logger.info(`WebUI 已启动: http://${uiConfig.host}:${uiConfig.port}`);
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
    getConnections(): PlatformConnection[] {
      // 统计所有活跃 WebSocket 客户端
      const activeCount = [...allClients].filter(ws => ws.readyState === WebSocket.OPEN).length;
      if (activeCount === 0) return [];
      return [{
        id: 'webui',
        platform: 'webui',
        status: 'online',
        detail: { clients: activeCount },
      }];
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
