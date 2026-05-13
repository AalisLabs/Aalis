import type { ConfigSchema, Context } from '@aalis/core';
import type { FlowControlService } from '@aalis/plugin-flow-control';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive';
import type { TriggerDecision, TriggerPolicyService } from './types.js';
import '@aalis/plugin-gateway-api';

export type { TriggerDecision, TriggerKind, TriggerPolicyService } from './types.js';

import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';
import {
  defaultTriggerPolicyConfig,
  isScopeEnabled,
  resolveTriggerPolicyConfig,
  type TriggerPolicyConfig,
} from './config.js';
import { checkImmediateTrigger, checkMuteKeyword, getBotNames } from './detector.js';

// ----- 元数据 -----

export const name = '@aalis/plugin-trigger-policy';
export const displayName = '触发策略';
export const subsystem = 'scheduler';
export const provides = ['trigger-policy'];
export const inject = {
  required: ['gateway'],
  optional: ['flow-control', 'persona', 'message-archive'],
};

export const configSchema: ConfigSchema = {
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: defaultTriggerPolicyConfig.scopes,
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description: '格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认 *:group。',
  },
  intervalMode: {
    type: 'select',
    label: '间隔模式',
    default: defaultTriggerPolicyConfig.intervalMode,
    options: [
      { label: 'fixed (仅按计数)', value: 'fixed' },
      { label: 'dynamic (仅按评分阈值)', value: 'dynamic' },
      { label: 'both (任一满足)', value: 'both' },
    ],
  },
  triggerOnAt: { type: 'boolean', label: '检测 @ 提及', default: defaultTriggerPolicyConfig.triggerOnAt },
  triggerNames: { type: 'string', label: '触发名别名（逗号分隔）', default: '' },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号分隔）', default: '' },
  muteTimeSeconds: {
    type: 'number',
    label: '禁言关键词命中时长（秒）',
    default: defaultTriggerPolicyConfig.muteTimeSeconds,
  },
};

export const defaultConfig = defaultTriggerPolicyConfig;

// ----- 入口 -----

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg = resolveTriggerPolicyConfig(raw);

  /** 把"被策略吞掉"的入站消息归档（与 flow-control 的 shadow 归档对齐） */
  async function shadowArchive(message: IncomingMessage): Promise<void> {
    const archive = ctx.getService<MessageArchiveService>('message-archive');
    if (!archive) return;
    try {
      await archive.archiveIncoming(message);
    } catch (err) {
      ctx.logger.warn(`[trigger] shadow 归档失败: ${err}`);
    }
  }

  const service: TriggerPolicyService = {
    decide(message): TriggerDecision {
      if (!isScopeEnabled(cfg, message.platform, message.sessionType)) {
        return {
          kind: 'direct',
          reason: `scope 不在触发策略名单内 (${message.platform ?? '?'}:${message.sessionType ?? '?'})`,
        };
      }
      if (checkImmediateTrigger(ctx, cfg, message.content)) {
        return { kind: 'immediate', reason: '@/name match' };
      }
      const flow = ctx.getService<FlowControlService>('flow-control');
      const snap = flow?.getStateSnapshot(message.sessionId);
      if (!snap) {
        return { kind: 'interval', reason: 'no flow state, default-pass' };
      }
      const fixedOk = snap.messageCount >= snap.fixedInterval;
      const dynamicOk = snap.activityScore >= (flow?.getThreshold(message.sessionId) ?? 0);
      let trigger = false;
      switch (cfg.intervalMode) {
        case 'fixed':
          trigger = fixedOk;
          break;
        case 'dynamic':
          trigger = dynamicOk;
          break;
        case 'both':
          trigger = fixedOk || dynamicOk;
          break;
      }
      return trigger
        ? { kind: 'interval', reason: `interval-mode=${cfg.intervalMode}` }
        : { kind: 'swallow', reason: 'below threshold' };
    },
    getBotNames() {
      return getBotNames(ctx, cfg);
    },
    detectMuteKeyword(content) {
      return checkMuteKeyword(ctx, cfg, content);
    },
  };

  ctx.provide('trigger-policy', service);

  ctx.logger.info(
    `[trigger] 已启用 (模式=${cfg.intervalMode}, @提及=${cfg.triggerOnAt}, ` +
      `别名=${cfg.triggerNames.length}, mute关键词=${cfg.muteKeywords.length}, ` +
      `mute时长=${cfg.muteTimeSeconds}s, scopes=${cfg.scopes.join('|') || '<空>'})`,
  );

  // ===== inbound:trigger 相位：触发判定 =====
  // 由 plugin-gateway 在 inbound:flow 之后、inbound:dispatch 之前触发。
  // 进入本相位意味着已通过冷却/限速闸门。
  ctx.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
    const { message } = data;
    if (message.source === 'idle-trigger') return next(); // 内部注入跳过策略

    const flow = ctx.getService<FlowControlService>('flow-control');

    // 不在触发策略作用域内（默认 *:group）：直接放行。
    // 必须在 mute 检查之前进行，否则 QQ 群的 mute 关键词会泄漏到 WebUI/私聊等不在 scope 内的会话。
    if (!isScopeEnabled(cfg, message.platform, message.sessionType)) {
      return next();
    }

    // mute 关键词命中：设置自禁言并 swallow
    if (checkMuteKeyword(ctx, cfg, message.content)) {
      ctx.logger.info(`[trigger] mute 关键词命中 → swallow + setMuted(${cfg.muteTimeSeconds}s): ${message.sessionId}`);
      flow?.setMuted(message.sessionId, cfg.muteTimeSeconds);
      // 与 dev OneBot ChatFlow 一致：设置自禁言后调度一次 idle，
      // 让禁言结束附近能正常进入「长期静默→主动招呼」路径。
      flow?.rescheduleIdle(message.sessionId, message.platform);
      await shadowArchive(message);
      return; // swallow
    }

    let decision: ReturnType<typeof service.decide>;
    try {
      decision = service.decide(message);
    } catch (err) {
      ctx.logger.warn(`[trigger] decide() 异常，默认放行: ${err}`);
      await next();
      return;
    }

    // 统一状态日志（与历史 dev OneBot ChatFlow 的"消息计数/发言指数"日志保持一致）：
    // 让运维可以一眼看到"还差多少条/多少分会触发"。
    const snap = flow?.getStateSnapshot(message.sessionId);
    const threshold = flow?.getThreshold(message.sessionId);
    const stateStr = snap
      ? `计数=${snap.messageCount}/${snap.fixedInterval} | 指数=${snap.activityScore.toFixed(3)} (阈值=${(threshold ?? 0).toFixed(3)})`
      : '无 flow 状态';

    if (decision.kind === 'immediate' || decision.kind === 'interval') {
      ctx.logger.debug(
        `[trigger] ${decision.kind} → 触发 | session=${message.sessionId} | ${stateStr} | ${decision.reason}`,
      );
      flow?.recordTriggered(message.sessionId);
      message.triggerType = decision.kind;
      await next();
      return;
    }
    // swallow
    ctx.logger.debug(`[trigger] 未触发 → 吞噬 | session=${message.sessionId} | ${stateStr} | ${decision.reason}`);
    await shadowArchive(message);
    // flow-control 已在前置中调度 idle，无需重复
  });
}

export type { TriggerPolicyConfig };
