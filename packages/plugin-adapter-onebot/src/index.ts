import WebSocket from 'ws';
import type { Context, ConfigSchema, PlatformAdapter, PlatformConnection } from '@aalis/core';
import type {
  OneBotConnectionConfig,
  OneBotProtocol,
  OneBotRawEvent,
  OneBotActionResponse,
  NormalizedNoticeEvent,
} from './types.js';
import { OneBotV11 } from './v11.js';
import { OneBotV12 } from './v12.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-adapter-onebot';
export const displayName = 'OneBot 适配器';
export const inject = {
  optional: ['llm', 'commands'],
};
export const provides = ['platform'];
export const reusable = true;

export const configSchema: ConfigSchema = {
  connections: {
    type: 'array',
    label: '连接列表',
    description: '配置一个或多个 OneBot WebSocket 连接',
    items: {
      url: { type: 'string', label: 'WebSocket 地址', required: true, description: '如 ws://127.0.0.1:8080' },
      accessToken: { type: 'string', label: '鉴权 Token', secret: true, description: '可选，与 OneBot 实现端一致' },
      selfId: { type: 'string', label: '机器人 ID', description: '可选，连接后自动获取' },
      protocol: {
        type: 'string',
        label: '协议版本',
        description: '选择 OneBot 协议版本：v11、v12 或 auto（自动检测）',
        default: 'auto',
      },
    },
    default: [],
  },
  splitMessage: {
    label: '消息分条发送',
    description: '启用后，文本将按标点符号自动拆分为多条消息发送，模拟真人发送习惯',
    fields: {
      enabled: { type: 'boolean', label: '启用', description: '是否启用消息分条发送', default: false },
      minDelay: { type: 'number', label: '最小延迟 (ms)', description: '分条消息之间的最小延迟（毫秒）', default: 500 },
      maxDelay: { type: 'number', label: '最大延迟 (ms)', description: '分条消息之间的最大延迟（毫秒）', default: 1500 },
    },
  },
};

export const defaultConfig = {
  connections: [] as OneBotConnectionConfig[],
  splitMessage: {
    enabled: false,
    minDelay: 500,
    maxDelay: 1500,
  },
};

// ===== 内部类型 =====

