// ============================================================
// @aalis/plugin-trigger-laya — Laya 模型触发（trigger 服务的触发插件）
//
// 经本机 HTTP 问 laya-listener 侧车"这条消息 Aalis 此刻该不该开口"，侧车返回 logit，logit ≥ 阈值即开口。
// 自成一体：是 trigger 服务的胜者时，本插件在 inbound:trigger 相位判定作用域内的消息（禁言、禁言关键词、
// 点名识别、附件识别、模型判定），没有计数；不是胜者时对每条消息直接放行，什么都不做。
// @ 与叫名字不强制开口，开不开口由模型决定；点名只决定开口后的类别、授权主体与兜底。
// 模型判定不了时兜底：只回点名，其余吞掉并归档，不回退到别的触发插件。判定不可用（侧车熔断、memory 缺席）
// 由正常转入时记 error、恢复时记 warn，状态也经 doctor 检查项报告。
// 判定是异步的（等附件识别与侧车），放行前核对同一会话的到达顺序：更晚到的消息已放行时，先到的这条不再放行
// （临时做法，见 run 里「同一会话的放行顺序」）。
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
import { sessionManager } from '@aalis/api-session-manager';
import {
  archiveSwallowed,
  createBotNames,
  hitsMuteKeyword,
  isActiveTrigger,
  isAddressed,
  markTriggered,
  type TriggerService,
  trigger,
} from '@aalis/api-trigger';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（dynamicOptions/allowCustom）
import { type BoundOf, config, definePlugin, events, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import {
  buildIncomingContent,
  getMessageName,
  type IncomingMessage,
  type Message,
  parseAttachmentRefs,
} from '@aalis/schema-message';
import { toWellFormedText } from '@aalis/util-text-normalize';
import { waitForAttachmentDescriptions } from './attachments.js';
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
    description: '窗口的行数，只算 user / assistant 且正文是字符串的行：从 memory 多取一倍，过滤后留最后这么多行。',
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
/** selfNames 的个数与单个名字长度上限：侧车契约（laya_listener.py 的 MAX_SELF_NAMES / MAX_SELF_NAME_LEN），超过回 400 */
const MAX_SELF_NAMES = 32;
const MAX_SELF_NAME_LENGTH = 32;

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

/**
 * 历史 → 侧车窗口：只留 user / assistant 且正文是字符串的行，取最后 limit 行；nick 取 metadata.nickname，缺失回落
 * name（归档时为 userId）。先滤掉正文不是字符串的行再取行：正文为空的工具调用行不占名额（侧车本来也丢弃它们），
 * 这一点与侧车渲染回归 replay_data.py 只按角色过滤不同，差别只在侧车建昵称表时看到多少行
 */
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

// ----- 诊断：带图消息判定时有没有图片内容 -----

/** 诊断项看最近这么多条计入的带图消息（口径见 imagesPointerOnly） */
const IMAGE_WINDOW = 20;
/** 其中图片只有指针的达到这么多条，生效时诊断项报 warn */
const POINTER_ONLY_WARN = 10;

/**
 * 判定时这条消息的图片是否都只有指针、没有内容描述。只有指针：描述位为空（识别跑完了但没有描述，如没有可用的
 * 识别模型），或只有不带描述的附件引用 `[图片 | ref:…]`（media 关了图片到达即识别时写的）。识别失败的占位不算
 * （media 每次失败另记 warn）；动图走视频的抽帧识别，没有识别模型时写的是抽帧失败的说明，也不算，所以只覆盖
 * 静态图。多张图时每张都只有指针才算。附件识别还没写回（超过 mediaWaitMs、识别抛错、media 缺席）或没有图片
 * 附件时返回 undefined，不计入：前者由自检汇总的「缺附件描述」反映，media 缺席见依赖说明
 */
function imagesPointerOnly(message: IncomingMessage): boolean | undefined {
  const descs = message._attachmentDescriptions;
  if (!descs) return undefined;
  const images = (message.attachments ?? []).flatMap((a, i) => (a.kind === 'image' ? [descs[i]] : []));
  if (images.length === 0) return undefined;
  return images.every(d => {
    if (!d?.trim()) return true;
    const refs = parseAttachmentRefs(d);
    return refs.length > 0 && refs.every(r => !r.desc);
  });
}

/** 一个会话里判定在途的消息的到达与放行（见 run 的「同一会话的放行顺序」） */
interface SessionOrder {
  /** 已到达的消息数，到达序号从 1 起 */
  arrived: number;
  /** 已放行的消息里最大的到达序号 */
  released: number;
  /** 判定在途的消息数，归零时删除本条 */
  inflight: number;
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
  // 名字检测与发给侧车的 selfNames 取全部人设的名字、昵称；缺席时只用 triggerNames
  persona: optional(persona),
  // 名字表按会话取人设：解析会话配置里的角色卡；缺席时取全局默认的卡
  sessionManager: optional(sessionManager),
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
  /** 名字表：别名与全部人设按会话取的名字、昵称；某个人设读名字出错只跳过它的名字 */
  const botNames = createBotNames(caps.persona, caps.sessionManager, logger, '[laya]');

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
    // 失败计数在侧车正常作答时清零（成功的判定与 422 / 413），恰好等于门限的那次是转入熔断。判定不可用期间
    // 回过 422 / 413 又攒满门限的，仍是同一次故障：goDown 只在由可用转入时记 error
    if (failures === CIRCUIT_FAILURES) {
      goDown(`侧车连续 ${failures} 次失败，最近一次: ${why}；熔断 ${CIRCUIT_OPEN_MS / 1000}s 后重试`);
    } else {
      logger.debug(`[laya] 侧车连续 ${failures} 次失败（最近一次: ${why}），再熔断 ${CIRCUIT_OPEN_MS / 1000}s`);
    }
  }

  /** 一次成功的判定：失败计数清零；不可用过则记恢复 */
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

  // ----- 同一会话的放行顺序（临时做法） -----
  // 判定要等附件识别（至多 mediaWaitMs）与侧车，同一会话里先到的消息可能晚于后到的判完。后到的已放行、agent
  // 仍在为它生成时再放行先到的，agent 按会话的 latest-wins 会中止那一轮，接替的回合以先到的为当前消息；后到的
  // 那条在它的回合开始时已经归档（中止不回滚），在接替回合里只是历史，不再是当前消息。所以放行前核对：同一会话里
  // 更晚到达的消息已经放行，这条就不再放行，归档后吞掉（不看后到那一轮是否还在生成）。兜底判定同样核对。带 source
  // 的内部注入不排序号：agent 按「会话 + 来源」分道，它们与真人消息互不中止。
  // 已知缺点：先发图、再说一句时，文字那一轮开始时图片那条还没判完、没有归档，回复看不到图；被点名的带图消息
  // 识别慢、其间同一会话更晚到的消息先放行时，它被作废，没人回应。同一会话按到达先后放行与处理计划改由通道层
  // 统一做（网关入口按到达先后编号，同一会话按到达先后排队），届时删掉本段与 arrive。

  /** 有判定在途的会话：该会话最后一条判定结束即删除，条目数不超过有判定在途的会话数 */
  const orders = new Map<string, SessionOrder>();

  /**
   * 记下一条消息在会话里的到达序号，返回判定结束时调用的收尾（每条调用一次）：传入判定结果，返回 true 表示
   * 这条要放行、但同一会话更晚到的消息已经放行过，作废
   */
  function arrive(sid: string): (speak: boolean) => boolean {
    let order = orders.get(sid);
    if (!order) {
      order = { arrived: 0, released: 0, inflight: 0 };
      orders.set(sid, order);
    }
    const o = order;
    const seq = ++o.arrived;
    o.inflight++;
    return speak => {
      if (--o.inflight === 0) orders.delete(sid);
      if (!speak) return false;
      if (o.released > seq) return true;
      o.released = seq;
      return false;
    };
  }

  /** 近期计入的带图消息（imagesPointerOnly）：图片是否都只有指针，最多 IMAGE_WINDOW 条，先进先出 */
  const recentImages: boolean[] = [];

  /** 已告警过的模型没见过的会话类别（平台:会话类型）：这类会话每条都兜底，每类只告警一次 */
  const unsupported = new Set<string>();

  // 运行期自检：发请求前记下 cur，这条消息归档后与归档正文比对（归档事件带的 incoming 是拷贝，按键关联）
  const selfCheck = createSelfCheck(line => logger.info(line));
  caps.events.on('inbound:message:archived', ({ sessionId, incoming, archivedMessage }) =>
    selfCheck.settle(sessionId, incoming.messageId, archivedMessage.content ?? ''),
  );

  /**
   * 问侧车；判定不了时兜底（speak = 是否被点名），不抛错之外的异常由调用处兜住。names 是点名识别用的
   * 名字表，作为 selfNames 发给侧车：侧车渲染时把正文里的这些名字换成模型认识的 bot 代号
   */
  async function judge(
    message: IncomingMessage,
    addressed: boolean,
    names: readonly string[],
    threshold?: number,
  ): Promise<Verdict> {
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
    // 窗口是最近 historyRows 条 user / assistant 且正文是字符串的行：多取一倍，过滤后再取（见 toRows）
    const fetched = cfg.historyRows * 2;
    const history = await (mem.getFullHistory?.(sid, fetched) ?? mem.getHistory(sid, fetched));
    // 当前消息与归档用同一个 buildIncomingContent 拼，附件描述先等识别（有上限，超时照常判定）；
    // 两边仍可能不一致（识别超时、文件描述晚写入等），由运行期自检计数
    await waitForAttachmentDescriptions(message, caps.media, cfg.mediaWaitMs, logger);
    const pointerOnly = imagesPointerOnly(message);
    if (pointerOnly !== undefined) {
      recentImages.push(pointerOnly);
      if (recentImages.length > IMAGE_WINDOW) recentImages.shift();
    }
    // 取历史与等识别期间可能已熔断：熔断期不发请求
    if (circuitOpen()) return fallback('侧车熔断中');
    const cur = buildIncomingContent(message);
    // 字符串里的孤代理换成 U+FFFD：侧车的分词器不接受孤代理（整条回 422 bad_text 只能兜底，更早的侧车回 500，
    // 计入熔断）；历史行经库往返后本来也是 U+FFFD。自检记的仍是换之前的 cur，与归档事件带的原文同一口径
    const body = JSON.stringify(
      {
        rows: toRows(history, cfg.historyRows),
        cur,
        curUserId: message.userId,
        // 与历史行同一口径：昵称缺失时回落 userId（归档时的 name），训练导出同样如此
        curNick: str(message.nickname) ?? getMessageName(message.userId),
        replyTo: message.replyTo ? { userId: message.replyTo.userId, nickname: message.replyTo.nickname } : null,
        selfId,
        // 超过侧车上限的名字不发（截断后的名字会误换正文），超出个数的取前面的：别名在前，人设按服务解析顺序
        selfNames: names.filter(n => n.length <= MAX_SELF_NAME_LENGTH).slice(0, MAX_SELF_NAMES),
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
    // 侧车本身正常，不计失败，失败计数清零；这条没有经过推理，不算成功的判定，不清除判定不可用
    if (status === 422 || status === 413) {
      failures = 0;
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
      await archiveSwallowed(message, caps.messageArchive, logger, '[laya]');
      return; // swallow
    }

    const names = botNames(cfg.triggerNames, message);
    const addressed = isAddressed(message, names, cfg);

    const { threshold } = resolveEffectiveConfig(cfg, message.platform, message.sessionType, tid);
    const started = Date.now();
    // 到达序号：从进入本中间件到这里都是同步的，序号的先后即到达本相位的先后
    const settle = arrive(sid);
    let verdict: Verdict;
    try {
      verdict = await judge(message, addressed, names, threshold);
    } catch (err) {
      // 取历史失败等意外：本条兜底，不计侧车失败
      logger.warn(`[laya] 判定异常，本条按兜底只回点名: ${err}`);
      verdict = { speak: addressed, fallback: '判定异常' };
    }
    const superseded = settle(verdict.speak);
    // 判定日志：不含正文与昵称
    const detail =
      'fallback' in verdict
        ? `兜底=${verdict.fallback}`
        : `logit=${verdict.logit.toFixed(3)} | 阈值=${verdict.threshold} | 版本=${verdict.version}`;
    logger.debug(
      `[laya] 判定 | session=${sid} | speak=${verdict.speak} | addressed=${addressed} | ${detail} | ` +
        `耗时=${Date.now() - started}ms${superseded ? ' | 作废=同会话更晚到的消息已放行' : ''}`,
    );

    // 放行与吞掉都不等判定期间启动的附件识别（见 attachments.ts）
    if (!verdict.speak || superseded) {
      await archiveSwallowed(message, caps.messageArchive, logger, '[laya]');
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
        problems.length > 0
          ? [`${problems.join('；')}${active ? '，判定按兜底只回点名' : ''}`]
          : [`侧车在线（版本 ${'version' in health ? health.version : '?'}）`];
      // down 只由成功的判定清除（422 / 413 不算）：熔断已到期、memory 已回来，但还没有请求确认恢复（本插件
      // 不生效时一直如此）。探活正常不代表 /v1/score 正常，照实报成上次的故障
      const stale = down !== undefined && !circuitOpen() && caps.memory.current !== undefined;
      if (stale) parts.push(`上次判定不可用（${down}），尚未经请求确认恢复`);
      // 生效时近期带图消息大多只有图片指针：模型判定带图消息时不知道图里是什么
      const pointerOnlyCount = recentImages.filter(Boolean).length;
      const blind = active && pointerOnlyCount >= POINTER_ONLY_WARN;
      if (blind) {
        parts.push(
          `近 ${recentImages.length} 条带图消息有 ${pointerOnlyCount} 条判定时只有图片指针、没有内容描述：` +
            'media 未开启图片到达即识别（vision.recognizeOnArrival），或没有可用的识别模型',
        );
      }
      const role = active
        ? '生效中'
        : `未生效（${current ? `生效的触发插件是「${current.label}」` : '没有生效的触发插件'}）`;
      return {
        id: 'trigger.laya',
        category: 'service',
        // 生效时判定不了会让群里只回点名，报 error；未生效时不影响回复、上次的故障未经确认恢复、
        // 生效时带图消息判定看不到图片内容，报 warn
        level: problems.length > 0 ? (active ? 'error' : 'warn') : stale || blind ? 'warn' : 'ok',
        message: `Laya 触发判定${role}：${parts.join('；')}`,
        detail: `endpoint=${cfg.endpoint}`,
      };
    },
  });

  logger.info(
    `[laya] 已启用 (阈值=${cfg.threshold ?? '侧车'}, endpoint=${cfg.endpoint}, prio=${cfg.priority}, ` +
      `scopes=${cfg.scopes.join('|') || '<空>'}, overrides=${cfg.overrides.length})`,
  );
}
