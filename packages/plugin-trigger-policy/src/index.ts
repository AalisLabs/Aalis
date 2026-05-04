import type {
  Context,
  ConfigSchema,
  FlowControlService,
  IncomingMessage,
  MessageArchiveService,
  TriggerDecision,
  TriggerPolicyService,
} from '@aalis/core';
import { GATEWAY_MIDDLEWARE_PRIORITY } from '@aalis/core';
import {
  type TriggerPolicyConfig,
  defaultTriggerPolicyConfig,
  isPlatformEnabled,
  isScopeEnabled,
  isSessionTypeEnabled,
  resolveTriggerPolicyConfig,
} from './config.js';
import {
  checkImmediateTrigger,
  checkMuteKeyword,
  getBotNames,
} from './detector.js';

// ----- 元数据 -----

export const name = '@aalis/plugin-trigger-policy';
export const displayName = '触发策略';
export const provides = ['trigger-policy'];
export const inject = {
  optional: ['flow-control', 'persona', 'message-archive'],
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用触发策略', default: defaultTriggerPolicyConfig.enabled },
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: defaultTriggerPolicyConfig.scopes,
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description: '格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认 *:group。',
  },
  platforms: { type: 'string', label: '[兼容] 生效平台', default: '', description: '已被 scopes 取代；填入后与 scopes 取 AND。' },
  sessionTypes: { type: 'string', label: '[兼容] 生效会话类型', default: '', description: '已被 scopes 取代；填入后与 scopes 取 AND。' },
  intervalMode: {
    type: 'select', label: '间隔模式', default: defaultTriggerPolicyConfig.intervalMode,
    options: [
      { label: 'fixed (仅按计数)', value: 'fixed' },
      { label: 'dynamic (仅按评分阈值)', value: 'dynamic' },
      { label: 'both (任一满足)', value: 'both' },
    ],
  },
  triggerOnAt: { type: 'boolean', label: '检测 @ 提及', default: defaultTriggerPolicyConfig.triggerOnAt },
  triggerNames: { type: 'string', label: '触发名别名（逗号分隔）', default: '' },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号分隔）', default: '' },
  muteTimeSeconds: { type: 'number', label: '禁言关键词命中时长（秒）', default: defaultTriggerPolicyConfig.muteTimeSeconds },
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
      if (!isScopeEnabled(cfg, message.platform, message.sessionType) ||
          !isSessionTypeEnabled(cfg, message.sessionType)) {
        return { kind: 'direct', reason: `scope 不在触发策略名单内 (${message.platform ?? '?'}:${message.sessionType ?? '?'})` };
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
        case 'fixed':   trigger = fixedOk; break;
        case 'dynamic': trigger = dynamicOk; break;
        case 'both':    trigger = fixedOk || dynamicOk; break;
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

  // ===== gateway:inbound 中间件：触发判定 =====
  // priority=GATEWAY_MIDDLEWARE_PRIORITY.TRIGGER_POLICY(700) → 在 flow-control(900) 之后；进入此中间件意味着已通过冷却/限速闸门。
  ctx.middleware('gateway:inbound', async (data, next) => {
    const { message } = data;
    if (!isPlatformEnabled(cfg, message.platform)) return next();
    if (message.source === 'idle-trigger') return next(); // 内部注入跳过策略

    const flow = ctx.getService<FlowControlService>('flow-control');

    // mute 关键词命中：设置自禁言并 swallow
    if (checkMuteKeyword(ctx, cfg, message.content)) {
      ctx.logger.info(
        `[trigger] mute 关键词命中 → swallow + setMuted(${cfg.muteTimeSeconds}s): ${message.sessionId}`,
      );
      flow?.setMuted(message.sessionId, cfg.muteTimeSeconds);
      await shadowArchive(message);
      return; // swallow
    }

    // 不在触发策略作用域内（默认 *:group）：直接放行
    if (!isScopeEnabled(cfg, message.platform, message.sessionType) ||
        !isSessionTypeEnabled(cfg, message.sessionType)) {
      return next();
    }

    let decision: ReturnType<typeof service.decide>;
    try {
      decision = service.decide(message);
    } catch (err) {
      ctx.logger.warn(`[trigger] decide() 异常，默认放行: ${err}`);
      await next();
      return;
    }
    if (decision.kind === 'immediate' || decision.kind === 'interval') {
      ctx.logger.debug(`[trigger] ${decision.kind} 触发 (${decision.reason}): session=${message.sessionId}`);
      flow?.recordTriggered(message.sessionId);
      message.triggerType = decision.kind;
      await next();
      return;
    }
    // swallow
    ctx.logger.debug(`[trigger] swallow (${decision.reason}): session=${message.sessionId}`);
    await shadowArchive(message);
    // flow-control 已在前置中调度 idle，无需重复
  }, GATEWAY_MIDDLEWARE_PRIORITY.TRIGGER_POLICY);
}

export type { TriggerPolicyConfig };
