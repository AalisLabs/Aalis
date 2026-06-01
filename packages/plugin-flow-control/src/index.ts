import type { ConfigSchema, Context } from '@aalis/core';
import { INBOUND_PHASE } from '@aalis/plugin-gateway-api';
import type { OutgoingMessage } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type { FlowControlService, FlowSessionStateSnapshot } from './types.js';
import '@aalis/plugin-gateway-api';

export type { FlowControlService, FlowSessionStateSnapshot } from './types.js';

import {
  defaultFlowControlConfig,
  type FlowControlConfig,
  isScopeEnabled,
  resolveEffectiveConfig,
  resolveFlowControlConfig,
} from './config.js';
import { clearSessionIdle, PlatformIdleScheduler, scheduleSessionIdle } from './idle-scheduler.js';
import {
  applyScoreDecay,
  calculateScoreIncrement,
  createState,
  getCurrentThreshold,
  type MutableFlowSessionState,
  rateLimitUsedNow,
  snapshot,
} from './state.js';

// ----- 元数据 -----

export const name = '@aalis/plugin-flow-control';
export const displayName = '消息流控';
export const subsystem = 'core';
export const provides = ['flow-control'];
export const inject = {
  required: ['gateway'],
  optional: ['message-archive'],
};

export const configSchema: ConfigSchema = {
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: defaultFlowControlConfig.scopes,
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description:
      '格式 platform:sessionType，支持通配 *；onebot:group / onebot:* / *:group / *。默认 *:group 与历史 OneBot 行为一致。',
  },
  fixedInterval: { type: 'number', label: '固定间隔（每 N 条触发）', default: defaultFlowControlConfig.fixedInterval },
  activityScoreLower: { type: 'number', label: '活跃指数下限', default: defaultFlowControlConfig.activityScoreLower },
  activityScoreUpper: { type: 'number', label: '活跃指数上限', default: defaultFlowControlConfig.activityScoreUpper },
  activityDecayMinutes: {
    type: 'number',
    label: '阈值衰减分钟',
    default: defaultFlowControlConfig.activityDecayMinutes,
  },
  scoreDecayMinutes: {
    type: 'number',
    label: '评分衰减分钟（0=不衰减）',
    default: defaultFlowControlConfig.scoreDecayMinutes,
  },
  cooldownSeconds: { type: 'number', label: '回复后冷却（秒）', default: defaultFlowControlConfig.cooldownSeconds },
  muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）', default: defaultFlowControlConfig.muteTimeSeconds },
  rateLimitWindow: {
    type: 'number',
    label: '限速窗口（秒，0=关闭）',
    default: defaultFlowControlConfig.rateLimitWindow,
  },
  rateLimitMaxReplies: {
    type: 'number',
    label: '窗口内最大回复数',
    default: defaultFlowControlConfig.rateLimitMaxReplies,
  },
  idleTriggerScope: {
    type: 'select',
    label: '闲置触发范围',
    default: defaultFlowControlConfig.idleTriggerScope,
    options: [
      { label: 'off (关闭)', value: 'off' },
      { label: 'session (每会话独立定时)', value: 'session' },
      { label: 'platform (跨会话选举)', value: 'platform' },
    ],
  },
  idleTriggerStrategy: {
    type: 'select',
    label: '闲置触发策略',
    default: defaultFlowControlConfig.idleTriggerStrategy,
    options: [
      { label: 'all-quiet (所有会话都静默时)', value: 'all-quiet' },
      { label: 'fixed (固定间隔)', value: 'fixed' },
    ],
  },
  idleTriggerMinutes: { type: 'number', label: '闲置触发分钟', default: defaultFlowControlConfig.idleTriggerMinutes },
  idleTriggerStyle: {
    type: 'select',
    label: '闲置触发风格',
    default: defaultFlowControlConfig.idleTriggerStyle,
    options: [
      { label: 'exponential (指数退避)', value: 'exponential' },
      { label: 'fixed (固定)', value: 'fixed' },
    ],
  },
  idleTriggerMaxMinutes: {
    type: 'number',
    label: '闲置触发上限分钟',
    default: defaultFlowControlConfig.idleTriggerMaxMinutes,
  },
  idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动', default: defaultFlowControlConfig.idleTriggerJitter },
  idleTriggerPrompt: { type: 'string', label: '闲置触发系统提示', default: defaultFlowControlConfig.idleTriggerPrompt },
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。最具体匹配优先（targetId > sessionType > platform > 通配）。例：scope="*:private", cooldownSeconds=10 让所有平台私聊单独 10s 冷却，其他字段继续走默认。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      fixedInterval: { type: 'number', label: '固定间隔（每 N 条触发）' },
      activityScoreLower: { type: 'number', label: '活跃指数下限' },
      activityScoreUpper: { type: 'number', label: '活跃指数上限' },
      activityDecayMinutes: { type: 'number', label: '阈值衰减分钟' },
      scoreDecayMinutes: { type: 'number', label: '评分衰减分钟' },
      cooldownSeconds: { type: 'number', label: '回复后冷却（秒）' },
      muteTimeSeconds: { type: 'number', label: '禁言关键词时长（秒）' },
      rateLimitWindow: { type: 'number', label: '限速窗口（秒）' },
      rateLimitMaxReplies: { type: 'number', label: '窗口内最大回复数' },
      idleTriggerScope: {
        type: 'select',
        label: '闲置触发范围',
        options: [
          { label: 'off', value: 'off' },
          { label: 'session', value: 'session' },
          { label: 'platform', value: 'platform' },
        ],
      },
      idleTriggerMinutes: { type: 'number', label: '闲置触发分钟' },
      idleTriggerMaxMinutes: { type: 'number', label: '闲置触发上限分钟' },
      idleTriggerJitter: { type: 'boolean', label: '闲置触发抖动' },
      idleTriggerPrompt: { type: 'string', label: '闲置触发系统提示' },
    },
  },
};

