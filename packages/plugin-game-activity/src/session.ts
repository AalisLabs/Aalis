import type { Context } from '@aalis/core';
import type { LLMService } from '@aalis/plugin-llm-api';
import { parseModelRef } from '@aalis/plugin-llm-api';
import type { Message } from '@aalis/plugin-message-api';
import type { AdapterActionChoice, DecisionRuntime, GameActivityAdapter } from './adapter.js';
import type { BridgeHelloEvent, BridgePromptEvent, BridgeStateEvent } from './protocol.js';

export interface GameActivityHistoryOptions {
  /** Maximum hot decision-thread messages kept before compacting. Includes the system prompt. */
  historyLimit: number;
  /** Number of recent non-system messages to keep when older messages are summarized. */
  keepRecent: number;
  /** Whether to summarize older game decisions instead of simply dropping them. */
  compressionEnabled: boolean;
  /** Max tokens used for the game-session summary. */
  summaryMaxTokens: number;
}

export const defaultGameActivityHistoryOptions: GameActivityHistoryOptions = {
  historyLimit: 120,
  keepRecent: 40,
  compressionEnabled: true,
  summaryMaxTokens: 700,
};

/**
 * One running game session. Holds the long-lived decision conversation thread,
 * the latest state snapshot, and the adapter. Stateful and single-bridge.
 *
 * The runtime trims the conversation history so it doesn't blow context.
 */
export class GameActivitySession {
  readonly adapter: GameActivityAdapter;
  readonly hello: BridgeHelloEvent;
  readonly startedAt = Date.now();

  /** Last full state snapshot received from bridge. */
  latestState: BridgeStateEvent | undefined;

  /** Long-running decision conversation. First entry is the system prompt. */
  private history: Message[] = [];

  private readonly historyOptions: GameActivityHistoryOptions;

  private compressedSummary: string | undefined;

  constructor(
    adapter: GameActivityAdapter,
    hello: BridgeHelloEvent,
    systemPrompt: string,
    historyOptions: Partial<GameActivityHistoryOptions> = {},
  ) {
    this.adapter = adapter;
    this.hello = hello;
    this.historyOptions = normalizeHistoryOptions(historyOptions);
    this.history.push({ role: 'system', content: systemPrompt });
  }

  pushState(event: BridgeStateEvent): void {
    this.latestState = event;
  }

  /** Run a decision turn through the LLM and return an action choice. */
  async decide(
    ctx: Context,
    runtime: DecisionRuntime,
    prompt: BridgePromptEvent,
    extraVibes: string | undefined,
  ): Promise<AdapterActionChoice | null> {
    ctx.logger.debug(
      `game-activity 决策开始: request=${prompt.requestId} phase=${prompt.phase} intent=${prompt.intent ?? 'choose_action'} choices=${prompt.choices?.length ?? 0}`,
    );
    const userMsg = this.adapter.buildDecisionRequest({
      ctx,
      prompt,
      latestState: this.latestState,
      vibes: extraVibes,
    });

    this.history.push({ role: 'user', content: userMsg });
    await this.compactIfNeeded(ctx, runtime);

    const decisionMessages = this.buildDecisionMessages();

    const llmRaw = await this.callLlm(ctx, runtime, decisionMessages);
    if (!llmRaw) {
      ctx.logger.warn(`game-activity 决策无回复或超时: request=${prompt.requestId}`);
      return null;
    }

    this.history.push({ role: 'assistant', content: llmRaw });
    await this.compactIfNeeded(ctx, runtime);

    const choice = this.adapter.parseDecisionReply({ ctx, llmRaw, prompt });
    if (!choice) {
      ctx.logger.warn(`game-activity 决策解析失败: request=${prompt.requestId} raw=${llmRaw.slice(0, 240)}`);
    } else {
      ctx.logger.info(
        `game-activity 决策完成: request=${prompt.requestId} action=${JSON.stringify(choice.action)}${choice.reason ? ` reason=${choice.reason}` : ''}`,
      );
    }
    return choice;
  }

  /** Inject a free-form notification into the decision thread (no LLM call). */
  noteEvent(role: 'user' | 'system', content: string): void {
    this.history.push({ role, content });
    this.trimWithoutSummary();
  }

  snapshotHistory(): Message[] {
    return this.buildDecisionMessages();
  }

