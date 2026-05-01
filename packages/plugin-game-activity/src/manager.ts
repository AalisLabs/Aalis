import { randomUUID } from 'node:crypto';
import type { Context } from '@aalis/core';
import type {
  BridgeActionCommand,
  BridgeEvent,
  BridgeHelloEvent,
  BridgePromptEvent,
  BridgeStateEvent,
} from './protocol.js';
import { BRIDGE_PROTOCOL_VERSION } from './protocol.js';
import type { BridgeConnection } from './bridge-client.js';
import type { GameActivityAdapter } from './adapter.js';
import { GameActivitySession, defaultGameActivityHistoryOptions, resolveDecisionRuntime } from './session.js';
import type { GameActivityHistoryOptions } from './session.js';

/**
 * 最小的 channel 服务接口（duck-typed，避免硬依赖 plugin-session-channel 的类型）。
 * 只用到 broadcast 和 getAggregatedHistory 两个方法。
 */
interface ChannelLike {
  broadcast(channelId: string, content: string, opts?: { source?: 'agent' | 'system' | 'command' }): Promise<void>;
  getAggregatedHistory(channelId: string, limit?: number): Promise<Array<{ role: string; content: string | null; metadata?: Record<string, unknown> }>>;
}

/**
 * Owns adapters and the single active bridge session. Wires bridge events
 * into the right adapter, drives decision turns, and pushes resulting
 * actions back. 可绑定 session-channel 以便聚合群聊 vibes / 广播 chat。
 */
export class GameActivityManager {
  private readonly adapters = new Map<string, GameActivityAdapter>();
  /** 当前活跃 game session（翻转后只期望单一连接） */
  private session: GameActivitySession | undefined;
  private sessionConnId: string | undefined;

  private decisionModel = '';
  private decisionTimeoutMs = 15_000;
  private decisionThink: boolean | undefined;
  private decisionHistoryOptions: GameActivityHistoryOptions = defaultGameActivityHistoryOptions;
  private personaPrompt: string | undefined;

  /** 当前绑定的 channel id；用于聚合 vibes 和广播 chat。 */
  private boundChannelId: string | undefined;
  private noChoiceStreak = 0;

  registerAdapter(adapter: GameActivityAdapter): () => void {
    this.adapters.set(adapter.game, adapter);
    return () => {
      if (this.adapters.get(adapter.game) === adapter) {
        this.adapters.delete(adapter.game);
      }
    };
  }

  setDecisionModel(model: string): void { this.decisionModel = model.trim(); }
  setDecisionTimeout(ms: number): void { this.decisionTimeoutMs = Math.max(1000, ms); }
  setDecisionThink(value: boolean | undefined): void { this.decisionThink = value; }
  setDecisionHistoryOptions(options: GameActivityHistoryOptions): void { this.decisionHistoryOptions = options; }
  setPersonaPrompt(prompt: string | undefined): void { this.personaPrompt = prompt; }

  /** 绑定一个虚拟频道：决策时拉 vibes，决策结果的 chat 广播过去。 */
  setBoundChannel(channelId: string | undefined): void { this.boundChannelId = channelId; }
  getBoundChannel(): string | undefined { return this.boundChannelId; }

  hasActiveSession(): boolean { return this.session !== undefined; }
  getActiveSession(): GameActivitySession | undefined { return this.session; }

  // ── connection lifecycle ─────────────────────────────────────────────────
  onConnect(_ctx: Context, _conn: BridgeConnection): void { /* 等 hello */ }

  onClose(ctx: Context, conn: BridgeConnection): void {
    if (this.sessionConnId !== conn.id) return;
    if (this.session) {
      ctx.logger.info(`game-activity 会话结束: ${this.session.adapter.label} (${this.session.hello.bridgeId})`);
    }
    this.session = undefined;
    this.sessionConnId = undefined;
  }

  // ── inbound events ────────────────────────────────────────────────────────
  async onMessage(ctx: Context, conn: BridgeConnection, msg: BridgeEvent): Promise<void> {
    switch (msg.type) {
      case 'hello':
        return this.handleHello(ctx, conn, msg);
      case 'state':
        return this.handleState(ctx, conn, msg);
      case 'prompt':
        return this.handlePrompt(ctx, conn, msg);
      case 'notify': {
        if (this.session && this.sessionConnId === conn.id) {
          this.session.noteEvent('user', `[${msg.category}] ${msg.message ?? ''}`);
        }
        return;
      }
      case 'action_result': {
        ctx.logger.info(`game-activity 动作结果: request=${msg.requestId} ok=${msg.ok}${msg.error ? ` error=${msg.error}` : ''}`);
        return;
      }
      case 'bye':
        return;
    }
  }

