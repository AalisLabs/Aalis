// ============================================================
// @aalis/plugin-trigger-laya — Laya 模型触发（trigger 服务的触发插件）
//
// 经本机 HTTP 问 laya-listener 侧车"这条消息 Aalis 此刻该不该开口"，侧车返回 logit，logit ≥ 阈值即开口。
// 自成一体：是 trigger 服务的胜者时，本插件在 inbound:trigger 相位判定作用域内的消息（禁言、禁言关键词、
// 点名识别、附件识别、模型判定），没有计数；不是胜者时对每条消息直接放行，什么都不做。
// @ 与叫名字不强制开口，开不开口由模型决定；点名只决定开口后的类别、授权主体与兜底。
// 模型判定不了时兜底：只回点名，其余吞掉并归档，不回退到别的触发插件。判定不可用（侧车熔断、memory 缺席）
// 由正常转入时记 error、恢复时记 warn，状态也经 doctor 检查项报告。
// 另监听入站归档事件做运行期自检（self-check.ts）。
// ============================================================

import { type CheckResult, doctor } from '@aalis/api-doctor';
import { flowControl } from '@aalis/api-flow-control';
import { extractTargetId, INBOUND_PHASE, isScopeEnabled, resolveEffectiveConfig } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { media } from '@aalis/api-media';
import { memory } from '@aalis/api-memory';
import { messageArchive } from '@aalis/api-message-archive';
import { persona } from '@aalis/api-persona';
import {
  archiveSwallowed,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  trigger,
  waitForAttachmentDescriptions,
} from '@aalis/api-trigger';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（dynamicOptions/allowCustom）
import { type BoundOf, config, definePlugin, events, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { buildIncomingContent, type IncomingMessage, type Message } from '@aalis/schema-message';
import { toWellFormedText } from '@aalis/util-text-normalize';
import { defaultLayaConfig, resolveLayaConfig } from './config.js';
import { createSelfCheck } from './self-check.js';

// ----- 元数据 -----

const configSchema: ConfigSchema = {
  scopes: {
    type: 'multiselect',
    label: '生效作用域',
    default: defaultLayaConfig.scopes,
    dynamicOptions: 'gateway-scopes',
    allowCustom: true,
    description:
      '格式 platform:sessionType，支持通配 *。作用域外的消息直接放行，由后面的流控与 agent 照常处理（默认不含私聊：模型只用群聊训练）。',
  },
  threshold: {
    type: 'number',
    label: '开口阈值',
    description: 'logit ≥ 阈值即开口。留空 = 用侧车返回的模型阈值（随模型版本给出）。',
  },
  triggerOnAt: {
    type: 'boolean',
    label: '检测 @ 提及',
    default: defaultLayaConfig.triggerOnAt,
    description:
      '@ 自己算"被点名"（戳一戳、名字同理）。点名不强制开口，由模型判定；开口的回合记为 immediate，点名者即授权主体。判定不可用时只回点名。',
  },
  triggerOnPoke: {
    type: 'boolean',
    label: '戳一戳算点名',
    default: defaultLayaConfig.triggerOnPoke,
  },
  triggerNames: { type: 'string', label: '点名别名（逗号分隔）', default: '' },
  muteKeywords: { type: 'string', label: '禁言关键词（逗号分隔）', default: '' },
  muteTimeSeconds: {
    type: 'number',
    label: '禁言关键词命中时长（秒）',
    default: defaultLayaConfig.muteTimeSeconds,
  },
  mediaWaitMs: {
    type: 'number',
    label: '附件识别等待上限（毫秒）',
    default: defaultLayaConfig.mediaWaitMs,
    description: '带图片等附件的消息先等识别写好描述再交给模型；超时照常判定，识别在后台继续。',
  },
  endpoint: { type: 'string', label: '侧车地址', default: defaultLayaConfig.endpoint },
  timeoutMs: {
    type: 'number',
    label: '请求超时（毫秒）',
    default: defaultLayaConfig.timeoutMs,
    description: '含读完响应体。超时计一次失败，本条按兜底只回点名。',
  },
  historyRows: {
    type: 'number',
    label: '历史行数',
    default: defaultLayaConfig.historyRows,
    description:
      '窗口的行数，只算 user / assistant 行：从 memory 多取一倍，过滤后留最后这么多行，与侧车渲染回归的取法一致。',
  },
  priority: {
    type: 'number',
    label: '优先级 (越大越优先)',
    default: defaultLayaConfig.priority,
    description: 'trigger 服务按偏好 > 优先级 > 注册顺序选出生效的触发插件；规则判定 trigger-policy 为 0。',
  },
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", threshold} 仅在该 scope 命中时覆盖阈值，最具体者胜；留空 = 沿用上方设置。写一条 override 自动启用该 scope。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      threshold: { type: 'number', label: '开口阈值' },
    },
  },
};