/** 单个 WebSocket 连接状态 */
interface ConnectionState {
  config: OneBotConnectionConfig;
  ws?: WebSocket;
  status: 'online' | 'offline' | 'connecting';
  selfId?: string;
  protocol?: OneBotProtocol;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  lastPong: number;
  pendingActions: Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

// ===== 工具函数 =====

/** 生成 sessionId: onebot:{selfId}:{detailType}:{targetId} */
function makeSessionId(selfId: string, detailType: string, userId?: string, groupId?: string, guildId?: string, channelId?: string): string {
  let targetId: string;
  if (detailType === 'private') {
    targetId = userId ?? 'unknown';
  } else if (detailType === 'group') {
    targetId = groupId ?? 'unknown';
  } else if (detailType === 'channel') {
    targetId = `${guildId ?? 'unknown'}:${channelId ?? 'unknown'}`;
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

// ===== 协议版本实例 =====
const protocolV11 = new OneBotV11();
const protocolV12 = new OneBotV12();

// ===== 重连配置 =====
const RECONNECT_INTERVAL = 5000;
const ACTION_TIMEOUT = 30000;
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;

// ===== 消息分条逻辑 =====

/**
 * 按标点符号（中英文逗号、句号、问号、叹号、分号、顿号、换行等）
 * 将文本拆分为多条消息。XML 标记（<at>、<image> 等）保持与相邻文本在一起。
 * 只拆分纯文本部分，不在 XML 标记中间切割。
 */
function splitMessageByPunctuation(content: string): string[] {
  // 如果内容很短或只有 XML 标记，不拆分
  if (content.length <= 10) return [content];

  // 识别所有 XML 标记的位置，拆分时不切割它们
  const xmlTagRegex = /<(?:at(?:\s+self)?)\s*>[^<]*<\/at>|<face\s+id=["'][^"']*["']\s*\/>|<image\s+url=["'][^"']*["']\s*\/>|<reply\s+id=["'][^"']*["']\s*\/>/g;

  // 将内容拆分为「标记区」和「纯文本区」交替的 token
  interface Token { type: 'text' | 'tag'; value: string }
  const tokens: Token[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = xmlTagRegex.exec(content)) !== null) {
    if (m.index > lastIdx) {
      tokens.push({ type: 'text', value: content.slice(lastIdx, m.index) });
    }
    tokens.push({ type: 'tag', value: m[0] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < content.length) {
    tokens.push({ type: 'text', value: content.slice(lastIdx) });
  }

  // 在文本 token 内部按标点拆分
  // 标点保留在前一段末尾（如 "你好。" 拆成 ["你好。"]）
  const splitRegex = /(?<=[。！？；\n，、,.!?;])/;
  const pieces: string[] = [];
  let current = '';

  for (const token of tokens) {
    if (token.type === 'tag') {
      current += token.value;
    } else {
      const parts = token.value.split(splitRegex);
      for (let i = 0; i < parts.length; i++) {
        current += parts[i];
        // 在标点后断开，但最后一段不断开（等后续 token 追加）
        if (i < parts.length - 1 && current.trim()) {
          pieces.push(current);
          current = '';
        }
      }
    }
  }
  if (current.trim()) {
    pieces.push(current);
  }

  // 过滤空段，合并过短的段落（< 4 字符的纯文本段）到上一条
  const result: string[] = [];
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    // 纯文本过短则合并到上一条
    const textOnly = trimmed.replace(/<[^>]+>/g, '').trim();
    if (textOnly.length < 4 && result.length > 0) {
      result[result.length - 1] += piece;
    } else {
      result.push(piece);
    }
  }

  return result.length > 0 ? result : [content];
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const connections: OneBotConnectionConfig[] = Array.isArray(config.connections)
    ? config.connections as OneBotConnectionConfig[]
    : [];

  // 消息分条配置
  const splitCfg = (config.splitMessage ?? {}) as { enabled?: boolean; minDelay?: number; maxDelay?: number };
  const splitEnabled = splitCfg.enabled === true;
  const splitMinDelay = Math.max(0, splitCfg.minDelay ?? 500);
  const splitMaxDelay = Math.max(splitMinDelay, splitCfg.maxDelay ?? 1500);

  if (connections.length === 0) {
    ctx.logger.info('OneBot 适配器未配置任何连接');
  }

  const states: ConnectionState[] = [];

  // ----- 群信息缓存 -----

  interface GroupInfo {
    name: string;
    memberCount?: number;
    fetchedAt: number;
  }
  const groupInfoCache = new Map<string, GroupInfo>();
  const GROUP_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

  /** 获取群信息（带缓存） */
  async function getGroupInfo(state: ConnectionState, groupId: string): Promise<GroupInfo | null> {
    const cached = groupInfoCache.get(groupId);
    if (cached && Date.now() - cached.fetchedAt < GROUP_CACHE_TTL) return cached;

    try {
      const data = await sendAction(state, 'get_group_info', {
        group_id: Number(groupId) || groupId,
      }) as Record<string, unknown>;
      const info: GroupInfo = {
        name: String(data.group_name ?? ''),
        memberCount: data.member_count != null ? Number(data.member_count) : undefined,
        fetchedAt: Date.now(),
      };
      if (info.name) groupInfoCache.set(groupId, info);
      return info;
    } catch {
      return null;
    }
  }

  /** 获取引用消息的内容 */
  async function fetchReplyMessage(state: ConnectionState, messageId: string): Promise<{
    content?: string; userId?: string; nickname?: string;
  } | null> {
    try {
      const data = await sendAction(state, 'get_msg', {
        message_id: Number(messageId) || messageId,
      }) as Record<string, unknown>;
      const message = Array.isArray(data.message) ? data.message : [];
      const sender = data.sender as Record<string, unknown> | undefined;
      // 提取纯文本内容
      let content = '';
      for (const seg of message) {
        const s = seg as Record<string, unknown>;
        if (s.type === 'text') content += String((s.data as Record<string, unknown>)?.text ?? '');
      }
      return {
        content: content || (data.raw_message as string) || undefined,
        userId: data.user_id != null ? String(data.user_id) : undefined,
        nickname: (sender?.card as string) || (sender?.nickname as string) || undefined,
      };
    } catch {
      return null;
    }
  }

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

  // ----- 版本自动检测 -----

  async function detectProtocol(state: ConnectionState): Promise<OneBotProtocol> {
    // 策略: 先尝试 v11 的 get_version_info，成功则为 v11
    // 失败则尝试 v12 的 get_version，成功则为 v12
    // 都失败则默认 v11（更常见）
    try {
      const data = await sendAction(state, 'get_version_info', {});
      const info = data as Record<string, unknown>;
      const protoVer = String(info?.protocol_version ?? '');
      ctx.logger.info(`OneBot 版本检测: get_version_info 成功 (protocol_version=${protoVer}, app=${info?.app_name ?? 'unknown'})`);
      // 有些实现可能报 v12 但走的 v11 接口，以接口可用性为准
      return protocolV11;
    } catch {
      // get_version_info 不可用，尝试 v12
    }

    try {
      const data = await sendAction(state, 'get_version', {});
      const info = data as Record<string, unknown>;
      ctx.logger.info(`OneBot 版本检测: get_version 成功 (impl=${info?.impl ?? 'unknown'}, onebot_version=${info?.onebot_version ?? '?'})`);
      return protocolV12;
    } catch {
      // 也不可用
    }

    ctx.logger.warn('OneBot 版本自动检测失败，默认使用 v11 协议');
    return protocolV11;
  }

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
        detail: {
          url: s.config.url,
          protocol: s.protocol?.version ?? 'unknown',
        },
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

      const state = states.find(s => s.selfId === parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws || !state.protocol) {
        ctx.logger.warn(`OneBot 连接不可用: selfId=${parsed.selfId}`);
        return;
      }

      // 消息分条发送
      const pieces = splitEnabled ? splitMessageByPunctuation(content) : [content];

      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i].trim();
        if (!piece) continue;

        const { action, params } = state.protocol.buildSendMessage({
          detailType: parsed.detailType,
          targetId: parsed.targetId,
          content: piece,
        });

        await sendAction(state, action, params);

        // 多条消息之间加随机延迟
        if (i < pieces.length - 1) {
          const delay = splitMinDelay + Math.random() * (splitMaxDelay - splitMinDelay);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    },

    async callAction(sessionId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
      const parsed = parseSessionId(sessionId);
      if (!parsed) throw new Error(`无法解析 sessionId: ${sessionId}`);

      const state = states.find(s => s.selfId === parsed.selfId);
      if (!state || state.status !== 'online' || !state.ws) {
        throw new Error(`OneBot 连接不可用: selfId=${parsed.selfId}`);
      }

      return sendAction(state, action, params);
    },
  };

  ctx.provide('platform', adapter, { capabilities: ['onebot'] });

  // ----- 连接管理 -----

  function connectOne(connConfig: OneBotConnectionConfig): ConnectionState {
    const state: ConnectionState = {
      config: connConfig,
      status: 'offline',
      selfId: connConfig.selfId,
      lastPong: 0,
      pendingActions: new Map(),
    };

    // 根据配置预设协议版本
    const proto = connConfig.protocol ?? 'auto';
    if (proto === 'v11') {
      state.protocol = protocolV11;
    } else if (proto === 'v12') {
      state.protocol = protocolV12;
    }
    // 'auto' 时 state.protocol 在连接后检测设置

    states.push(state);
    doConnect(state);
    return state;
  }

  function stopHeartbeat(state: ConnectionState): void {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = undefined;
    }
  }