  private handleHello(ctx: Context, conn: BridgeConnection, msg: BridgeHelloEvent): void {
    const adapter = this.adapters.get(msg.game);
    if (!adapter) {
      ctx.logger.warn(`bridge ${msg.bridgeId} 想接入 game="${msg.game}" 但无适配器`);
      return;
    }
    if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      ctx.logger.warn(`bridge ${msg.bridgeId} 协议版本 ${msg.protocolVersion} 与 ${BRIDGE_PROTOCOL_VERSION} 不一致`);
    }
    const systemPrompt = adapter.buildSystemPrompt({
      ctx,
      bridgeInfo: msg.info,
      personaPrompt: this.personaPrompt,
    });
    this.session = new GameActivitySession(adapter, msg, systemPrompt, this.decisionHistoryOptions);
    this.sessionConnId = conn.id;
    ctx.logger.info(`game-activity 已接入: ${adapter.label} bridge=${msg.bridgeId}`);
    conn.send({ type: 'ack', protocolVersion: BRIDGE_PROTOCOL_VERSION });
  }

  private handleState(_ctx: Context, conn: BridgeConnection, msg: BridgeStateEvent): void {
    if (this.sessionConnId !== conn.id || !this.session) return;
    this.session.pushState(msg);
  }

  private async handlePrompt(ctx: Context, conn: BridgeConnection, msg: BridgePromptEvent): Promise<void> {
    if (this.sessionConnId !== conn.id || !this.session) {
      ctx.logger.warn('收到 prompt 但 session 未建立');
      return;
    }
    ctx.logger.info(`game-activity 收到决策请求: request=${msg.requestId} phase=${msg.phase} intent=${msg.intent ?? 'choose_action'} choices=${msg.choices?.length ?? 0}`);
    const sess = this.session;

    const runtime = await resolveDecisionRuntime(ctx, this.decisionModel, this.decisionTimeoutMs, this.decisionThink);
    if (!runtime) {
      ctx.logger.warn('LLM 不可用，无法决策');
      conn.send({ type: 'ack', requestId: msg.requestId, protocolVersion: BRIDGE_PROTOCOL_VERSION });
      return;
    }

    const vibes = await this.collectVibes(ctx);
    const choice = await sess.decide(ctx, runtime, msg, vibes);
    if (!choice) {
      this.noChoiceStreak += 1;
      const fallbackChoice = sess.adapter.resolveFallbackAction?.({
        ctx,
        prompt: msg,
        latestState: sess.latestState,
        noChoiceStreak: this.noChoiceStreak,
      }) ?? null;
      if (fallbackChoice) {
        const fallbackCmd: BridgeActionCommand = {
          type: 'action',
          requestId: randomUUID(),
          inResponseTo: msg.requestId,
          action: fallbackChoice.action,
          reason: fallbackChoice.reason ?? `连续 ${this.noChoiceStreak} 次没有可解析决策，使用适配器保底动作`,
        };
        this.noChoiceStreak = 0;
        conn.send(fallbackCmd);
        ctx.logger.warn(`game-activity 使用适配器保底动作: request=${fallbackCmd.requestId} inResponseTo=${msg.requestId} action=${JSON.stringify(fallbackChoice.action)}`);
        return;
      }
      ctx.logger.warn(`game-activity 没有可发送的动作，ack prompt: ${msg.requestId}`);
      conn.send({ type: 'ack', requestId: msg.requestId, protocolVersion: BRIDGE_PROTOCOL_VERSION });
      return;
    }
    this.noChoiceStreak = 0;

    const cmd: BridgeActionCommand = {
      type: 'action',
      requestId: randomUUID(),
      inResponseTo: msg.requestId,
      action: choice.action,
      reason: choice.reason,
    };
    conn.send(cmd);
    ctx.logger.info(`game-activity 已发送动作: request=${cmd.requestId} inResponseTo=${msg.requestId} action=${JSON.stringify(choice.action)}`);

    // chat 字段不再发回游戏（游戏内没玩家可见聊天框），改广播到 channel
    if (choice.chat && this.boundChannelId) {
      const channel = ctx.getService<ChannelLike>('session-channel');
      if (channel) {
        try {
          await channel.broadcast(this.boundChannelId, choice.chat, { source: 'system' });
        } catch (err) {
          ctx.logger.debug(`channel broadcast 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  private async collectVibes(ctx: Context): Promise<string | undefined> {
    if (!this.boundChannelId) return undefined;
    const channel = ctx.getService<ChannelLike>('session-channel');
    if (!channel) return undefined;
    try {
      const messages = await channel.getAggregatedHistory(this.boundChannelId, 30);
      if (!messages.length) return undefined;
      const lines = messages
        .map(m => ({ ...m, content: normalizeSuggestionText(m.content) }))
        .filter(m => m.content)
        .slice(-12)
        .map(m => {
          const origin = m.metadata?._originSession ? `@${String(m.metadata._originSession).slice(-6)}` : '';
          return `[${m.role}${origin}] ${m.content}`;
        });
      return lines.length ? `recent_suggestions:\n${lines.join('\n')}` : undefined;
    } catch (err) {
      ctx.logger.debug(`collectVibes 失败: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

}

function normalizeSuggestionText(content: string | null): string {
  if (!content) return '';
  const trimmed = content
    .replace(/\s+/g, ' ')
    .replace(/^\s*[>/#]+\s*/, '')
    .trim();
  if (!trimmed) return '';
  if (trimmed.length > 180) return `${trimmed.slice(0, 177)}...`;
  return trimmed;
}