// ----- 侧车请求 -----

/** 连续失败这么多次后熔断，判定转为不可用 */
const CIRCUIT_FAILURES = 3;
/** 熔断时长：期间不发请求，直接兜底 */
const CIRCUIT_OPEN_MS = 30_000;
/** 请求体上限（字节）：侧车契约，见 models/listener-sidecar/README.md「接口」节（laya_listener.py 的 MAX_BODY），超过回 413 */
const MAX_BODY_BYTES = 1 << 20;

/** 侧车窗口的一行（`POST /v1/score` 的 rows 项） */
interface LayaRow {
  role: Message['role'];
  content: string;
  userId?: string;
  nick?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** 历史 → 侧车窗口：只留 user / assistant 且正文是字符串的行，取最后 limit 行；nick 取 metadata.nickname，缺失回落 name */
function toRows(history: Message[], limit: number): LayaRow[] {
  const rows: LayaRow[] = [];
  for (const m of history) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    rows.push({
      role: m.role,
      content: m.content,
      userId: str(m.metadata?.userId),
      nick: str(m.metadata?.nickname) ?? m.name,
    });
  }
  return rows.slice(-limit);
}

/**
 * 从 onebot 会话 ID（`onebot:{selfId}:{group|private}:{targetId}`，见适配器的 makeSessionId）取 bot 自己的账号。
 * 其它平台与会话类型（频道等，模型未见过）返回 undefined，这条按兜底处理。
 */
function parseSelfId(sessionId: string): string | undefined {
  const parts = sessionId.split(':');
  if (parts.length < 4 || parts[0] !== 'onebot' || !parts[1]) return undefined;
  return parts[2] === 'group' || parts[2] === 'private' ? parts[1] : undefined;
}

/** 侧车错误响应体 `{"error": "<code>"}` 里的错误码（只含码，不含消息内容） */
function errorCode(text: string): string {
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    return typeof code === 'string' ? ` ${code}` : '';
  } catch {
    return '';
  }
}

/** 一次判定：模型给出的，或兜底（speak = 是否被点名）及原因 */
type Verdict =
  | { speak: boolean; fallback: string }
  | { speak: boolean; logit: number; threshold: number; version: string };

// ----- 入口 -----

const uses = {
  logger,
  config,
  events,
  hooks,
  provide,
  /** 本插件自己提供 trigger，只能声明成 optional（required 会把激活闸架在自己的产出上）；经它判断本插件是否生效 */
  trigger: optional(trigger),
  // 缺席时不设禁言：关键词照样吞掉本条，但不会写入禁言期
  flowControl: optional(flowControl),
  persona: optional(persona),
  // 缺席时被吞掉的消息不进档，判定照常
  messageArchive: optional(messageArchive),
  // 缺席时不等附件识别，cur 里缺附件描述
  media: optional(media),
  // 缺席时判定不可用：没有历史窗口无从判定，按兜底只回点名
  memory: optional(memory),
  // 缺席时不报诊断项
  doctor: optional(doctor),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-trigger-laya',
  displayName: 'Laya 触发判定',
  subsystem: 'scheduler',
  configSchema,
  provides: [trigger],
  uses,
  apply: run,
});

