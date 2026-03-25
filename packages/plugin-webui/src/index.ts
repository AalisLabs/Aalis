import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Context, OutgoingMessage, StreamChunkMessage, ToolExecuteMessage, LogEntry, App, ConfigSchema, PlatformAdapter, PlatformConnection, UserIdentity, WebUIService, PersonaService } from '@aalis/core';
import { getLogBuffer, onLogEntry, CORE_CONFIG_SCHEMA } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui';
export const provides = ['webui', 'platform'];

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
  type: 'message' | 'subscribe_logs';
  content?: string;
  sessionId?: string;
}

interface WSOutgoing {
  type: 'message' | 'stream' | 'status' | 'log' | 'tool_call' | 'state_changed' | 'restarting';
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
    res.json({
      name: persona?.getPersonaName() ?? ctx.config.get('name'),
      services: {
        webui: ctx.hasService('webui'),
        cli: ctx.hasService('cli'),
        llm: ctx.hasService('llm'),
        agent: ctx.hasService('agent'),
        memory: ctx.hasService('memory'),
        persona: ctx.hasService('persona'),
      },
      tools: ctx.tools.getDefinitions().map(t => t.function.name),
      commands: ctx.commands.getAll().map(c => ({
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
      state: p.state,
      provides: p.provides ?? [],
      core: p.core ?? false,
      config: p.config,
      configSchema: p.configSchema,
      defaultConfig: p.defaultConfig,
      error: p.error,
    }));
    res.json({ plugins });
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
    const allowed = ['name', 'logLevel', 'commandPrefix', 'commandAsTools'] as const;
    for (const key of allowed) {
      if (key in updates) {
        ctx.config.set(key, updates[key]);
      }
    }

    // commandPrefix / commandAsTools 需要同步到运行时
    if ('commandPrefix' in updates && typeof updates.commandPrefix === 'string') {
      ctx.commands.prefix = updates.commandPrefix;
    }
    if ('commandAsTools' in updates && typeof updates.commandAsTools === 'boolean') {
      ctx.commands.globalAsTools = updates.commandAsTools;
    }

    try {
      app.saveConfig();
      res.json({ ok: true, message: '全局配置已更新并保存' });
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
    const serviceNames = ctx.listServices();
    const services: Record<string, {
      providers: Array<{ contextId: string; capabilities: string[] }>;
      active: string | undefined;
    }> = {};

    for (const svcName of serviceNames) {
      const entries = ctx.getServiceEntries(svcName);
      services[svcName] = {
        providers: entries.map(e => ({
          contextId: e.contextId,
          capabilities: [...e.capabilities],
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
      res.json({ ok: true, message: `${serviceName} 已切换到 ${contextId}` });
    } else {
      res.status(404).json({ error: `服务 ${serviceName} 或提供者 ${contextId} 不存在` });
    }
  });

  // 获取某个服务的可用模型列表 (调用 service.listModels())
  expressApp.get('/api/models/:service', async (req, res) => {
    const serviceName = req.params.service;

    // 特殊处理 platform：通过 core 的 getPlatformNames() 获取已注册的平台名称
    if (serviceName === 'platform') {
      res.json({ models: ctx.getPlatformNames() });
      return;
    }

    const service = ctx.getService<{ listModels?(): Promise<string[]> }>(serviceName);
    if (!service || typeof service.listModels !== 'function') {
      res.json({ models: [] });
      return;
    }
    try {
      const models = await service.listModels();
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  });

  // ---------- 权限管理 API ----------

  // 获取权限概览（所有用户 + 配置）
  expressApp.get('/api/authority', (_req, res) => {
    const users = ctx.authority.listUsers();
    const owners: UserIdentity[] = ctx.config.get('owners') ?? [];
    const commands = ctx.commands.getAll();
    const overrides = ctx.commands.getOverrides();
    res.json({
      users,
      owners,
      defaultAuthority: ctx.config.get('defaultAuthority') ?? 1,
      ownerAuthority: ctx.config.get('ownerAuthority') ?? 5,
      dangerousPolicy: ctx.config.get('dangerousPolicy') ?? {},
      commandPrefix: ctx.config.get('commandPrefix') ?? '/',
      commands: commands.map(c => {
        const o = overrides[c.name];
        return {
          name: c.name,
          description: c.description,
          authority: o?.authority ?? c.authority ?? 1,
          safety: o?.safety ?? c.safety ?? 'safe',
          baseAuthority: c.authority ?? 1,
          baseSafety: c.safety ?? 'safe',
          overridden: !!o,
          pluginName: c.pluginName,
        };
      }),
      commandOverrides: overrides,
    });
  });

  // 设置用户权限等级
  expressApp.put('/api/authority/user', (req, res) => {
    const { platform, userId, authority } = req.body ?? {};
    if (!platform || !userId || typeof authority !== 'number') {
      res.status(400).json({ error: 'platform, userId, authority(number) 必填' });
      return;
    }
    if (authority < 0) {
      res.status(400).json({ error: '权限等级必须 >= 0' });
      return;
    }
    ctx.authority.setAuthority(platform, userId, authority);
    ctx.authority.save();
    res.json({ ok: true, message: `${platform}:${userId} 权限已设为 ${authority}` });
  });

  // 删除用户权限记录（回退到默认等级）
  expressApp.delete('/api/authority/user', (req, res) => {
    const { platform, userId } = req.body ?? {};
    if (!platform || !userId) {
      res.status(400).json({ error: 'platform, userId 必填' });
      return;
    }
    ctx.authority.setAuthority(platform, userId, ctx.config.get('defaultAuthority') ?? 1);
    ctx.authority.save();
    res.json({ ok: true, message: `${platform}:${userId} 权限已重置` });
  });

  // 更新 owner 列表
  expressApp.put('/api/authority/owners', (req, res) => {
    const owners = req.body?.owners;
    if (!Array.isArray(owners)) {
      res.status(400).json({ error: 'owners 必须是数组' });
      return;
    }
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    ctx.config.set('owners', owners);
    app.saveConfig();
    res.json({ ok: true, message: 'Owner 列表已更新' });
  });

  // 更新 dangerousPolicy
  expressApp.put('/api/authority/dangerous', (req, res) => {
    const policy = req.body?.policy;
    if (!policy || typeof policy !== 'object') {
      res.status(400).json({ error: 'policy 必须是对象' });
      return;
    }
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    ctx.config.set('dangerousPolicy', policy);
    app.saveConfig();
    res.json({ ok: true, message: '高危策略已更新' });
  });

  // 更新全局权限配置（defaultAuthority, ownerAuthority）
  expressApp.put('/api/authority/config', (req, res) => {
    const { defaultAuthority, ownerAuthority } = req.body ?? {};
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    if (typeof defaultAuthority === 'number') {
      ctx.config.set('defaultAuthority', defaultAuthority);
    }
    if (typeof ownerAuthority === 'number') {
      ctx.config.set('ownerAuthority', ownerAuthority);
    }
    app.saveConfig();
    res.json({ ok: true, message: '权限配置已更新' });
  });



  // 更新单条指令的权限覆盖
  expressApp.put('/api/authority/command', (req, res) => {
    const { name, authority, safety } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name 必填' });
      return;
    }
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    const override: { authority?: number; safety?: string } = {};
    if (typeof authority === 'number') override.authority = authority;
    if (typeof safety === 'string' && (safety === 'safe' || safety === 'dangerous')) override.safety = safety;

    if (Object.keys(override).length === 0) {
      // 移除覆盖
      ctx.commands.removeOverride(name);
    } else {
      ctx.commands.setOverride(name, override);
    }
    // 持久化到配置
    ctx.config.set('commandOverrides', ctx.commands.getOverrides());
    app.saveConfig();
    res.json({ ok: true, message: `指令 ${name} 权限已更新` });
  });

  // 重置指令覆盖（恢复插件默认）
  expressApp.delete('/api/authority/command', (req, res) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name 必填' });
      return;
    }
    const app = getApp();
    if (!app) {
      res.status(500).json({ error: 'App 不可用' });
      return;
    }
    ctx.commands.removeOverride(name);
    ctx.config.set('commandOverrides', ctx.commands.getOverrides());
    app.saveConfig();
    res.json({ ok: true, message: `指令 ${name} 覆盖已重置` });
  });

  // ---------- 斜杠命令处理 (通过指令注册表) ----------

  async function handleCommand(
    ctx: Context,
    input: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const parsed = ctx.commands.parseCommand(input);
    if (!parsed) return undefined;

    return ctx.commands.execute(parsed.name, {
      sessionId,
      platform: 'webui',
      userId: 'console',
      args: parsed.args,
      raw: parsed.raw,
    });
  }

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

        if (msg.type !== 'message' || !msg.content) return;

        const sessionId = msg.sessionId || 'webui-default';
        const trimmed = msg.content.trim();

        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, new Set());
        }
        sessions.get(sessionId)!.add(ws);

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
      res.status(404).json({ error: '前端未就绪，请安装 webui-client 插件' });
    }
  });

  // 启动服务器
  ctx.on('ready', () => {
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

  ctx.provide('platform', adapter, { capabilities: ['webui', 'text', 'web'] });

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
  ctx.provide('webui', webuiService, { capabilities: ['api', 'websocket', 'management'] });
}
