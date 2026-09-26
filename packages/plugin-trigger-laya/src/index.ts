// ============================================================
// @aalis/plugin-trigger-laya — Laya 判定模型（trigger 服务的提供者）
//
// 经本机 HTTP 问 laya-listener 侧车"这条消息 Aalis 此刻该不该开口"，侧车返回 logit。
// 只登记提供者、不挂钩子：作用域、禁言、计数与开口后的类别、授权主体都归相位宿主
// plugin-trigger-policy。返回 null 即弃权，宿主转问下一个提供者（规则判定）：
// mode=off、影子模式、会话不适用、memory 缺席、请求体超限、侧车失败或熔断时都弃权。
// 另监听入站归档事件做运行期自检（self-check.ts）。
// ============================================================

import { extractTargetId, resolveEffectiveConfig } from '@aalis/api-gateway';
import { memory } from '@aalis/api-memory';
import { type TriggerProvider, trigger } from '@aalis/api-trigger';
import { type BoundOf, config, definePlugin, events, logger, optional, provide } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { buildIncomingContent, type Message } from '@aalis/schema-message';
import { defaultLayaConfig, resolveLayaConfig } from './config.js';
import { createSelfCheck } from './self-check.js';

// ----- 元数据 -----

const modeOptions = [
  { label: 'off (不判定)', value: 'off' },
  { label: 'shadow (影子：只记日志，交给规则判定)', value: 'shadow' },
  { label: 'live (按模型判定)', value: 'live' },
];

const configSchema: ConfigSchema = {
  mode: {
    type: 'select',
    label: '模式',
    default: defaultLayaConfig.mode,
    options: modeOptions,
    description:
      'shadow 时照常请求侧车并记一行 info 日志（不含正文与昵称），然后弃权，由后面的规则提供者判定；live 时由模型决定开不开口，被 @ 的消息也由模型判定。',
  },
  threshold: {
    type: 'number',
    label: '开口阈值',
    description: 'logit ≥ 阈值即开口。留空 = 用侧车返回的模型阈值（随模型版本给出）。',
  },
  endpoint: { type: 'string', label: '侧车地址', default: defaultLayaConfig.endpoint },
  timeoutMs: {
    type: 'number',
    label: '请求超时（毫秒）',
    default: defaultLayaConfig.timeoutMs,
    description: '超时计一次失败并弃权。应小于宿主 trigger-policy 的判定截止时间（decisionTimeoutMs）。',
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
    description: '规则提供者为 0 且不弃权，本提供者须排在它前面才会被问到。',
  },
  overrides: {
    type: 'array',
    label: '分作用域覆盖',
    description:
      '每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段，最具体者胜；字段留空 = 沿用上方设置。哪些会话会问到本提供者由 trigger-policy 的作用域决定。',
    default: [],
    items: {
      scope: {
        type: 'string',
        label: '作用域',
        description: '格式 platform:sessionType[:targetId]，支持 *',
        required: true,
      },
      mode: { type: 'select', label: '模式', options: modeOptions },
      threshold: { type: 'number', label: '开口阈值' },
    },
  },
};

// ----- 侧车请求 -----

/** 连续失败这么多次后熔断 */
const CIRCUIT_FAILURES = 3;
/** 熔断时长：期间直接弃权，不发请求 */
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
 * 其它平台与会话类型（频道等，模型未见过）返回 undefined，本提供者弃权。
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

// ----- 入口 -----