  function doConnect(state: ConnectionState): void {
    if (ctx.disposed) return;

    state.status = 'connecting';
    ctx.logger.info(`正在连接 OneBot: ${state.config.url} (协议: ${state.protocol?.version ?? '待检测'})`);

    const headers: Record<string, string> = {};
    if (state.config.accessToken) {
      headers['Authorization'] = `Bearer ${state.config.accessToken}`;
    }

    const ws = new WebSocket(state.config.url, { headers });
    state.ws = ws;

    ws.on('open', () => {
      state.status = 'online';
      state.lastPong = Date.now();
      ctx.logger.info(`OneBot 已连接: ${state.config.url}`);

      // 客户端心跳：定期 ping，检测待机后的死连接
      stopHeartbeat(state);
      ws.on('pong', () => { state.lastPong = Date.now(); });
      state.heartbeatTimer = setInterval(() => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - state.lastPong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
          ctx.logger.warn(`OneBot 心跳超时，主动断开: ${state.config.url}`);
          state.ws.terminate();
          return;
        }
        state.ws.ping();
      }, HEARTBEAT_INTERVAL);

      onConnected(state);
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

        // 事件分发（需要协议已确定）
        if (!state.protocol) return;

        const event = data as OneBotRawEvent;
        const eventType = state.protocol.parseEventType(event);

        if (eventType === 'message') {
          handleMessageEvent(state, event);
        } else if (eventType === 'meta') {
          handleMetaEvent(state, event);
        } else if (eventType === 'notice') {
          handleNoticeEvent(state, event);
        }
      } catch (err) {
        ctx.logger.debug('OneBot 消息解析失败:', err);
      }
    });

    ws.on('close', () => {
      state.status = 'offline';
      state.ws = undefined;
      stopHeartbeat(state);
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

  async function onConnected(state: ConnectionState): Promise<void> {
    // 1. 如果协议未确定（auto），先检测
    if (!state.protocol) {
      try {
        state.protocol = await detectProtocol(state);
        ctx.logger.info(`OneBot 协议版本: ${state.protocol.version} (${state.config.url})`);
      } catch (err) {
        ctx.logger.warn(`OneBot 协议检测异常: ${err}，默认使用 v11`);
        state.protocol = protocolV11;
      }
    }

    // 2. 获取 self info
    if (!state.selfId) {
      try {
        const action = state.protocol.getSelfInfoAction();
        const data = await sendAction(state, action, {});
        const selfId = state.protocol.parseSelfInfo(data);
        if (selfId) {
          state.selfId = selfId;
          ctx.logger.info(`OneBot self_id: ${state.selfId} (via ${action})`);
        }
      } catch (err) {
        ctx.logger.debug(`获取 self info 失败: ${err}`);
      }
    }
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

  function handleMessageEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const event = state.protocol.parseMessageEvent(raw, fallbackSelfId);
    if (!event) return;

    // 更新 selfId
    if (event.selfId !== 'unknown' && !state.selfId) {
      state.selfId = event.selfId;
    }

    const sessionId = makeSessionId(
      event.selfId, event.detailType,
      event.userId, event.groupId, event.guildId, event.channelId,
    );

    ctx.logger.debug(`OneBot[${state.protocol.version}] 收到消息 [${event.detailType}] ${event.userId ?? '?'}: ${event.text}`);

    // 指令处理
    const parsed = ctx.commands?.parseCommand(event.text);
    if (parsed) {
      ctx.commands!.execute(parsed.name, {
        sessionId,
        platform: 'onebot',
        userId: event.userId,
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

    // 异步获取群信息和引用消息（不阻塞消息接收）
    (async () => {
      let groupName: string | undefined;
      let replyTo: { messageId: string; content?: string; userId?: string; nickname?: string } | undefined;

      // 获取群名
      if (event.detailType === 'group' && event.groupId) {
        const info = await getGroupInfo(state, event.groupId);
        if (info?.name) groupName = info.name;
      }

      // 获取引用消息内容
      if (event.replyToMessageId) {
        const reply = await fetchReplyMessage(state, event.replyToMessageId);
        replyTo = {
          messageId: event.replyToMessageId,
          content: reply?.content,
          userId: reply?.userId,
          nickname: reply?.nickname,
        };
      }

      ctx.emit('message:received', {
        content: event.text,
        sessionId,
        platform: 'onebot',
        userId: event.userId,
        nickname: event.nickname,
        images: event.images,
        sessionType: event.detailType === 'group' ? 'group'
          : event.detailType === 'private' ? 'private'
          : event.detailType === 'channel' ? 'channel'
          : undefined,
        groupName,
        groupId: event.groupId,
        replyTo,
      });
    })().catch(err => {
      ctx.logger.warn(`OneBot 消息处理异常: ${err}`);
    });
  }

  function handleNoticeEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const fallbackSelfId = state.selfId ?? 'unknown';
    const notice = state.protocol.parseNoticeEvent(raw, fallbackSelfId);
    if (!notice) return;

    ctx.logger.debug(`OneBot[${state.protocol.version}] 通知事件: ${notice.noticeType}${notice.subType ? `/${notice.subType}` : ''}`);

    // 戳一戳 → 转化为 message:received，让 agent 可以响应
    if (notice.noticeType === 'poke' && notice.groupId) {
      const selfId = notice.selfId;
      const sessionId = makeSessionId(selfId, 'group', notice.userId, notice.groupId);
      const targetDesc = notice.targetId === selfId ? '你' : notice.targetId;
      const content = `[戳一戳: ${notice.userId} 戳了 ${targetDesc}]`;

      ctx.emit('message:received', {
        content,
        sessionId,
        platform: 'onebot',
        userId: notice.userId,
        sessionType: 'group',
        groupId: notice.groupId,
        noticeType: 'poke',
      });
      return;
    }

    // 群文件上传 → 转化为 message:received
    if (notice.noticeType === 'group_upload' && notice.groupId) {
      const selfId = notice.selfId;
      const sessionId = makeSessionId(selfId, 'group', notice.userId, notice.groupId);
      const fileName = notice.data?.fileName ?? '未知文件';
      const content = `[文件上传: ${notice.userId} 上传了 ${fileName}]`;

      ctx.emit('message:received', {
        content,
        sessionId,
        platform: 'onebot',
        userId: notice.userId,
        sessionType: 'group',
        groupId: notice.groupId,
        noticeType: 'group_upload',
      });
      return;
    }
  }

  function handleMetaEvent(state: ConnectionState, raw: OneBotRawEvent): void {
    if (!state.protocol) return;

    const meta = state.protocol.parseMetaEvent(raw);

    if (meta.subType === 'connect' || meta.subType === 'lifecycle') {
      ctx.logger.debug(`OneBot[${state.protocol.version}] meta 事件: ${meta.subType}`);
      if (meta.selfId && !state.selfId) {
        state.selfId = meta.selfId;
        ctx.logger.info(`OneBot self_id (via meta): ${state.selfId}`);
      }
      if (meta.version) {
        ctx.logger.info(`OneBot 实现: ${meta.version.impl ?? 'unknown'} v${meta.version.version ?? '?'} (onebot ${meta.version.onebot_version ?? '?'})`);
      }
    } else if (meta.subType === 'heartbeat') {
      // 心跳事件不输出日志
    } else if (meta.subType === 'status_update') {
      ctx.logger.debug(`OneBot[${state.protocol.version}] 状态更新事件`);
    }
  }

  // ----- 监听消息回复事件 -----

  ctx.on('message:send', (msg) => {
    if (!msg.sessionId.startsWith('onebot:')) return;
    if (!msg.content?.trim()) {
      ctx.logger.debug(`OneBot 跳过空消息 [${msg.sessionId}]`);
      return;
    }
    ctx.logger.debug(`OneBot 发送消息 [${msg.sessionId}]: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
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
      stopHeartbeat(state);
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