export const defaultConfig = defaultFlowControlConfig;

// ----- 入口 -----

export async function apply(ctx: Context, raw: Record<string, unknown>): Promise<void> {
  const cfg = resolveFlowControlConfig(raw);
  const states = new Map<string, MutableFlowSessionState>();
  const platformIdle = new PlatformIdleScheduler(ctx, cfg, states);

  // ===== mutedUntil 持久化（仅此字段） =====
  // 其他运行时态（cooldownUntil/replyTimestamps/activityScore等）都是秒级短期，
  // 重启后重建无危；但 mutedUntil 可能是小时级的「用户意图」，丢失会导致重启后静默解除。
  const storage = createStorageGateway(ctx);
  const muteStateUri = 'data:/flow-control-mutes.json';

  async function loadMuteState(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = (await storage.readFile(muteStateUri, 'utf-8')) as string;
      } catch {
        return;
      }
      const data = JSON.parse(raw) as Record<string, { platform?: string; mutedUntil?: number }>;
      if (!data || typeof data !== 'object') return;
      const now = Date.now();
      let restored = 0;
      for (const [sessionId, entry] of Object.entries(data)) {
        const mutedUntil = Number(entry?.mutedUntil ?? 0);
        if (!mutedUntil || mutedUntil <= now) continue;
        const platform = String(entry?.platform ?? '');
        const s = createState(platform);
        s.mutedUntil = mutedUntil;
        states.set(sessionId, s);
        restored++;
      }
      if (restored > 0) ctx.logger.info(`[flow] 已恢复 ${restored} 个未过期的禁言状态`);
    } catch (err) {
      ctx.logger.warn(`[flow] 加载禁言状态失败: ${err}`);
    }
  }

  let saveChain: Promise<void> = Promise.resolve();
  function saveMuteState(): void {
    const now = Date.now();
    const out: Record<string, { platform: string; mutedUntil: number }> = {};
    for (const [sessionId, s] of states.entries()) {
      if (s.mutedUntil > now) out[sessionId] = { platform: s.platform ?? '', mutedUntil: s.mutedUntil };
    }
    const payload = JSON.stringify(out, null, 2);
    saveChain = saveChain
      .then(() => storage.writeFile(muteStateUri, payload))
      .catch(err => {
        ctx.logger.warn(`[flow] 持久化禁言状态失败: ${err}`);
      });
  }

  await loadMuteState();

  /** 从 IncomingMessage 派生 per-scope override 用的 targetId（群=groupId / 私=userId / 其他=空） */
  function extractTargetId(message: import('@aalis/plugin-message-api').IncomingMessage): string {
    if (message.sessionType === 'group') return message.groupId ?? '';
    if (message.sessionType === 'private') return message.userId ?? '';
    return '';
  }

  function getOrCreate(sessionId: string, platform: string, sessionType = '', targetId = ''): MutableFlowSessionState {
    let s = states.get(sessionId);
    if (!s) {
      s = createState(platform, sessionType, targetId);
      states.set(sessionId, s);
    } else {
      if (!s.platform && platform) s.platform = platform;
      if (!s.sessionType && sessionType) s.sessionType = sessionType;
      if (!s.targetId && targetId) s.targetId = targetId;
    }
    return s;
  }

  /** 按 state 上下文解析生效 cfg（应用 overrides） */
  function eff(s: MutableFlowSessionState | undefined): FlowControlConfig {
    if (!s) return cfg;
    return resolveEffectiveConfig(cfg, s.platform, s.sessionType, s.targetId);
  }

  function logStatus(sessionId: string, s: MutableFlowSessionState, label: string): void {
    const e = eff(s);
    const threshold = getCurrentThreshold(s, e);
    ctx.logger.debug(
      `[flow] ${label} | session=${sessionId} | ` +
        `计数=${s.messageCount}/${e.fixedInterval} | ` +
        `指数=${s.activityScore.toFixed(3)} (阈值=${threshold.toFixed(3)})`,
    );
  }

  /** 把"被流控吞掉"的入站消息归档到 message-archive，下次触发时作为上下文 */
  async function shadowArchive(message: import('@aalis/plugin-message-api').IncomingMessage): Promise<void> {
    const archive = ctx.getService<MessageArchiveService>('message-archive');
    if (!archive) return;
    try {
      await archive.archiveIncoming(message);
    } catch (err) {
      ctx.logger.warn(`[flow] shadow 归档失败: ${err}`);
    }
  }

  // ===== Service 实现 =====

  const service: FlowControlService = {
    ensureState(sessionId, platform, sessionType, targetId) {
      getOrCreate(sessionId, platform, sessionType, targetId);
    },
    getStateSnapshot(sessionId): FlowSessionStateSnapshot | undefined {
      const s = states.get(sessionId);
      return s ? snapshot(s, eff(s)) : undefined;
    },
    recordIncoming(sessionId, platform, userId, sessionType, targetId) {
      const s = getOrCreate(sessionId, platform, sessionType, targetId);
      const e = eff(s);
      const now = Date.now();
      applyScoreDecay(s, e);
      if (userId) {
        const prev = s.userInteractions.get(userId) ?? { count: 0, lastTime: 0 };
        s.userInteractions.set(userId, { count: prev.count + 1, lastTime: now });
      }
      s.lastMessageTime = now;
      s.messageCount++;
      s.activityScore += calculateScoreIncrement(s, e, userId);
    },
    recordTriggered(sessionId) {
      const s = states.get(sessionId);
      if (!s) return;
      s.messageCount = 0;
      s.activityScore = 0;
      s.lastReplyTime = Date.now();
      s.idleBackoff = 1;
    },
    recordReply(sessionId, platform) {
      const s = getOrCreate(sessionId, platform);
      const e = eff(s);
      if (e.cooldownSeconds > 0) {
        s.cooldownUntil = Date.now() + e.cooldownSeconds * 1000;
      }
      s.idleBackoff = 1;
      s.replyTimestamps.push(Date.now());
      this.rescheduleIdle(sessionId, platform);
    },
    isCoolingDown(sessionId) {
      const s = states.get(sessionId);
      return !!s && Date.now() < s.cooldownUntil;
    },
    isMuted(sessionId) {
      const s = states.get(sessionId);
      return !!s && Date.now() < s.mutedUntil;
    },
    isRateLimited(sessionId) {
      const s = states.get(sessionId);
      if (!s) return false;
      const e = eff(s);
      if (e.rateLimitWindow <= 0 || e.rateLimitMaxReplies <= 0) return false;
      return rateLimitUsedNow(s, e) >= e.rateLimitMaxReplies;
    },
    setMuted(sessionId, durationSec, platform) {
      let s = states.get(sessionId);
      if (!s && platform && durationSec > 0) {
        s = getOrCreate(sessionId, platform);
      }
      if (!s) return;
      if (durationSec <= 0) {
        s.mutedUntil = 0;
        saveMuteState();
        ctx.logger.info(`[flow] 已解除自禁言: session=${sessionId}`);
        return;
      }
      s.mutedUntil = Date.now() + durationSec * 1000;
      s.messageCount = 0;
      s.activityScore = 0;
      clearSessionIdle(s);
      saveMuteState();
      ctx.logger.info(`[flow] 已设置自禁言: session=${sessionId}, ${durationSec}s`);
    },
    getThreshold(sessionId) {
      const s = states.get(sessionId);
      if (!s) return cfg.activityScoreLower;
      return getCurrentThreshold(s, eff(s));
    },
    rescheduleIdle(sessionId, platform) {
      const s = states.get(sessionId);
      if (!s) return;
      scheduleSessionIdle(ctx, eff(s), s, sessionId, platform, () => this.rescheduleIdle(sessionId, platform));
    },
  };

  ctx.provide('flow-control', service);

  ctx.logger.info(
    `[flow] 已启用 (固定间隔=${cfg.fixedInterval}, 阈值=${cfg.activityScoreLower}~${cfg.activityScoreUpper}, ` +
      `冷却=${cfg.cooldownSeconds}s, 限速=${cfg.rateLimitWindow}s/${cfg.rateLimitMaxReplies}次, ` +
      `idle=${cfg.idleTriggerScope}/${cfg.idleTriggerStrategy}, scopes=${cfg.scopes.join('|') || '<空>'}, ` +
      `overrides=${cfg.overrides.length})`,
  );

  // ===== inbound:flow 相位：流控前置闸门 =====
  // 由 plugin-gateway 在 inbound:command 之后、inbound:trigger 之前触发。
  // 默认 scopes=['*:group'] 与历史 OneBot ChatFlow 行为一致；
  // overrides 中任一 scope 命中也视为启用（用于 *:private 等单独覆盖场景）。
  ctx.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
    const { message } = data;
    if (!isScopeEnabled(cfg, message.platform, message.sessionType, extractTargetId(message))) return next();
    if (message.source === 'idle-trigger') return next(); // 内部注入不再过流控

    const targetId = extractTargetId(message);
    service.ensureState(message.sessionId, message.platform, message.sessionType, targetId);
    service.recordIncoming(message.sessionId, message.platform, message.userId, message.sessionType, targetId);

    const s = states.get(message.sessionId)!;

    if (service.isMuted(message.sessionId)) {
      // 禁言期不重置 idle timer：避免在禁言结束后被立即唤醒重复触发。
      logStatus(message.sessionId, s, '禁言中 → 吞噬');
      await shadowArchive(message);
      return; // swallow
    }
    if (service.isCoolingDown(message.sessionId)) {
      logStatus(message.sessionId, s, '冷却中 → 吞噬');
      await shadowArchive(message);
      service.rescheduleIdle(message.sessionId, message.platform);
      return; // swallow
    }
    if (service.isRateLimited(message.sessionId)) {
      logStatus(message.sessionId, s, '限速 → 吞噬');
      await shadowArchive(message);
      service.rescheduleIdle(message.sessionId, message.platform);
      return; // swallow
    }
    // 通过流控前置闸门：交给下一相位（inbound:trigger → inbound:dispatch）
    await next();
  });

  // 出站消息后记录冷却 / 重置退避（同样仅对群会话计入流控）
  ctx.on('outbound:message', (msg: OutgoingMessage) => {
    if (!msg.sessionId) return;
    if (msg.source !== 'agent') return; // 命令/系统回复不算"对话回复"
    const s = states.get(msg.sessionId);
    if (!s) return; // 没有 state 说明该 session 从未走过群流控（私聊/CLI 等），跳过
    service.recordReply(msg.sessionId, s.platform);
  });

  // 平台级 idle 启动
  ctx.on('ready', () => {
    platformIdle.start();
  });

  // 长寿进程下避免 states 无限增长：每天扫描一次，清理 30 天未活动且无禁言/冷却挂起的会话
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sid, s] of states) {
      const lastActive = Math.max(s.lastMessageTime, s.lastReplyTime);
      const hasPending = s.mutedUntil > now || s.cooldownUntil > now || !!s.idleTimer;
      if (!hasPending && lastActive > 0 && now - lastActive > SESSION_TTL_MS) {
        clearSessionIdle(s);
        states.delete(sid);
        cleaned++;
      }
    }
    if (cleaned > 0) ctx.logger.debug(`[flow] TTL 清理已淘汰 ${cleaned} 个长期非活跃会话状态`);
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  ctx.onDispose(() => {
    clearInterval(sweepTimer);
    platformIdle.stop();
    for (const s of states.values()) clearSessionIdle(s);
    states.clear();
  });
}

// 重新导出配置类型，方便其他插件使用
export type { FlowControlConfig };