  private async callLlm(ctx: Context, runtime: DecisionRuntime, messages: Message[]): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), runtime.timeoutMs);
    try {
      const resp = await runtime.llm.chat({
        messages,
        temperature: 0.2,
        maxTokens: 240,
        signal: ac.signal,
        ...(runtime.think !== undefined ? { think: runtime.think } : {}),
        ...(runtime.providerOverride ? { provider: runtime.providerOverride } : {}),
        ...(runtime.modelOverride ? { model: runtime.modelOverride } : {}),
      });
      return (resp.content ?? '').trim();
    } catch (err) {
      ctx.logger.warn(`game-activity LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  private buildDecisionMessages(): Message[] {
    const messages: Message[] = [this.history[0]];
    if (this.compressedSummary) {
      messages.push({
        role: 'system',
        content: `以下是本局游戏较早决策和观战互动的压缩摘要。它用于保持长期策略、构筑方向、观众建议和 Aalis 已作承诺的连续性：\n${this.compressedSummary}`,
        metadata: { source: 'game-activity-summary' },
      });
    }
    messages.push(...this.history.slice(1));
    return messages;
  }

  private async compactIfNeeded(ctx: Context, runtime: DecisionRuntime): Promise<void> {
    if (this.history.length <= this.historyOptions.historyLimit) return;

    if (!this.historyOptions.compressionEnabled) {
      this.trimWithoutSummary();
      return;
    }

    const keepRecent = Math.min(this.historyOptions.keepRecent, Math.max(1, this.historyOptions.historyLimit - 2));
    const nonSystem = this.history.slice(1);
    const oldMessages = nonSystem.slice(0, Math.max(0, nonSystem.length - keepRecent));
    const tail = nonSystem.slice(-keepRecent);
    if (!oldMessages.length) {
      this.trimWithoutSummary();
      return;
    }

    try {
      const summary = await this.summarizeOldMessages(ctx, runtime, oldMessages);
      if (summary) this.compressedSummary = summary;
      this.history = [this.history[0], ...tail];
      ctx.logger.info(
        `game-activity 决策历史已压缩: ${oldMessages.length} 条旧消息 -> 摘要，保留最近 ${tail.length} 条`,
      );
    } catch (err) {
      ctx.logger.warn(
        `game-activity 决策历史压缩失败，改为保留最近消息: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.history = [this.history[0], ...tail];
    }
  }

  private async summarizeOldMessages(_ctx: Context, runtime: DecisionRuntime, oldMessages: Message[]): Promise<string> {
    const formattedMessages = oldMessages
      .map(message => `${formatRole(message.role)}: ${truncateMessageContent(message.content ?? '', 1600)}`)
      .join('\n');

    const previousSummary = this.compressedSummary ? `已有摘要：\n${this.compressedSummary}\n\n` : '';
    const messages: Message[] = [
      {
        role: 'system',
        content:
          '你是游戏会话摘要器。请把 Aalis 打游戏时较早的决策历史压缩成高密度摘要，保留：当前构筑方向、关键奖励/路线/事件选择、观众建议与 Aalis 是否采纳、长期目标、需要避免重复犯的错误。不要写无关寒暄。',
      },
      {
        role: 'user',
        content: `${previousSummary}新增待压缩消息：\n${formattedMessages}`,
      },
    ];

    const resp = await runtime.llm.chat({
      messages,
      temperature: 0.2,
      maxTokens: this.historyOptions.summaryMaxTokens,
      think: false,
      ...(runtime.providerOverride ? { provider: runtime.providerOverride } : {}),
      ...(runtime.modelOverride ? { model: runtime.modelOverride } : {}),
    });
    return (resp.content ?? '').trim();
  }

  private trimWithoutSummary(): void {
    if (this.history.length <= this.historyOptions.historyLimit) return;
    // Always keep system prompt and the most recent (limit-1) messages.
    const sys = this.history[0];
    const tail = this.history.slice(-(this.historyOptions.historyLimit - 1));
    this.history = [sys, ...tail];
  }
}

function normalizeHistoryOptions(options: Partial<GameActivityHistoryOptions>): GameActivityHistoryOptions {
  const historyLimit = clampInteger(options.historyLimit, defaultGameActivityHistoryOptions.historyLimit, 10, 300);
  const keepRecent = clampInteger(
    options.keepRecent,
    defaultGameActivityHistoryOptions.keepRecent,
    4,
    historyLimit - 2,
  );
  return {
    historyLimit,
    keepRecent,
    compressionEnabled: options.compressionEnabled ?? defaultGameActivityHistoryOptions.compressionEnabled,
    summaryMaxTokens: clampInteger(
      options.summaryMaxTokens,
      defaultGameActivityHistoryOptions.summaryMaxTokens,
      200,
      2000,
    ),
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function formatRole(role: Message['role']): string {
  switch (role) {
    case 'user':
      return '决策请求/游戏事件';
    case 'assistant':
      return 'Aalis决策';
    case 'system':
      return '系统事件';
    case 'tool':
      return '工具';
  }
}

function truncateMessageContent(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 15)}... [已截断]`;
}

/**
 * Produces the runtime config for a session by resolving the configured
 * decision model through Aalis' provider router. 支持复合 ref `<contextId>::<modelId>`。
 */
export async function resolveDecisionRuntime(
  ctx: Context,
  decisionModel: string,
  timeoutMs: number,
  think?: boolean,
): Promise<DecisionRuntime | undefined> {
  const defaultLlm = ctx.getService<LLMService>('llm');
  if (!defaultLlm) return undefined;

  // 拆解复合 ref，并通过 chat({provider, model}) 让 router 精确路由
  const ref = parseModelRef(decisionModel.trim() || undefined);
  return { llm: defaultLlm, providerOverride: ref.provider, modelOverride: ref.model, timeoutMs, think };
}
