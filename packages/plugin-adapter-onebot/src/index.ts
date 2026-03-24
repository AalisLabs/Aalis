import WebSocket from 'ws';
import type { Context, ConfigSchema, PlatformAdapter, PlatformConnection } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-adapter-onebot';
export const inject = {
  optional: [{ service: 'llm', capabilities: ['chat'] }],
};
export const provides = ['platform'];

export const configSchema: ConfigSchema = {
  connections: {
    type: 'array',
    label: '连接列表',
    description: '配置一个或多个 OneBot WebSocket 连接',
    items: {
      url: { type: 'string', label: 'WebSocket 地址', required: true, description: '如 ws://127.0.0.1:8080' },
      accessToken: { type: 'string', label: '鉴权 Token', secret: true, description: '可选，与 OneBot 实现端一致' },
      selfId: { type: 'string', label: '机器人 ID', description: '可选，连接后自动获取' },
    },
    default: [],
  },
};

export const defaultConfig = {
  connections: [] as OneBotConnectionConfig[],
};

// ===== 类型定义 =====

interface OneBotConnectionConfig {
  /** WebSocket 地址 (如 ws://127.0.0.1:8080) */
  url: string;
  /** 鉴权 token (可选) */
  accessToken?: string;
  /** 机器人自身 ID (可选，连接后自动获取) */
  selfId?: string;
}

/** OneBot 12 标准事件 */
interface OneBotEvent {
  id: string;
  time: number;
  type: 'meta' | 'message' | 'notice' | 'request';
  detail_type: string;
  sub_type?: string;
  self?: { platform: string; user_id: string };
  [key: string]: unknown;
}

/** OneBot 12 消息事件 */
interface OneBotMessageEvent extends OneBotEvent {
  type: 'message';
  detail_type: 'private' | 'group' | 'channel';
  message_id: string;
  message: OneBotMessageSegment[];
  alt_message?: string;
  user_id?: string;
  group_id?: string;
  channel_id?: string;
  guild_id?: string;
}

/** OneBot 12 消息段 */
interface OneBotMessageSegment {
  type: string;
  data: Record<string, unknown>;
}

/** OneBot 12 Action 响应 */
interface OneBotActionResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
  echo?: string;
}

/** 单个 WebSocket 连接状态 */
interface ConnectionState {
  config: OneBotConnectionConfig;
  ws?: WebSocket;
  status: 'online' | 'offline' | 'connecting';
  selfId?: string;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  pendingActions: Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

// ===== 工具函数 =====

/** 从 OneBot 消息段数组中提取纯文本 */
function extractText(segments: OneBotMessageSegment[]): string {
  return segments
    .filter(seg => seg.type === 'text')
    .map(seg => String(seg.data.text ?? ''))
    .join('');
}

/** 生成 sessionId: onebot:{selfId}:{detailType}:{targetId} */
function makeSessionId(selfId: string, detailType: string, event: OneBotMessageEvent): string {
  let targetId: string;
  if (detailType === 'private') {
    targetId = String(event.user_id ?? 'unknown');
  } else if (detailType === 'group') {
    targetId = String(event.group_id ?? 'unknown');
  } else if (detailType === 'channel') {
    targetId = `${event.guild_id ?? 'unknown'}:${event.channel_id ?? 'unknown'}`;
  } else {
    targetId = 'unknown';
  }
  return `onebot:${selfId}:${detailType}:${targetId}`;
}

/** 解析 sessionId 回连接信息 */
function parseSessionId(sessionId: string): {
  selfId: string;
  detailType: string;
  targetId: string;
} | null {
  const parts = sessionId.split(':');
  if (parts[0] !== 'onebot' || parts.length < 4) return null;
  return {
    selfId: parts[1],
    detailType: parts[2],
    targetId: parts.slice(3).join(':'),
  };
}

/** 生成唯一 echo ID */
let echoCounter = 0;
function nextEcho(): string {
  return `aalis_${Date.now()}_${++echoCounter}`;
}

// ===== 重连配置 =====

const RECONNECT_INTERVAL = 5000; // 5 秒
const ACTION_TIMEOUT = 30000; // 30 秒

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const connections: OneBotConnectionConfig[] = Array.isArray(config.connections)
    ? config.connections as OneBotConnectionConfig[]
    : [];

