import { agent } from '@aalis/api-agent';
import { type FlowControlService, flowControl } from '@aalis/api-flow-control';
import { audienceIncludes, INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { messageArchive } from '@aalis/api-message-archive';
import { fromElsewhere, sessionManager } from '@aalis/api-session-manager';
import { sessionFields } from '@aalis/api-session-settings';
import { isStorageNotFound, storage } from '@aalis/api-storage';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { arrivalTag, type IncomingMessage, type OutgoingMessage } from '@aalis/schema-message';
import { configSchema } from './config.js';
import { createState, type MutableFlowSessionState, rateLimitUsedNow, sweepStaleStates } from './state.js';
import { t } from './texts.js';

// ----- 入口 -----

const uses = {
  logger,
  events,
  hooks,
  lifecycle,
  config,
  provide,
  /**
   * 禁言表的持久化出口：激活时读回整表、禁言改动整表写回。required：读回要在它上线之后（optional 不参与激活先后），
   * 它下线时随之停下、重新上线后重新读回
   */
  storage,
  messageArchive: optional(messageArchive),
  /**
   * 带 source 的内部注入与回复计数按会话记下的聊天窗口判生效范围，也用来判从别的平台往房间里插话；缺席时只认真人消息经过
   * 本相位时记下的，插话判不出
   */
  sessionManager: optional(sessionManager),
  /** 按会话读生效范围与参数；缺席时取插件配置里的值 */
  sessionFields: optional(sessionFields),
  /** 禁言时停下这个会话在跑的一轮、放掉排着的；缺席时禁言只挡之后的消息 */
  agent: optional(agent),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-flow-control',
  displayName: t('displayName'),
  subsystem: 'core',
  configSchema,
  provides: [flowControl],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { logger, events, hooks, lifecycle, provide, messageArchive } = caps;
  const fields = caps.sessionFields.use.fields(configSchema, caps);
  const states = new Map<string, MutableFlowSessionState>();

  // ===== mutedUntil 持久化（仅此字段） =====
  // 冷却与限速都是秒级短期态，重启后重建无危；但 mutedUntil 可能是小时级的「用户意图」，
  // 丢失会导致重启后静默解除。
  const storage = caps.storage.use;
  const muteStateUri = 'data:/flow-control-mutes.json';
  /**
   * 禁言表读不懂（不是「文件不存在」的读失败、解析失败、结构不对）：写的是整表，此后拒写，
   * 否则下一次 setMuted 就把原有禁言冲掉。只在激活时读一次。
   */
  let loadFailed = false;

  async function loadMuteState(): Promise<void> {
    let raw: string;
    try {
      raw = (await storage.readFile(muteStateUri, 'utf-8')) as string;
    } catch (err) {
      if (isStorageNotFound(err)) return;
      loadFailed = true;
      logger.use.warn(`[flow] 读取禁言表失败，本次运行不再写入该文件: ${err}`);
      return;
    }
    try {
      const data = JSON.parse(raw) as Record<string, { platform?: string; mutedUntil?: number }>;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('禁言表顶层不是 JSON 对象');
      }
      const now = Date.now();
      let restored = 0;
      for (const [sessionId, entry] of Object.entries(data)) {
        const mutedUntil = Number(entry?.mutedUntil ?? 0);
        if (!mutedUntil || mutedUntil <= now) continue;
        const s = createState(String(entry?.platform ?? ''));
        s.mutedUntil = mutedUntil;
        states.set(sessionId, s);
        restored++;
      }
      if (restored > 0) logger.use.info(`[flow] 已恢复 ${restored} 个未过期的禁言状态`);
    } catch (err) {
      loadFailed = true;
      logger.use.warn(`[flow] 解析禁言表失败，本次运行不再写入该文件: ${err}`);
    }
  }

  let saveChain: Promise<void> = Promise.resolve();
  function saveMuteState(): void {
    saveChain = saveChain
      .then(async () => {
        if (loadFailed) {
          logger.use.warn('[flow] 禁言表加载失败，跳过写入以免覆盖（本次改动仅在内存生效）');
          return;
        }
        const now = Date.now();
        const out: Record<string, { platform: string; mutedUntil: number }> = {};
        for (const [sessionId, s] of states.entries()) {
          if (s.mutedUntil > now) out[sessionId] = { platform: s.platform ?? '', mutedUntil: s.mutedUntil };
        }
        await storage.writeFile(muteStateUri, JSON.stringify(out, null, 2));
      })
      .catch(err => {
        logger.use.warn(`[flow] 持久化禁言状态失败: ${err}`);
      });
  }

  await loadMuteState();

  /** 取或建状态：补全缺失的会话元数据（setMuted 建出的状态缺多方标记），刷新 lastSeenAt */
  function getOrCreate(sessionId: string, platform: string, multiParty?: boolean): MutableFlowSessionState {
    let s = states.get(sessionId);
    if (!s) {
      s = createState(platform, multiParty);
      states.set(sessionId, s);
    } else {
      if (!s.platform && platform) s.platform = platform;
      if (s.multiParty === undefined && multiParty !== undefined) s.multiParty = multiParty;
      s.lastSeenAt = Date.now();
    }
    return s;
  }

  /** 这个会话此刻的参数，按会话现读（改了下一条消息起生效）；platform 是入口平台 */
  const settingsOf = (sessionId: string, platform: string | undefined) => fields.get(sessionId, { platform });

  /**
   * 手里没有聊天窗口时用的平台与多方标记：先取会话记下的出生平台与聊天窗口，会话管理缺席或没有记录时用状态里记下的（真人消息
   * 经过本相位时按网关算的窗口记下）。入站带 source 的内部注入（定时任务、workflow、闲置注入等合成回合）与出站回复计数都走
   * 这里，同一口径；结果只进本插件的状态、不回写消息。没有聊天窗口的会话（WebUI、终端、子任务）不是房间，不在任何生效范围里
   */
  function knownWindow(sessionId: string, platform: string | undefined): { platform: string; multiParty?: boolean } {
    const session = caps.sessionManager.present ? caps.sessionManager.use.getSession(sessionId) : undefined;
    if (session?.originPlatform !== undefined && session.originChat) {
      return { platform: session.originPlatform, multiParty: session.originChat.multiParty };
    }
    const s = states.get(sessionId);
    return { platform: s?.platform || platform || '', multiParty: s?.multiParty };
  }

  /** 这个窗口在不在这个会话的生效范围里：不知道多方与否的不在 */
  const inAudience = (sessionId: string, window: { platform: string; multiParty?: boolean }) =>
    window.multiParty !== undefined &&
    audienceIncludes(settingsOf(sessionId, window.platform).audience, window.multiParty);

  /** agent 真实回复一次：补全会话元数据，设冷却、记限速时间戳 */
  function recordReply(sessionId: string, platform: string, multiParty?: boolean): void {
    const s = getOrCreate(sessionId, platform, multiParty);
    const e = settingsOf(sessionId, s.platform);
    const now = Date.now();
    if (e.cooldownSeconds > 0) s.cooldownUntil = now + e.cooldownSeconds * 1000;
    s.replyTimestamps.push(now);
    // 裁剪：只留限速窗口内的，否则活跃会话会无界增长。限速关闭(window<=0)时根本不被读，直接清空。
    s.replyTimestamps = e.rateLimitWindow > 0 ? s.replyTimestamps.filter(t => t > now - e.rateLimitWindow * 1000) : [];
  }

  /** 把"被流控吞掉"的入站消息归档到 message-archive，下次触发时作为上下文；哪些不落档（空闲开话题的提示）由存档定 */
  async function shadowArchive(message: IncomingMessage): Promise<void> {
    if (!messageArchive.present) return;
    const archive = messageArchive.use;
    try {
      await archive.archiveIncoming(message);
    } catch (err) {
      logger.use.warn(`[flow] shadow 归档失败: ${err}`);
    }
  }

  // ===== Service 实现 =====

  const service: FlowControlService = {
    isMuted(sessionId) {
      const s = states.get(sessionId);
      return !!s && Date.now() < s.mutedUntil;
    },
    isCoolingDown(sessionId) {
      const s = states.get(sessionId);
      return !!s && Date.now() < s.cooldownUntil;
    },
    isRateLimited(sessionId) {
      const s = states.get(sessionId);
      if (!s) return false;
      const e = settingsOf(sessionId, s.platform);
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
        logger.use.info(`[flow] 已解除自禁言: session=${sessionId}`);
        return;
      }
      s.mutedUntil = Date.now() + durationSec * 1000;
      saveMuteState();
      logger.use.info(`[flow] 已设置自禁言: session=${sessionId}, ${durationSec}s`);
      // 禁言真的停下在跑的一轮（不外发、不落库回复），排着的不再开轮（在那一轮落定之后归档）
      if (caps.agent.present) caps.agent.use.abort(sessionId, { queued: true, reason: '禁言' });
    },
  };

  provide.use(flowControl, service);

  // 启动日志写全局层；按会话设的另在各层
  const global = fields.get();
  logger.use.info(
    `[flow] 已启用 (生效范围=${global.audience}, 冷却=${global.cooldownSeconds}s, ` +
      `限速=${global.rateLimitWindow}s/${global.rateLimitMaxReplies}次)`,
  );

  // ===== inbound:flow 相位：节流硬闸 =====
  // 由 plugin-gateway 在 inbound:trigger 之后、inbound:dispatch 之前触发，此时生效的触发插件
  // 已判定要开口并写好 message.triggerType。
  hooks.use.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
    const { message } = data;
    const sessionId = message.sessionId;

    // 禁言期一律吞：不看生效范围、不看来源（idle、调度消息同样不说话）。
    // 禁言状态只由关键词或平台禁言针对具体会话写入，范围之外的会话不会被误伤。
    if (service.isMuted(sessionId)) {
      logger.use.debug(`[flow] 禁言中 → 吞噬${arrivalTag(message)} | session=${sessionId}`);
      await shadowArchive(message);
      return; // swallow
    }

    // 没有 source 的入站（真人消息）按网关算的聊天窗口判；带 source 的内部注入没有，与回复计数同一口径。没有 source 的入站里
    // 从别的平台往房间里插话的（owner 从 WebUI 往群里发）与触发插件同一判法，直接放行，不进冷却与限速
    const { chat } = data;
    if (chat && fromElsewhere(message, caps.sessionManager)) return next();
    const window = chat ?? knownWindow(sessionId, message.platform);
    if (!inAudience(sessionId, window)) return next();

    getOrCreate(sessionId, window.platform, window.multiParty);

    // immediate（@/戳一戳/名字）穿透冷却与限速。内部注入（带 source：闲置触发、定时任务、workflow）
    // 不过冷却——定时提醒等不该被回复后冷却静默吞掉——但仍受限速约束（防刷屏护栏）。
    if (message.triggerType !== 'immediate') {
      if (!message.source && service.isCoolingDown(sessionId)) {
        logger.use.debug(`[flow] 冷却中 → 吞噬${arrivalTag(message)} | session=${sessionId}`);
        await shadowArchive(message);
        return; // swallow
      }
      if (service.isRateLimited(sessionId)) {
        logger.use.debug(`[flow] 限速 → 吞噬${arrivalTag(message)} | session=${sessionId}`);
        await shadowArchive(message);
        return; // swallow
      }
    }
    await next();
  });

  // agent 真实回复后记冷却与限速，只对生效范围内的房间，闲置选会话读的就是这份计数。窗口与入站带 source 的
  // 内部注入同一口径（knownWindow）
  events.use.on('outbound:message', (msg: OutgoingMessage) => {
    if (!msg.sessionId) return;
    // 宿主通知的固定正文代替了 Agent 转述，同样占用回复额度；普通命令/系统提示不计。
    if (msg.source !== 'agent' && !(msg.source === 'system' && msg.hostNotice)) return;
    const window = knownWindow(msg.sessionId, msg.platform);
    if (!inAudience(msg.sessionId, window)) return;
    recordReply(msg.sessionId, window.platform, window.multiParty);
  });

  // 长寿进程下避免 states 无限增长：每天扫描一次，清理 30 天未见且无禁言/冷却挂起的会话
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    const cleaned = sweepStaleStates(states, Date.now());
    if (cleaned > 0) logger.use.debug(`[flow] TTL 清理已淘汰 ${cleaned} 个长期非活跃会话状态`);
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  // 写盘是交给 storage 的依赖交接，在收尾里等完。收尾之后、撤回之前服务仍对外可调（如宿主用着本插件时，空档里先登记的
  // 插件收尾时经 services 现查到它），这时排上的写在清理里再等一次：storage 等本插件关完才收尾，写落在它还在的时候
  lifecycle.use.onDrain(() => saveChain);
  lifecycle.use.onDispose(async () => {
    clearInterval(sweepTimer);
    await saveChain;
  });
}