const uses = {
  logger,
  config,
  events,
  provide,
  // 缺席时弃权：没有历史窗口无从判定
  memory: optional(memory),
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
  let failures = 0;
  let openUntil = 0;

  /**
   * 计一次失败：连续第 3 次起熔断（到期后再失败即重新熔断）。一次故障只在由正常转为熔断时记 warn，
   * 之后的并发失败与重新熔断记 debug，恢复由 healthy() 记。返回 null 供调用处直接弃权
   */
  function fail(why: string): null {
    failures++;
    logger.debug(`[laya] 侧车请求失败: ${why}`);
    if (failures >= CIRCUIT_FAILURES) {
      openUntil = Date.now() + CIRCUIT_OPEN_MS;
      const line = `[laya] 侧车连续 ${failures} 次失败（最近一次: ${why}），熔断 ${CIRCUIT_OPEN_MS / 1000}s，期间弃权交给后面的提供者`;
      // 失败计数只在 healthy() 清零，恰好等于门限的那次就是这次故障的转入
      if (failures === CIRCUIT_FAILURES) logger.warn(line);
      else logger.debug(line);
    }
    return null;
  }

  /** 侧车正常作答（含 422、413）：失败计数清零，熔断过则记恢复 */
  function healthy(): void {
    if (failures >= CIRCUIT_FAILURES) logger.warn('[laya] 侧车恢复，熔断解除');
    failures = 0;
  }

  // 运行期自检：发请求前记下 cur，这条消息归档后与归档正文比对（归档事件带的 incoming 是拷贝，按键关联）
  const selfCheck = createSelfCheck(line => logger.info(line));
  caps.events.on('inbound:message:archived', ({ sessionId, incoming, archivedMessage }) =>
    selfCheck.settle(sessionId, incoming.messageId, archivedMessage.content ?? ''),
  );

  const provider: TriggerProvider = {
    async decide({ message, addressed, awaitAttachmentDescriptions }) {
      try {
        const e = resolveEffectiveConfig(cfg, message.platform, message.sessionType, extractTargetId(message));
        if (e.mode === 'off') return null;
        const selfId = parseSelfId(message.sessionId);
        if (!selfId) return null;
        const mem = caps.memory.current;
        if (!mem) return null;
        if (failures >= CIRCUIT_FAILURES && Date.now() < openUntil) return null;

        const sid = message.sessionId;
        // 窗口是最近 historyRows 条 user / assistant 行：多取一倍，过滤后再取，与侧车渲染回归的取法一致
        const fetched = cfg.historyRows * 2;
        const history = await (mem.getFullHistory?.(sid, fetched) ?? mem.getHistory(sid, fetched));
        // 当前消息与归档用同一个 buildIncomingContent 拼，附件描述先等宿主识别（有上限，超时照常判定）；
        // 两边仍可能不一致（识别超时、文件描述晚写入等），由运行期自检计数
        await awaitAttachmentDescriptions();
        const cur = buildIncomingContent(message);
        const body = JSON.stringify({
          rows: toRows(history, cfg.historyRows),
          cur,
          curUserId: message.userId,
          curNick: message.nickname,
          replyTo: message.replyTo ? { userId: message.replyTo.userId, nickname: message.replyTo.nickname } : null,
          selfId,
        });
        // 超过侧车上限直接弃权、不计失败：侧车不读体就回 413 并关连接，一部分请求在客户端表现为连接错误而非 413。
        // 不截断行来压体积：侧车的发言人编号与截断都基于完整窗口，改窗口会偏离训练口径
        const bytes = Buffer.byteLength(body);
        if (bytes > MAX_BODY_BYTES) {
          logger.debug(`[laya] 请求体 ${bytes} 字节超过侧车上限 ${MAX_BODY_BYTES}，弃权 | session=${sid}`);
          return null;
        }
        // 确实要发请求才记：off、在此之前弃权与超限的判定不参与自检
        selfCheck.record(message, cur);

        // 发请求并读完响应体，整体落在同一个超时窗口内（只限响应头的话，迟迟不发体的对端会绕过超时）
        const started = Date.now();
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
          return fail(controller.signal.aborted ? `超时（${cfg.timeoutMs}ms）` : `${err}`);
        } finally {
          clearTimeout(timer);
        }
        const elapsed = Date.now() - started;

        // 422：这条消息不适合交给模型（系统通知、空消息等）；413：请求体超限（发前已按上限判过，这里兜底）。
        // 侧车本身正常，不计失败
        if (status === 422 || status === 413) {
          healthy();
          return null;
        }
        if (status < 200 || status >= 300) return fail(`HTTP ${status}${errorCode(text)}`);
        let parsed: { logit?: unknown; threshold?: unknown; version?: unknown };
        try {
          parsed = JSON.parse(text);
        } catch {
          return fail('响应不是 JSON');
        }
        const logit = parsed.logit;
        const threshold = e.threshold ?? parsed.threshold;
        if (typeof logit !== 'number' || !Number.isFinite(logit)) return fail('响应的 logit 不是有限数');
        if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return fail('阈值不是有限数');
        healthy();

        const speak = logit >= threshold;
        const version = str(parsed.version) ?? '?';
        if (e.mode === 'shadow') {
          // 影子判定：不含正文与昵称
          logger.info(
            `[laya] 影子判定 | session=${sid} | logit=${logit.toFixed(3)} | 阈值=${threshold} | 会开口=${speak} | ` +
              `addressed=${addressed} | 耗时=${elapsed}ms | 版本=${version}`,
          );
          return null;
        }
        return { speak, reason: `Laya ${version} 阈值=${threshold}`, score: logit };
      } catch (err) {
        // 宿主也会把抛错按弃权处理，这里自己兜住，不依赖它
        logger.warn(`[laya] 判定异常，弃权: ${err}`);
        return null;
      }
    },
  };

  caps.provide(trigger, provider, { priority: cfg.priority, label: 'Laya 模型' });
  logger.info(
    `[laya] 已登记触发提供者 (模式=${cfg.mode}, 阈值=${cfg.threshold ?? '侧车'}, endpoint=${cfg.endpoint}, ` +
      `prio=${cfg.priority}, overrides=${cfg.overrides.length})`,
  );
}
