import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Context, OutgoingMessage, StreamChunkMessage, ToolExecuteMessage, LogEntry, App, ConfigSchema, PlatformAdapter, PlatformConnection } from '@aalis/core';
import { getLogBuffer, onLogEntry } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui';
export const provides = ['platform'];

export const configSchema: ConfigSchema = {
  port: { type: 'number', label: '端口', default: 3000 },
  host: { type: 'string', label: '监听地址', default: '127.0.0.1' },
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
  type: 'message' | 'stream' | 'status' | 'log' | 'tool_call';
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

/**
 * 脱敏处理：隐藏 apiKey 等敏感字段
 */
function sanitizeConfig(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeConfig);

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (/apiKey|password|secret|token/i.test(key) && typeof val === 'string' && val) {
      result[key] = val.slice(0, 4) + '****';
    } else if (typeof val === 'object' && val !== null) {
      result[key] = sanitizeConfig(val);
    } else {
      result[key] = val;
    }
  }
  return result;
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

  // 提供静态文件 (构建后的前端)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(__dirname, '../client/dist');
  if (existsSync(clientDist)) {
    expressApp.use(express.static(clientDist));
  }

  // ---------- REST API ----------

  // 获取系统状态
  expressApp.get('/api/status', (_req, res) => {
    res.json({
      name: ctx.config.get('name'),
      services: {
        llm: ctx.hasService('llm'),
        memory: ctx.hasService('memory'),
        persona: ctx.hasService('persona'),
      },
      tools: ctx.tools.getDefinitions().map(t => t.function.name),
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
      config: sanitizeConfig(p.config),
      configSchema: p.configSchema,
      defaultConfig: p.defaultConfig,
      error: p.error,
    }));
    res.json({ plugins });
  });

  // 获取当前全局配置（脱敏）
  expressApp.get('/api/config', (_req, res) => {
    const allConfig = ctx.config.getAll();
    res.json(sanitizeConfig(allConfig));
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
    const allowed = ['name', 'persona', 'logLevel'] as const;
    for (const key of allowed) {
      if (key in updates) {
        ctx.config.set(key, updates[key]);
      }
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

    const success = await app.plugins.updatePluginConfig(pluginName, newConfig);
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
    const entries = ctx.getServiceEntries('platform');
    const platforms: Array<{
      adapterName: string;
      platform: string;
      contextId: string;
      connections: PlatformConnection[];
    }> = [];

    for (const entry of entries) {
      const adapter = entry.instance as PlatformAdapter;
      if (adapter && typeof adapter.getConnections === 'function') {
        platforms.push({
          adapterName: adapter.adapterName,
          platform: adapter.platform,
          contextId: entry.contextId,
          connections: adapter.getConnections(),
        });
      }
    }

    res.json({ platforms });
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

  // ---------- 斜杠命令处理 (通过指令注册表) ----------

  async function handleSlashCommand(
    ctx: Context,
    command: string,
    sessionId: string,
  ): Promise<string | undefined> {
    if (!command.startsWith('/')) return undefined;

    const parts = command.slice(1).split(/\s+/);
    const cmdName = parts[0];
    const args = parts.slice(1);

    return ctx.commands.execute(cmdName, {
      sessionId,
      platform: 'webui',
      args,
      raw: command,
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

        // 斜杠命令处理
        if (trimmed.startsWith('/')) {
          const cmdResult = await handleSlashCommand(ctx, trimmed, sessionId);
          if (cmdResult !== undefined) {
            const reply: WSOutgoing = {
              type: 'message',
              content: cmdResult,
              sessionId,
            };
            ws.send(JSON.stringify(reply));
            return;
          }
        }

        await ctx.emit('message:received', {
          content: trimmed,
          sessionId,
          platform: 'webui',
        });
      } catch (err) {
        ctx.logger.warn('WebUI 消息处理失败:', err);
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      logSubscribers.delete(ws);
      for (const [, sockets] of sessions) {
        sockets.delete(ws);
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
  if (existsSync(clientDist)) {
    expressApp.get('{*path}', (_req, res) => {
      res.sendFile(resolve(clientDist, 'index.html'));
    });
  }

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

  ctx.provide('platform', adapter, { capabilities: ['text', 'web'] });
}