  if (connections.length === 0) {
    ctx.logger.info('OneBot 适配器未配置任何连接');
  }

  const states: ConnectionState[] = [];

  // ----- PlatformAdapter 实现 -----

  const adapter: PlatformAdapter = {
    adapterName: 'OneBot',
    platform: 'onebot',

    getConnections(): PlatformConnection[] {
      return states.map(s => ({
        id: `onebot:${s.selfId ?? s.config.url}`,
        platform: 'onebot',
        selfId: s.selfId,
        status: s.status,
        detail: { url: s.config.url },
      }));
    },

    isReady(): boolean {
      return states.some(s => s.status === 'online');
    },

    async sendMessage(sessionId: string, content: string): Promise<void> {
      const parsed = parseSessionId(sessionId);
      if (!parsed) {
        ctx.logger.warn(`无法解析 sessionId: ${sessionId}`);
        return;
      }

      // 找到对应连接
      const state = states.find(s => s.selfId === parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws) {
        ctx.logger.warn(`OneBot 连接不可用: selfId=${parsed.selfId}`);
        return;
      }

      // 构造 OneBot 12 send_message action
      const params: Record<string, unknown> = {
        detail_type: parsed.detailType,
        message: [{ type: 'text', data: { text: content } }],
      };

      if (parsed.detailType === 'private') {
        params.user_id = parsed.targetId;
      } else if (parsed.detailType === 'group') {
        params.group_id = parsed.targetId;
      } else if (parsed.detailType === 'channel') {
        const [guildId, channelId] = parsed.targetId.split(':');
        params.guild_id = guildId;
        params.channel_id = channelId;
      }

      await sendAction(state, 'send_message', params);
    },
  };

  ctx.provide('platform', adapter, { capabilities: ['text'] });

  // ----- Action 发送 -----

  function sendAction(
    state: ConnectionState,
    action: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket 未连接'));
        return;
      }

      const echo = nextEcho();
      const timer = setTimeout(() => {
        state.pendingActions.delete(echo);
        reject(new Error(`Action ${action} 超时`));
      }, ACTION_TIMEOUT);

      state.pendingActions.set(echo, { resolve, reject, timer });