function run(caps: Caps): void {
  const { logger } = caps;
  const cfg = resolveLayaConfig(caps.config);
  const url = `${cfg.endpoint}/v1/score`;

  // 本插件在 trigger 服务里的实例：服务胜者是它时本插件生效，否则对每条消息直接放行
  const self: TriggerService = { label: 'Laya 模型' };
  caps.provide(trigger, self, { priority: cfg.priority, label: self.label });

  // ----- 可用性：熔断与告警 -----

  let failures = 0;
  let openUntil = 0;
  /** 判定不可用的原因（侧车熔断、memory 缺席）；undefined = 可用 */
  let down: string | undefined;
  let downSince = 0;

  /** 转为不可用：由正常转入时记一条 error，之后只更新原因 */
  function goDown(reason: string): void {
    if (down === undefined) {
      downSince = Date.now();
      logger.error(
        `[laya] 判定不可用（${reason}），已转为只回点名（按 triggerOnAt / triggerOnPoke / 名字识别），其余消息吞掉并归档`,
      );
    }
    down = reason;
  }

  /**
   * 计一次失败：连续第 3 次起熔断（到期后再失败即重新熔断）。转入熔断即判定不可用，一次故障只记一条 error，
   * 之后的并发失败与重新熔断记 debug，恢复由 healthy() 记
   */
  function fail(why: string): void {
    failures++;
    logger.debug(`[laya] 侧车请求失败: ${why}`);
    if (failures < CIRCUIT_FAILURES) return;
    openUntil = Date.now() + CIRCUIT_OPEN_MS;
    // 失败计数只在 healthy() 清零，恰好等于门限的那次就是这次故障的转入
    if (failures === CIRCUIT_FAILURES) {
      goDown(`侧车连续 ${failures} 次失败，最近一次: ${why}；熔断 ${CIRCUIT_OPEN_MS / 1000}s 后重试`);
    } else {
      logger.debug(`[laya] 侧车连续 ${failures} 次失败（最近一次: ${why}），再熔断 ${CIRCUIT_OPEN_MS / 1000}s`);
    }
  }

  /** 侧车正常作答（含 422、413）：失败计数清零；不可用过则记恢复 */
  function healthy(): void {
    failures = 0;
    if (down === undefined) return;
    logger.warn(`[laya] 判定恢复（不可用 ${Math.round((Date.now() - downSince) / 1000)}s，最后原因: ${down}）`);
    down = undefined;
  }

  /** 处于熔断期：不发请求，直接兜底 */
  function circuitOpen(): boolean {
    return failures >= CIRCUIT_FAILURES && Date.now() < openUntil;
  }

  /** 已告警过的模型没见过的会话类别（平台:会话类型）：这类会话每条都兜底，每类只告警一次 */
  const unsupported = new Set<string>();

  // 运行期自检：发请求前记下 cur，这条消息归档后与归档正文比对（归档事件带的 incoming 是拷贝，按键关联）
  const selfCheck = createSelfCheck(line => logger.info(line));
  caps.events.on('inbound:message:archived', ({ sessionId, incoming, archivedMessage }) =>
    selfCheck.settle(sessionId, incoming.messageId, archivedMessage.content ?? ''),
  );

  /** 问侧车；判定不了时兜底（speak = 是否被点名），不抛错之外的异常由调用处兜住 */
  async function judge(message: IncomingMessage, addressed: boolean, threshold?: number): Promise<Verdict> {
    const fallback = (why: string): Verdict => ({ speak: addressed, fallback: why });
    const selfId = parseSelfId(message.sessionId);
    if (!selfId) {
      const kind = `${message.platform}:${message.sessionType ?? ''}`;
      if (!unsupported.has(kind)) {
        unsupported.add(kind);
        logger.warn(
          `[laya] ${kind} 的会话不是模型见过的 onebot 群聊或私聊，这类会话一律按兜底只回点名；` +
            '要让它们照常回复，把它们移出 scopes，或切到 trigger-policy',
        );
      }
      return fallback('会话不适用');
    }
    const mem = caps.memory.current;
    if (!mem) {
      goDown('memory 缺席，没有历史窗口');
      return fallback('memory 缺席');
    }
    if (circuitOpen()) return fallback('侧车熔断中');

    const sid = message.sessionId;
    // 窗口是最近 historyRows 条 user / assistant 行：多取一倍，过滤后再取，与侧车渲染回归的取法一致
    const fetched = cfg.historyRows * 2;
    const history = await (mem.getFullHistory?.(sid, fetched) ?? mem.getHistory(sid, fetched));
    // 当前消息与归档用同一个 buildIncomingContent 拼，附件描述先等识别（有上限，超时照常判定）；
    // 两边仍可能不一致（识别超时、文件描述晚写入等），由运行期自检计数
    await waitForAttachmentDescriptions(message, caps.media, cfg.mediaWaitMs, logger);
    // 取历史与等识别期间可能已熔断：熔断期不发请求
    if (circuitOpen()) return fallback('侧车熔断中');
    const cur = buildIncomingContent(message);
    // 字符串里的孤代理换成 U+FFFD：侧车的分词器不接受孤代理（会回 500，计入熔断）；历史行经库往返后
    // 本来也是 U+FFFD。自检记的仍是换之前的 cur，与归档事件带的原文同一口径
    const body = JSON.stringify(
      {
        rows: toRows(history, cfg.historyRows),
        cur,
        curUserId: message.userId,
        curNick: message.nickname,
        replyTo: message.replyTo ? { userId: message.replyTo.userId, nickname: message.replyTo.nickname } : null,
        selfId,
      },
      (_key, value: unknown) => (typeof value === 'string' ? toWellFormedText(value) : value),
    );
    // 超过侧车上限不发请求、不计失败：侧车不读体就回 413 并关连接，一部分请求在客户端表现为连接错误而非 413。
    // 不截断行来压体积：侧车的发言人编号与截断都基于完整窗口，改窗口会偏离训练口径。窗口里的大行要滚出
    // 窗口才恢复，期间这个会话每条都走兜底，记 info 让用户看得到
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_BODY_BYTES) {
      logger.info(`[laya] 请求体 ${bytes} 字节超过侧车上限 ${MAX_BODY_BYTES}，本条按兜底只回点名 | session=${sid}`);
      return fallback('请求体超限');
    }
    // 确实要发请求才记：在此之前兜底与超限的判定不参与自检
    selfCheck.record(message, cur);

    // 发请求并读完响应体，整体落在同一个超时窗口内（只限响应头的话，迟迟不发体的对端会绕过超时）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      fail(controller.signal.aborted ? `超时（${cfg.timeoutMs}ms）` : `${err}`);
      return fallback('侧车请求失败');
    } finally {
      clearTimeout(timer);
    }

    // 422：这条消息不适合交给模型（系统通知、空消息等）；413：请求体超限（发前已按上限判过，这里兜底）。
    // 侧车本身正常，不计失败
    if (status === 422 || status === 413) {
      healthy();
      return fallback(`侧车 ${status}${errorCode(text)}`);
    }
    if (status < 200 || status >= 300) {
      fail(`HTTP ${status}${errorCode(text)}`);
      return fallback('侧车请求失败');
    }
    let parsed: { logit?: unknown; threshold?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('响应不是 JSON');
      return fallback('侧车请求失败');
    }
    const logit = parsed.logit;
    const t = threshold ?? parsed.threshold;
    if (typeof logit !== 'number' || !Number.isFinite(logit)) {
      fail('响应的 logit 不是有限数');
      return fallback('侧车请求失败');
    }
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      fail('阈值不是有限数');
      return fallback('侧车请求失败');
    }
    healthy();
    return { speak: logit >= t, logit, threshold: t, version: str(parsed.version) ?? '?' };
  }

  // ===== inbound:trigger 相位：要不要开口 =====
  // 由 plugin-gateway 在 inbound:command 之后、inbound:flow 之前触发。放行的消息写好 triggerType，
  // 交给 flow 相位做节流硬闸（immediate 穿透冷却与限速）。
  caps.hooks.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
    // 不是生效的触发插件：什么都不做（不请求、不识别、不归档），交给生效者或往下走
    if (!isActiveTrigger(data, caps.trigger, self)) return next();
    const { message } = data;
    // 内部注入（闲置触发、定时任务、workflow、跨会话委派）都带 source，不经判定、不改 triggerType
    if (message.source) return next();

    // 作用域外直接放行；必须在禁言关键词之前，否则群聊的关键词会作用到私聊、WebUI 等作用域外的会话
    const tid = extractTargetId(message);
    if (!isScopeEnabled(cfg, message.platform, message.sessionType, tid)) return next();

    const sid = message.sessionId;
    const flow = caps.flowControl.current;
    // 禁言期：放行给 flow 相位吞掉并归档；不再识别禁言关键词，避免缩短平台禁言
    if (flow?.isMuted(sid)) return next();

    // 禁言关键词：设置自禁言，吞掉本条
    if (hitsMuteKeyword(message, cfg.muteKeywords)) {
      logger.info(`[laya] mute 关键词命中 → swallow + setMuted(${cfg.muteTimeSeconds}s): ${sid}`);
      flow?.setMuted(sid, cfg.muteTimeSeconds, message.platform);
      await archiveSwallowed(message, caps.messageArchive, logger);
      return; // swallow
    }

    let addressed: boolean;
    try {
      addressed = isAddressed(message, caps.persona, cfg);
    } catch (err) {
      // 名字检测会调外部 persona 提供者；抛错时放行而不是吞掉——失败放行优于失败静默
      logger.warn(`[laya] 点名识别异常，默认放行: ${err}`);
      await next();
      return;
    }

    const { threshold } = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);
    const started = Date.now();
    let verdict: Verdict;
    try {
      verdict = await judge(message, addressed, threshold);
    } catch (err) {
      // 取历史失败等意外：本条兜底，不计侧车失败
      logger.warn(`[laya] 判定异常，本条按兜底只回点名: ${err}`);
      verdict = { speak: addressed, fallback: '判定异常' };
    }
    // 判定日志：不含正文与昵称
    const detail =
      'fallback' in verdict
        ? `兜底=${verdict.fallback}`
        : `logit=${verdict.logit.toFixed(3)} | 阈值=${verdict.threshold} | 版本=${verdict.version}`;
    logger.debug(
      `[laya] 判定 | session=${sid} | speak=${verdict.speak} | addressed=${addressed} | ${detail} | ` +
        `耗时=${Date.now() - started}ms`,
    );

    // 放行与吞掉都不等判定期间启动的附件识别（见 waitForAttachmentDescriptions）
    if (!verdict.speak) {
      await archiveSwallowed(message, caps.messageArchive, logger);
      return; // swallow
    }
    markTriggered(message, addressed);
    await next();
  });

  // ----- 诊断：侧车状态 -----

  /** 探一次侧车的 /health，超时同单次请求 */
  async function probe(): Promise<{ version: string } | { error: string }> {
    try {
      const res = await fetch(`${cfg.endpoint}/health`, { signal: AbortSignal.timeout(cfg.timeoutMs) });
      const text = await res.text();
      if (!res.ok) return { error: `HTTP ${res.status}${errorCode(text)}` };
      return { version: str((JSON.parse(text) as { version?: unknown }).version) ?? '?' };
    } catch (err) {
      return { error: `${err}` };
    }
  }

  caps.doctor.registerCheck({
    id: 'trigger.laya',
    category: 'service',
    async run(): Promise<CheckResult> {
      const current = caps.trigger.current;
      const active = current === self;
      const health = await probe();
      // 当前的故障：探活失败、memory 缺席、熔断期
      const problems: string[] = [];
      if ('error' in health) problems.push(`侧车不可达（${health.error}）`);
      if (!caps.memory.current) problems.push('memory 缺席');
      if (circuitOpen()) problems.push(`判定不可用（${down}）`);
      const parts =
        problems.length > 0 ? [...problems] : [`侧车在线（版本 ${'version' in health ? health.version : '?'}）`];
      // down 只由成功的判定清除：熔断已到期、memory 已回来，但还没有请求确认恢复（本插件不生效时一直如此）。
      // 探活正常不代表 /v1/score 正常，照实报成上次的故障
      const stale = down !== undefined && !circuitOpen() && caps.memory.current !== undefined;
      if (stale) parts.push(`上次判定不可用（${down}），尚未经请求确认恢复`);
      const role = active
        ? '生效中'
        : `未生效（${current ? `生效的触发插件是「${current.label}」` : '没有生效的触发插件'}）`;
      return {
        id: 'trigger.laya',
        category: 'service',
        // 生效时判定不了会让群里只回点名，报 error；未生效时不影响回复、上次的故障未经确认恢复，报 warn
        level: problems.length > 0 ? (active ? 'error' : 'warn') : stale ? 'warn' : 'ok',
        message: `Laya 触发判定${role}：${parts.join('；')}${problems.length > 0 && active ? '，判定按兜底只回点名' : ''}`,
        detail: `endpoint=${cfg.endpoint}`,
      };
    },
  });

  logger.info(
    `[laya] 已启用 (阈值=${cfg.threshold ?? '侧车'}, endpoint=${cfg.endpoint}, prio=${cfg.priority}, ` +
      `scopes=${cfg.scopes.join('|') || '<空>'}, overrides=${cfg.overrides.length})`,
  );
}
