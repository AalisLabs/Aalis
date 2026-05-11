import { randomUUID } from 'node:crypto';
import type { Context, Message, IncomingMessage } from '@aalis/core';
import type { GatewayService } from '@aalis/plugin-gateway-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type {
  BroadcastOptions,
  ChannelInboundEvent,
  SessionChannel,
  SessionChannelService,
} from './types.js';

const METADATA_NAMESPACE = 'channels';

/**
 * SessionChannelManager —— 内存 + memory.metadata 双层存储。
 *
 * 内存里保留全部 channel 用于热路径（入站汇聚要在 inbound:message:archived 里 O(1) 命中 boundSession 反查）；
 * memory.saveMetadata 仅作持久化，重启后 load() 一次性恢复。
 */
export class SessionChannelManager implements SessionChannelService {
  private readonly channels = new Map<string, SessionChannel>();
  /** sessionId → channelIds 的反向索引，避免每次入站 O(n) 扫全表 */
  private readonly bySession = new Map<string, Set<string>>();
  /** memory 是否支持 saveMetadata */
  private persistAvailable = false;

  constructor(
    private readonly ctx: Context,
    private readonly memory: MemoryService,
  ) {
    this.persistAvailable = typeof this.memory.saveMetadata === 'function'
      && typeof this.memory.listMetadata === 'function'
      && typeof this.memory.deleteMetadata === 'function';
  }

