import type { ConfigSchema, Context } from '@aalis/core';
import type { FlowControlService } from '@aalis/plugin-flow-control-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import type {} from '@aalis/plugin-webui-api'; // declaration merging：SchemaField 表单属性（secret/dynamicOptions/allowCustom）
import type { TriggerDecision, TriggerPolicyService } from './types.js';
import '@aalis/plugin-gateway-api';

export type { TriggerDecision, TriggerKind, TriggerPolicyService } from './types.js';

import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';
import {
  defaultTriggerPolicyConfig,
  isScopeEnabled,
  resolveEffectiveConfig,
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
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。写一条 override 自动启用该 scope。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      intervalMode: {
        type: 'select',
        label: '间隔模式',
        options: [
          { label: 'fixed', value: 'fixed' },
          { label: 'dynamic', value: 'dynamic' },
          { label: 'both', value: 'both' },
        ],
      },
      triggerOnAt: { type: 'boolean', label: '检测 @ 提及' },
      triggerNames: { type: 'string', label: '触发名别名（逗号分隔）' },
      muteKeywords: { type: 'string', label: '禁言关键词（逗号分隔）' },
      muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）' },
    },
  },
};

export const defaultConfig = defaultTriggerPolicyConfig;

// ----- 入口 -----

export function apply(ctx: Context, raw: Record<string, unknown>): void {
  const cfg = resolveTriggerPolicyConfig(raw);

  /** 从 IncomingMessage 派生 per-scope override 用的 targetId（群=groupId / 私=userId / 其他=空） */
  function extractTargetId(message: IncomingMessage): string {
    if (message.sessionType === 'group') return message.groupId ?? '';
    if (message.sessionType === 'private') return message.userId ?? '';
    return '';
  }

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
      const tid = extractTargetId(message);
      if (!isScopeEnabled(cfg, message.platform, message.sessionType, tid)) {
        return {
          kind: 'direct',
          reason: `scope 不在触发策略名单内 (${message.platform ?? '?'}:${message.sessionType ?? '?'})`,
        };
      }
      const eff = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);
      // 特殊通知事件（poke 等）视同 @ 直触发：能进到这里说明 adapter 已经判断过
      // 目标是 bot（私聊 poke 全部回复 / 群聊 poke 仅在 target=self 时才转成 inbound）。
      if (message.noticeType === 'poke') {
        return { kind: 'immediate', reason: 'poke notice' };
      }
      if (checkImmediateTrigger(ctx, eff, message.content)) {
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
      switch (eff.intervalMode) {
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
        ? { kind: 'interval', reason: `interval-mode=${eff.intervalMode}` }
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
      `mute时长=${cfg.muteTimeSeconds}s, scopes=${cfg.scopes.join('|') || '<空>'}, ` +
      `overrides=${cfg.overrides.length})`,
  );

  // ===== inbound:trigger 相位：触发判定 =====
  // 由 plugin-gateway 在 inbound:flow 之后、inbound:dispatch 之前触发。
  // 进入本相位意味着已通过冷却/限速闸门。
  ctx.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
    const { message } = data;
    if (message.source === 'idle-trigger') return next(); // 内部注入跳过策略

    const flow = ctx.getService<FlowControlService>('flow-control');
    const tid = extractTargetId(message);

    // 不在触发策略作用域内（默认 *:group）：直接放行。
    // 必须在 mute 检查之前进行，否则 QQ 群的 mute 关键词会泄漏到 WebUI/私聊等不在 scope 内的会话。
    if (!isScopeEnabled(cfg, message.platform, message.sessionType, tid)) {
      return next();
    }
    const eff = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);

    // mute 关键词命中：设置自禁言并 swallow
    if (checkMuteKeyword(ctx, eff, message.content)) {
      ctx.logger.info(`[trigger] mute 关键词命中 → swallow + setMuted(${eff.muteTimeSeconds}s): ${message.sessionId}`);
      flow?.setMuted(message.sessionId, eff.muteTimeSeconds);
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

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'trigger-policy': import('./types.js').TriggerPolicyService;
  }
}