      const payload = JSON.stringify({ action, params, echo });
      state.ws.send(payload);
    });
  }

  // ----- 连接管理 -----

  function connectOne(connConfig: OneBotConnectionConfig): ConnectionState {
    const state: ConnectionState = {
      config: connConfig,
      status: 'offline',
      selfId: connConfig.selfId,
      pendingActions: new Map(),
    };
    states.push(state);
    doConnect(state);
    return state;
  }

  function doConnect(state: ConnectionState): void {
    if (ctx.disposed) return;

    state.status = 'connecting';
    ctx.logger.info(`正在连接 OneBot: ${state.config.url}`);

    const headers: Record<string, string> = {};
    if (state.config.accessToken) {
      headers['Authorization'] = `Bearer ${state.config.accessToken}`;
    }

    const ws = new WebSocket(state.config.url, { headers });
    state.ws = ws;

    ws.on('open', () => {
      state.status = 'online';
      ctx.logger.info(`OneBot 已连接: ${state.config.url}`);

      // 连接后尝试获取 self info
      if (!state.selfId) {
        sendAction(state, 'get_self_info', {})
          .then((data) => {
            const info = data as { user_id?: string };
            if (info?.user_id) {
              state.selfId = String(info.user_id);
              ctx.logger.info(`OneBot self_id: ${state.selfId}`);
            }
          })
          .catch(() => {
            ctx.logger.debug('获取 self_info 失败，使用配置的 selfId');
          });
      }
    });

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Action 响应 (有 echo 字段且不为空字符串)
        if ('echo' in data && typeof data.echo === 'string' && data.echo !== '') {
          const resp = data as OneBotActionResponse;
          const pending = state.pendingActions.get(resp.echo!);
          if (pending) {
            clearTimeout(pending.timer);
            state.pendingActions.delete(resp.echo!);
            if (resp.status === 'ok') {
              pending.resolve(resp.data);
            } else {
              pending.reject(new Error(`OneBot action 失败: ${resp.message ?? resp.retcode}`));
            }
          }
          return;
        }

        // 事件分发
        const event = data as OneBotEvent;
        if (event.type === 'message') {
          handleMessageEvent(state, event as OneBotMessageEvent);
        } else if (event.type === 'meta') {
          handleMetaEvent(state, event);
        }
      } catch (err) {
        ctx.logger.debug('OneBot 消息解析失败:', err);
      }
    });

    ws.on('close', () => {
      state.status = 'offline';
      state.ws = undefined;
      // 清理 pending actions
      for (const [, pending] of state.pendingActions) {
        clearTimeout(pending.timer);
        pending.reject(new Error('连接已关闭'));
      }
      state.pendingActions.clear();

      ctx.logger.warn(`OneBot 连接断开: ${state.config.url}，${RECONNECT_INTERVAL / 1000}s 后重连`);
      scheduleReconnect(state);
    });

    ws.on('error', (err) => {
      ctx.logger.warn(`OneBot 连接错误: ${err.message}`);
    });
  }

  function scheduleReconnect(state: ConnectionState): void {
    if (ctx.disposed) return;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      doConnect(state);
    }, RECONNECT_INTERVAL);
  }

  // ----- 事件处理 -----

  function handleMessageEvent(state: ConnectionState, event: OneBotMessageEvent): void {
    const selfId = state.selfId ?? event.self?.user_id ?? 'unknown';
    const detailType = event.detail_type;

    // 提取文本内容
    const text = event.alt_message ?? extractText(event.message);
    if (!text.trim()) return; // 忽略空消息

    const sessionId = makeSessionId(selfId, detailType, event);
    const userId = event.user_id ? String(event.user_id) : undefined;

    // 指令处理 —— 通过指令注册表
    const parsed = ctx.commands.parseCommand(text);
    if (parsed) {
      ctx.commands.execute(parsed.name, {
        sessionId,
        platform: 'onebot',
        userId,
        args: parsed.args,
        raw: parsed.raw,
      }).then((result) => {
        if (result) {
          adapter.sendMessage(sessionId, result).catch(err => {
            ctx.logger.warn(`OneBot 指令回复失败: ${err}`);
          });
        }
      }).catch(err => {
        ctx.logger.warn(`OneBot 指令执行失败: ${err}`);
      });
      return;
    }

    ctx.emit('message:received', {
      content: text,
      sessionId,
      platform: 'onebot',
      userId,
    });
  }

  function handleMetaEvent(state: ConnectionState, event: OneBotEvent): void {
    if (event.detail_type === 'connect') {
      ctx.logger.debug('OneBot meta.connect 事件');
      // 有些实现在 connect 事件中携带 self 信息
      if (event.self?.user_id && !state.selfId) {
        state.selfId = String(event.self.user_id);
        ctx.logger.info(`OneBot self_id (via meta): ${state.selfId}`);
      }
      // 解析实现端版本信息
      if (event.version && typeof event.version === 'object') {
        const ver = event.version as Record<string, unknown>;
        ctx.logger.info(`OneBot 实现: ${ver.impl ?? 'unknown'} v${ver.version ?? '?'} (onebot ${ver.onebot_version ?? '?'})`);
      }
    } else if (event.detail_type === 'heartbeat') {
      // 心跳事件 —— 规范要求实现端周期性发送，应用端无需回应，仅确认连接存活
      ctx.logger.debug(`OneBot 心跳 (interval: ${event.interval ?? '?'}ms)`);
    } else if (event.detail_type === 'status_update') {
      ctx.logger.debug('OneBot 状态更新事件');
    }
  }

  // ----- 监听消息回复事件 -----

  ctx.on('message:send', (msg) => {
    if (!msg.sessionId.startsWith('onebot:')) return;
    adapter.sendMessage(msg.sessionId, msg.content).catch(err => {
      ctx.logger.warn(`OneBot 发送消息失败: ${err}`);
    });
  });

  // ----- 生命周期 -----

  ctx.on('ready', () => {
    for (const connConfig of connections) {
      if (!connConfig.url) {
        ctx.logger.warn('OneBot 连接配置缺少 url，跳过');
        continue;
      }
      connectOne(connConfig);
    }
  });

  ctx.on('dispose', () => {
    for (const state of states) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.ws) {
        state.ws.removeAllListeners();
        state.ws.close();
      }
      for (const [, pending] of state.pendingActions) {
        clearTimeout(pending.timer);
      }
    }
    states.length = 0;
  });
}