  // ── 加载/持久化 ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    if (!this.persistAvailable || !this.memory.listMetadata) {
      this.ctx.logger.debug('memory 不支持 metadata，channel 仅存在于内存中');
      return;
    }
    try {
      const entries = await this.memory.listMetadata(METADATA_NAMESPACE);
      for (const { key, data } of entries) {
        const ch = this.parseChannel(key, data);
        if (ch) this.indexInsert(ch);
      }
      this.ctx.logger.info(`已加载 ${this.channels.size} 个 channel`);
    } catch (err) {
      this.ctx.logger.warn('加载 channel 失败:', err);
    }
  }

  private parseChannel(key: string, data: Record<string, unknown>): SessionChannel | undefined {
    if (typeof data.id !== 'string' || typeof data.label !== 'string') return undefined;
    const bound = Array.isArray(data.boundSessions)
      ? data.boundSessions.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      id: key,
      label: data.label,
      boundSessions: bound,
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      metadata: typeof data.metadata === 'object' && data.metadata
        ? data.metadata as Record<string, unknown>
        : undefined,
    };
  }

  private async persist(ch: SessionChannel): Promise<void> {
    if (!this.persistAvailable || !this.memory.saveMetadata) return;
    try {
      await this.memory.saveMetadata(METADATA_NAMESPACE, ch.id, {
        id: ch.id,
        label: ch.label,
        boundSessions: ch.boundSessions,
        createdAt: ch.createdAt,
        updatedAt: ch.updatedAt,
        ...(ch.metadata ? { metadata: ch.metadata } : {}),
      });
    } catch (err) {
      this.ctx.logger.warn(`持久化 channel ${ch.id} 失败:`, err);
    }
  }

  // ── 索引维护 ─────────────────────────────────────────────────────────────

  private indexInsert(ch: SessionChannel): void {
    this.channels.set(ch.id, ch);
    for (const sid of ch.boundSessions) this.linkIdx(sid, ch.id);
  }

  private linkIdx(sessionId: string, channelId: string): void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(channelId);
  }

  private unlinkIdx(sessionId: string, channelId: string): void {
    const set = this.bySession.get(sessionId);
    if (!set) return;
    set.delete(channelId);
    if (set.size === 0) this.bySession.delete(sessionId);
  }

  // ── 服务 API ─────────────────────────────────────────────────────────────

  async create(opts: { label: string; sessions?: string[]; metadata?: Record<string, unknown> }): Promise<string> {
    const id = randomUUID();
    const now = Date.now();
    const sessions = Array.from(new Set(opts.sessions ?? []));
    const ch: SessionChannel = {
      id,
      label: opts.label,
      boundSessions: sessions,
      createdAt: now,
      updatedAt: now,
      metadata: opts.metadata,
    };
    this.indexInsert(ch);
    await this.persist(ch);
    await this.ctx.emit('channel:created', ch);
    this.ctx.logger.info(`channel 创建: ${ch.label} (${id}) 绑定 ${sessions.length} 个会话`);
    return id;
  }

  async dissolve(channelId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    for (const sid of ch.boundSessions) this.unlinkIdx(sid, channelId);
    this.channels.delete(channelId);
    if (this.persistAvailable && this.memory.deleteMetadata) {
      try {
        await this.memory.deleteMetadata(METADATA_NAMESPACE, channelId);
      } catch (err) {
        this.ctx.logger.warn(`删除 channel ${channelId} 元数据失败:`, err);
      }
    }
    await this.ctx.emit('channel:dissolved', channelId);
    this.ctx.logger.info(`channel 解散: ${ch.label} (${channelId})`);
  }

  async join(channelId: string, sessionId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error(`channel 不存在: ${channelId}`);
    if (ch.boundSessions.includes(sessionId)) return;
    ch.boundSessions.push(sessionId);
    ch.updatedAt = Date.now();
    this.linkIdx(sessionId, channelId);
    await this.persist(ch);
    await this.ctx.emit('channel:updated', ch);
  }

  async leave(channelId: string, sessionId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    const idx = ch.boundSessions.indexOf(sessionId);
    if (idx < 0) return;
    ch.boundSessions.splice(idx, 1);
    ch.updatedAt = Date.now();
    this.unlinkIdx(sessionId, channelId);
    await this.persist(ch);
    await this.ctx.emit('channel:updated', ch);
  }

  async broadcast(channelId: string, content: string, opts?: BroadcastOptions): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) {
      this.ctx.logger.warn(`broadcast 失败：channel ${channelId} 不存在`);
      return;
    }
    if (!content) return;
    const exclude = new Set(opts?.exclude ?? []);
    const source = opts?.source ?? 'system';
    const gateway = this.ctx.getService<GatewayService>('gateway');
    for (const sessionId of ch.boundSessions) {
      if (exclude.has(sessionId)) continue;
      // 不写 platform；具体平台由 sessionId 路由表决定（onebot 适配器自己识别）
      const msg = { content, sessionId, source };
      if (gateway) {
        await gateway.dispatchOutbound(msg);
      } else {
        await this.ctx.emit('outbound:message', msg);
      }
    }
  }

  get(channelId: string): SessionChannel | undefined {
    return this.channels.get(channelId);
  }

  list(): SessionChannel[] {
    return [...this.channels.values()];
  }

  forSession(sessionId: string): SessionChannel[] {
    const set = this.bySession.get(sessionId);
    if (!set) return [];
    const out: SessionChannel[] = [];
    for (const id of set) {
      const ch = this.channels.get(id);
      if (ch) out.push(ch);
    }
    return out;
  }

  async getAggregatedHistory(channelId: string, limit?: number): Promise<Message[]> {
    const ch = this.channels.get(channelId);
    if (!ch) return [];
    // 各 session 各取 limit 条（如果指定）；最后再合并截尾
    const perSession = limit ?? 200;
    const merged: Message[] = [];
    for (const sid of ch.boundSessions) {
      let history: Message[];
      try {
        history = await this.memory.getHistory(sid, perSession);
      } catch (err) {
        this.ctx.logger.debug(`getHistory(${sid}) 失败: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const m of history) {
        merged.push({
          ...m,
          metadata: { ...(m.metadata ?? {}), _originSession: sid },
        });
      }
    }
    merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return limit && merged.length > limit ? merged.slice(-limit) : merged;
  }

  // ── 入站汇聚 ─────────────────────────────────────────────────────────────
  // 由 plugin apply() 注册到事件总线后调用

  handleArchived(data: { sessionId: string; incoming: IncomingMessage; archivedMessage: Message }): void {
    const set = this.bySession.get(data.sessionId);
    if (!set || set.size === 0) return;
    for (const channelId of set) {
      const event: ChannelInboundEvent = {
        channelId,
        originSessionId: data.sessionId,
        archivedMessage: data.archivedMessage,
        incoming: data.incoming,
      };
      // emit 是 await 的，但订阅方各自异步处理；这里不阻塞热路径，fire-and-forget
      void this.ctx.emit('channel:message', event);
    }
  }
}
