import type { Message } from '@aalis/core';
import type { IncomingMessage, OutgoingMessage } from '@aalis/plugin-message-api';

/**
 * 虚拟频道 —— 把多个真实 sessionId（群聊/私聊/WebUI 等）聚合成一个逻辑订阅单元。
 *
 * 设计要点：
 * - channel 不是 SessionInfo，没有平台身份，不参与流控；只做"路由 + 聚合"。
 * - 入站：监听 inbound:message:archived，把 boundSessions 内的消息汇聚到 channel。
 * - 出站：broadcast() 对每个 boundSession 各自 emit outbound:message，由各自平台的流控负责发送。
 * - 历史：合并视图，运行时由各 boundSession 的 memory.getHistory 拼起来，不额外存储。
 */
export interface SessionChannel {
  /** channel 唯一标识 */
  id: string;
  /** 给人看的名字 */
  label: string;
  /** 绑定的真实 sessionId 列表 */
  boundSessions: string[];
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 调用方业务字段，channel 本身不解释 */
  metadata?: Record<string, unknown>;
}

/**
 * channel 入站汇聚事件 payload。
 * 把 inbound:message:archived 中属于本 channel 成员的消息 re-emit 出来，
 * 调用方（如 game-activity）订阅 channel:message 即可拿到聚合视图。
 */
export interface ChannelInboundEvent {
  channelId: string;
  /** 来源真实 sessionId */
  originSessionId: string;
  /** 经过预处理器归档后的最终消息 */
  archivedMessage: Message;
  /** 原始入站消息，包含 platform / userId / nickname / triggerType 等会话上下文 */
  incoming: IncomingMessage;
}

/** broadcast 时调用方可以指定的额外字段 */
export interface BroadcastOptions {
  /** 默认 'system'：整条立即发，不走 agent 分条延迟 */
  source?: OutgoingMessage['source'];
  /** 排除某些 sessionId（比如不发回触发源） */
  exclude?: string[];
}

/** 服务接口：所有 channel 操作的统一入口 */
export interface SessionChannelService {
  /** 创建 channel；返回 channelId */
  create(opts: { label: string; sessions?: string[]; metadata?: Record<string, unknown> }): Promise<string>;
  /** 解散 channel（删除元数据，不影响成员 session 自身） */
  dissolve(channelId: string): Promise<void>;

  /** 加入 channel；同一 sessionId 重复加入是幂等的 */
  join(channelId: string, sessionId: string): Promise<void>;
  /** 离开 channel */
  leave(channelId: string, sessionId: string): Promise<void>;

  /** 向 channel 所有成员广播；各自走平台流控 */
  broadcast(channelId: string, content: string, opts?: BroadcastOptions): Promise<void>;

  /** 获取 channel 元数据 */
  get(channelId: string): SessionChannel | undefined;
  /** 列出所有 channel */
  list(): SessionChannel[];
  /** 反向查询：某 sessionId 加入了哪些 channel */
  forSession(sessionId: string): SessionChannel[];

  /**
   * 合并视图：把成员 session 的历史按时间戳排序合并返回。
   * 每条 Message.metadata 会带上 _originSession 标记来源。
   * 不修改原始历史，纯只读视图。
   */
  getAggregatedHistory(channelId: string, limit?: number): Promise<Message[]>;
}

declare module '@aalis/core' {
  interface AalisEvents {
    /** 入站消息汇聚到 channel；订阅此事件即可拿到聚合视图 */
    'channel:message': [event: ChannelInboundEvent];
    /** channel 生命周期 */
    'channel:created': [channel: SessionChannel];
    'channel:updated': [channel: SessionChannel];
    'channel:dissolved': [channelId: string];
  }
}
