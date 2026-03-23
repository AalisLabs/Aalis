import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Context, OutgoingMessage, LogEntry, App, LLMService } from '@aalis/core';
import { getLogBuffer, onLogEntry } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-webui';
export const provides = ['platform'];

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
  type: 'message' | 'status' | 'log';
  content?: string;
  sessionId?: string;
  reasoningContent?: string;
  status?: Record<string, unknown>;
  log?: LogEntry;
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
    const allowed = ['name', 'persona', 'logLevel', 'agent'] as const;
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
      res.json({ ok: true, message: `插件 ${pluginName} 已禁用` });
    } else {
      res.status(400).json({ error: `核心插件不能被禁用` });
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
  expressApp.get('/api/services', (_req, res) => {
    const serviceNames = ctx.listServices();
    const services: Record<string, { providers: Array<{ contextId: string; capabilities: string[]; model?: string }>; active: string | undefined }> = {};

    for (const name of serviceNames) {
      const entries = ctx.getServiceEntries(name);
      services[name] = {
        providers: entries.map(e => {
          const info: { contextId: string; capabilities: string[]; model?: string } = {
            contextId: e.contextId,
            capabilities: [...e.capabilities],
          };
          // 对 LLM 服务附加当前模型信息
          if (name === 'llm') {
            const llm = e.instance as LLMService;
            if (llm.getModel) info.model = llm.getModel();
          }
          return info;
        }),
        active: entries.length > 0 ? entries[0].contextId : undefined,
      };
    }
    res.json({ services });
  });

  // ---------- LLM 模型管理 API ----------

  // 获取可用模型列表
  expressApp.get('/api/llm/models', async (_req, res) => {
    const llm = ctx.getService<LLMService>('llm');
    if (!llm || !llm.listModels) {
      res.json({ models: [] });
      return;
    }
    try {
      const models = await llm.listModels();
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  });

  // 获取当前模型
  expressApp.get('/api/llm/model', (_req, res) => {
    const llm = ctx.getService<LLMService>('llm');
    if (!llm || !llm.getModel) {
      res.json({ model: null });
      return;
    }
    res.json({ model: llm.getModel() });
  });

  // 切换模型
  expressApp.put('/api/llm/model', (req, res) => {
    const model = req.body?.model;
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'model 必须是字符串' });
      return;
    }
    const llm = ctx.getService<LLMService>('llm');
    if (!llm || !llm.setModel) {
      res.status(500).json({ error: 'LLM 服务不支持模型切换' });
      return;
    }
    llm.setModel(model);

    // 持久化到配置
    const entries = ctx.getServiceEntries('llm');
    if (entries.length > 0) {
      const activeContextId = entries[0].contextId;
      const pluginConfig = ctx.config.getPluginConfig(activeContextId);
      pluginConfig.model = model;
      ctx.config.setPluginConfig(activeContextId, pluginConfig);
      const app = getApp();
      if (app) app.saveConfig();
    }

    res.json({ ok: true, model });
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

  // ---------- WebSocket ----------

  wss.on('connection', (ws) => {
    ctx.logger.debug('WebUI 客户端已连接');

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSIncoming;

        if (msg.type === 'subscribe_logs') {
          logSubscribers.add(ws);
          return;
        }

        if (msg.type !== 'message' || !msg.content) return;

        const sessionId = msg.sessionId || 'webui-default';

        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, new Set());
        }
        sessions.get(sessionId)!.add(ws);

        await ctx.emit('message:received', {
          content: msg.content,
          sessionId,
          platform: 'webui',
        });
      } catch (err) {
        ctx.logger.warn('WebUI 消息处理失败:', err);
      }
    });

    ws.on('close', () => {
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

  ctx.provide('platform', { name: 'webui' }, { capabilities: ['text', 'web'] });
}
