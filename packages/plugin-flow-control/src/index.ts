import { type FlowControlService, flowControl } from '@aalis/api-flow-control';
import {
  extractTargetId,
  INBOUND_PHASE,
  inferSessionScope,
  isScopeEnabled,
  resolveEffectiveConfig,
} from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { messageArchive } from '@aalis/api-message-archive';
import { createStorageGateway, isStorageNotFound, storage } from '@aalis/api-storage';
import { type BoundOf, config, definePlugin, events, lifecycle, logger, optional, provide } from '@aalis/core';
import { parseConfig } from '@aalis/schema-config';
import type { IncomingMessage, OutgoingMessage } from '@aalis/schema-message';
import { configSchema, type FlowControlConfig, normalizeScopes } from './config.js';
import { createState, type MutableFlowSessionState, rateLimitUsedNow, sweepStaleStates } from './state.js';

// ----- 入口 -----

const uses = {
  logger,
  events,
  hooks,
  lifecycle,
  config,
  provide,
  // 持久化禁言状态用；缺席时写失败只记 warn、流控照常跑；上线（含晚于本插件）时由 follow 读回，读不懂则本次运行拒写
  storage: optional(storage),
  messageArchive: optional(messageArchive),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-flow-control',
  displayName: '消息流控',
  subsystem: 'core',
  configSchema,
  provides: [flowControl],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const { logger, events, hooks, lifecycle, provide, messageArchive } = caps;
  const cfg = normalizeScopes(parseConfig(configSchema, caps.config, logger), logger);
  const states = new Map<string, MutableFlowSessionState>();

  // ===== mutedUntil 持久化（仅此字段） =====
  // 冷却与限速都是秒级短期态，重启后重建无危；但 mutedUntil 可能是小时级的「用户意图」，
  // 丢失会导致重启后静默解除。
  const storage = createStorageGateway(caps.storage);
  const muteStateUri = 'data:/flow-control-mutes.json';
  /**
   * 禁言表读不懂（不是「文件不存在」的读失败、解析失败、结构不对）：写的是整表，此后拒写，
   * 否则下一次 setMuted 就把原有禁言冲掉。每次读（storage 换人时 follow 重读）都重新判定。
   */
  let loadFailed = false;
  /**
   * 自上次成功写盘以来 setMuted 改过的会话（解禁也算，含尚无状态的会话）→ 改动序号。重读时这些会话以内存为准：
   * storage 离线或读取在飞期间的改动还没进文件，按文件值合并会让解禁被旧禁言撤回。
   * 写盘成功后清掉该次快照已含的改动；写链在飞期间又改过的会话序号更大，留到下一次。
   */
  const unsavedMutes = new Map<string, number>();
  let muteRev = 0;
  /**
   * follow 重读的代数。写链等读回的期间又开始了重读就接着等，写出的整表总是已并进最近一次读回。
   * 写盘在飞期间开始了重读时，读到的文件未必含这次写（storage 已换人，或读先于写落盘），
   * 这次写成功也不清 unsavedMutes：重读以内存为准，由读完后的补写落到当前 storage。
   */
  let loadGen = 0;

  async function loadMuteState(): Promise<void> {
    loadFailed = false;
    let raw: string;
    try {
      raw = (await storage.readFile(muteStateUri, 'utf-8')) as string;
    } catch (err) {
      if (isStorageNotFound(err)) return;
      loadFailed = true;
      logger.warn(`[flow] 读取禁言表失败，本次运行不再写入该文件: ${err}`);
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
        if (!mutedUntil || mutedUntil <= now || unsavedMutes.has(sessionId)) continue;
        // storage 晚上线时读回之前可能已有消息建了状态：合并而非替换，禁言取较晚的到期时刻
        const existing = states.get(sessionId);
        if (existing) {
          existing.mutedUntil = Math.max(existing.mutedUntil, mutedUntil);
        } else {
          const s = createState(String(entry?.platform ?? ''));
          s.mutedUntil = mutedUntil;
          states.set(sessionId, s);
        }
        restored++;
      }
      if (restored > 0) logger.info(`[flow] 已恢复 ${restored} 个未过期的禁言状态`);
    } catch (err) {
      loadFailed = true;
      logger.warn(`[flow] 解析禁言表失败，本次运行不再写入该文件: ${err}`);
    }
  }

  // storage 在场即读禁言表：optional 依赖不参与激活拓扑，storage-local 可能晚于本插件上线，
  // 只在 apply 里读一次会读成空表。follow 对「已在线」的服务也会立即触发，故任意加载序都成立。
  // 读一次即完，storage 换人时没有要拆的东西，故不返回清理
  let loading: Promise<void> | undefined;
  caps.storage.follow(() => {
    loadGen++;
    // 读完补写一次：离线期间的改动写盘失败过，还没进文件
    loading = loadMuteState().then(() => {
      if (!loadFailed && unsavedMutes.size > 0) saveMuteState();
    });
  });

  let saveChain: Promise<void> = Promise.resolve();
  function saveMuteState(): void {
    saveChain = saveChain
      .then(async () => {
        // 写的是整表：禁言表还在读时先等它并进内存，等的期间又开始了重读就接着等，否则这次写会冲掉磁盘上的其它会话
        let gen: number;
        do {
          gen = loadGen;
          await loading;
        } while (gen !== loadGen);
        if (loadFailed) {
          logger.warn('[flow] 禁言表加载失败，跳过写入以免覆盖（本次改动仅在内存生效）');
          return;
        }
        const now = Date.now();
        const out: Record<string, { platform: string; mutedUntil: number }> = {};
        for (const [sessionId, s] of states.entries()) {
          if (s.mutedUntil > now) out[sessionId] = { platform: s.platform ?? '', mutedUntil: s.mutedUntil };
        }
        const upTo = muteRev;
        await storage.writeFile(muteStateUri, JSON.stringify(out, null, 2));
        if (gen !== loadGen) return;
        for (const [sessionId, rev] of unsavedMutes) if (rev <= upTo) unsavedMutes.delete(sessionId);
      })
      .catch(err => {
        logger.warn(`[flow] 持久化禁言状态失败: ${err}`);
      });
  }

  // storage 已在线时 follow 是同步首挂：把读取等完再让 apply 返回；storage 晚上线时无从等待，仍异步
  if (loading) await loading;

  /** 取或建状态：补全缺失的会话元数据（setMuted / 出站建出的状态可能缺 sessionType 等），刷新 lastSeenAt */
  function getOrCreate(sessionId: string, platform: string, sessionType = '', targetId = ''): MutableFlowSessionState {
    let s = states.get(sessionId);
    if (!s) {
      s = createState(platform, sessionType, targetId);
      states.set(sessionId, s);
    } else {
      if (!s.platform && platform) s.platform = platform;
      if (!s.sessionType && sessionType) s.sessionType = sessionType;
      if (!s.targetId && targetId) s.targetId = targetId;
      s.lastSeenAt = Date.now();
    }
    return s;
  }

  /** 按 state 上下文解析生效 cfg（应用 overrides） */
  function eff(s: MutableFlowSessionState): FlowControlConfig {
    return resolveEffectiveConfig(cfg, s.platform, s.sessionType, s.targetId);
  }

  /**
   * 手里没有会话类型时判作用域用的平台、类型与目标：先用状态里记下的，状态没有或缺类型（没有真人消息经过本相位的群、
   * 只有禁言记录的群）再按会话 ID 约定推断，平台也先用状态里的。入站带 source 且不带会话类型的内部注入（定时任务、
   * workflow、委派、闲置注入等合成回合）与出站回复记账都走这里，同一口径；推断结果只进本插件的状态、不回写消息。不符合约定的
   * （如 WebUI）类型未知，只有会话类型段为通配的作用域（onebot:*、*）命中
   */
  function knownScope(
    sessionId: string,
    platform: string | undefined,
  ): { platform: string; sessionType?: string; targetId?: string } {
    const s = states.get(sessionId);
    const p = s?.platform || platform || '';
    const known = s?.sessionType ? s : inferSessionScope(p, sessionId);
    return { platform: p, sessionType: known?.sessionType, targetId: known?.targetId };
  }

  /** agent 真实回复一次：补全会话元数据，设冷却、记限速时间戳 */
  function recordReply(sessionId: string, platform: string, sessionType?: string, targetId?: string): void {
    const s = getOrCreate(sessionId, platform, sessionType, targetId);
    const e = eff(s);
    const now = Date.now();
    if (e.cooldownSeconds > 0) s.cooldownUntil = now + e.cooldownSeconds * 1000;
    s.replyTimestamps.push(now);
    // 裁剪：只留限速窗口内的，否则活跃会话会无界增长。限速关闭(window<=0)时根本不被读，直接清空。
    s.replyTimestamps = e.rateLimitWindow > 0 ? s.replyTimestamps.filter(t => t > now - e.rateLimitWindow * 1000) : [];
  }

  /** 把"被流控吞掉"的入站消息归档到 message-archive，下次触发时作为上下文 */
  async function shadowArchive(message: IncomingMessage): Promise<void> {
    // 闲置触发是合成的系统提示，不作为用户消息入档（与 agent 的归档规则一致）
    if (message.source === 'idle-trigger') return;
    const archive = messageArchive.current;
    if (!archive) return;
    try {
      await archive.archiveIncoming(message);
    } catch (err) {
      logger.warn(`[flow] shadow 归档失败: ${err}`);
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
      const e = eff(s);
      if (e.rateLimitWindow <= 0 || e.rateLimitMaxReplies <= 0) return false;
      return rateLimitUsedNow(s, e) >= e.rateLimitMaxReplies;
    },
    setMuted(sessionId, durationSec, platform) {
      let s = states.get(sessionId);
      if (!s && platform && durationSec > 0) {
        s = getOrCreate(sessionId, platform);
      }
      // 尚无状态的会话解禁也记：禁言表还没读回时，读回不得恢复它的旧禁言
      if (s || durationSec <= 0) unsavedMutes.set(sessionId, ++muteRev);
      if (!s) return;
      if (durationSec <= 0) {
        s.mutedUntil = 0;
        saveMuteState();
        logger.info(`[flow] 已解除自禁言: session=${sessionId}`);
        return;
      }
      s.mutedUntil = Date.now() + durationSec * 1000;
      saveMuteState();
      logger.info(`[flow] 已设置自禁言: session=${sessionId}, ${durationSec}s`);
    },
  };

  provide(flowControl, service);

  logger.info(
    `[flow] 已启用 (冷却=${cfg.cooldownSeconds}s, 限速=${cfg.rateLimitWindow}s/${cfg.rateLimitMaxReplies}次, ` +
      `scopes=${cfg.scopes.join('|') || '<空>'}, overrides=${cfg.overrides.length})`,
  );

  // ===== inbound:flow 相位：节流硬闸 =====
  // 由 plugin-gateway 在 inbound:trigger 之后、inbound:dispatch 之前触发，此时生效的触发插件
  // 已判定要开口并写好 message.triggerType。
  hooks.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
    const { message } = data;
    const sessionId = message.sessionId;

    // 禁言期一律吞：不看作用域、不看来源（idle、委派、调度消息同样不说话）。
    // 禁言状态只由关键词或平台禁言针对具体会话写入，作用域之外的会话不会被误伤。
    // 禁言表可能还在读（storage 晚上线时 follow 补读）：读完再判禁言
    if (loading) await loading;
    if (service.isMuted(sessionId)) {
      logger.debug(`[flow] 禁言中 → 吞噬 | session=${sessionId}`);
      await shadowArchive(message);
      return; // swallow
    }

    // 带 source 且不带会话类型的内部注入与回复记账同一口径；其余消息（真人消息，含 WebUI、CLI 发进平台会话的；
    // 自带会话类型的注入）按消息自身的平台、类型与目标判
    const scope =
      message.source && !message.sessionType
        ? knownScope(sessionId, message.platform)
        : { platform: message.platform, sessionType: message.sessionType, targetId: extractTargetId(message) };
    if (!isScopeEnabled(cfg, scope.platform, scope.sessionType, scope.targetId)) return next();

    getOrCreate(sessionId, scope.platform, scope.sessionType, scope.targetId);

    // immediate（@/戳一戳/名字）穿透冷却与限速。内部注入（带 source：闲置触发、定时任务、workflow、
    // 跨会话委派）不过冷却——定时提醒等不该被回复后冷却静默吞掉——但仍受限速约束（防刷屏护栏）。
    if (message.triggerType !== 'immediate') {
      if (!message.source && service.isCoolingDown(sessionId)) {
        logger.debug(`[flow] 冷却中 → 吞噬 | session=${sessionId}`);
        await shadowArchive(message);
        return; // swallow
      }
      if (service.isRateLimited(sessionId)) {
        logger.debug(`[flow] 限速 → 吞噬 | session=${sessionId}`);
        await shadowArchive(message);
        return; // swallow
      }
    }
    await next();
  });

  // agent 真实回复后记冷却与限速，只对作用域内会话，委派闸门与闲置选会话读的就是这份记账。作用域与入站带 source 的
  // 内部注入同一口径（knownScope）
  events.on('outbound:message', (msg: OutgoingMessage) => {
    if (!msg.sessionId) return;
    if (msg.source !== 'agent') return; // 命令/系统回复不算"对话回复"
    const scope = knownScope(msg.sessionId, msg.platform);
    if (!isScopeEnabled(cfg, scope.platform, scope.sessionType, scope.targetId)) return;
    recordReply(msg.sessionId, scope.platform, scope.sessionType, scope.targetId);
  });

  // 长寿进程下避免 states 无限增长：每天扫描一次，清理 30 天未见且无禁言/冷却挂起的会话
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const sweepTimer = setInterval(() => {
    const cleaned = sweepStaleStates(states, Date.now());
    if (cleaned > 0) logger.debug(`[flow] TTL 清理已淘汰 ${cleaned} 个长期非活跃会话状态`);
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  lifecycle.onDispose(async () => {
    clearInterval(sweepTimer);
    // 整表快照在写链里才取：先等排队的写落完再清表，否则清空后的空表会被写回磁盘
    await saveChain;
    states.clear();
  });
}

// 重新导出配置类型，方便其他插件使用
export type { FlowControlConfig };
