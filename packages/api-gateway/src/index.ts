// ----- Gateway 服务接口 -----
//
// Gateway 是 Aalis 的运行时编排中枢：
//   - 入站：监听 `inbound:message`，按 INBOUND_PHASE_ORDER 顺序运行
//           inbound:command → inbound:trigger → inbound:flow → inbound:dispatch
//           四个命名相位，dispatch 的默认动作是调用 agent.handleMessage。
//           dispatch 之前任一相位被 swallow（handler 不调用 next）即停止后续调度。
//   - 出站：提供 `dispatchOutbound()` 接口，运行 `outbound:dispatch` 钩子链，
//           默认动作是向 `outbound:message` 事件总线广播，平台插件接收并发送。
//
// core 不再绑定具体的路由实现，gateway 服务由 plugin-gateway 提供。
// 需要 gateway 的插件在 uses 里声明 `gateway` 描述符。core 无入站路由兜底：
// 不加载 gateway 则 `inbound:message` 无人消费、消息静默丢弃，按必需件对待。

import type { AgentService } from '@aalis/api-agent';
import type {} from '@aalis/api-hooks'; // declaration merging 锚点（下方 HookContextMap 增强）
import { resolveSessionType, type SessionTypeDecl } from '@aalis/api-platform';
import { defineService } from '@aalis/core';
import type { IncomingMessage, OutgoingMessage } from '@aalis/schema-message';

/**
 * 入站相位共享数据结构
 *
 * 同一条消息在 `inbound:command` → `inbound:trigger` → `inbound:flow` → `inbound:dispatch`
 * 四个相位间被同一对象引用传递。
 */
export interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  /** 当前可用的 agent 服务；plugin-gateway 在调度前已注入。 */
  agent: AgentService | undefined;
}

// ----- Gateway 域钩子声明 -----

declare module '@aalis/api-hooks' {
  interface HookContextMap {
    'inbound:command': InboundPhaseData;
    'inbound:flow': InboundPhaseData;
    'inbound:trigger': InboundPhaseData;
    'inbound:dispatch': InboundPhaseData;
    /**
     * Gateway 出站钩子链（洋葱模型）。
     * 由 `GatewayService.dispatchOutbound()` 发起。
     */
    'outbound:dispatch': {
      message: OutgoingMessage;
      metadata: Record<string, unknown>;
    };
  }
}

// ----- Gateway 域事件声明 -----

declare module '@aalis/core' {
  interface AalisEvents {
    /**
     * Gateway 某个入站相位执行完毕（无论是否被 swallow）。
     *
     * 遥测插件可订阅此事件以：
     *   - 记录每个相位耗时
     *   - 统计 swallow 率
     *   - 追踪消息在管道中的流转路径
     *
     * 对主流程零侵入：observer 的异常不会影响入站处理。
     */
    'gateway:phase:done': [
      data: {
        phase: string;
        /** true = 链走到底（未被 swallow）；false = 某 handler 未调用 next() 终止了链 */
        reachedEnd: boolean;
        durationMs: number;
        sessionId: string;
        platform: string;
      },
    ];
  }
}

/**
 * Gateway 服务 —— 消息流编排中枢
 *
 * 默认实现由 `@aalis/plugin-gateway` 提供。
 * 业务层不应再直接 `emit('outbound:message')`，而应调用 `dispatchOutbound()`，
 * 以便所有出站消息都经过 outbound:dispatch 钩子链（脱敏、限速、审计等）。
 */
export interface GatewayService {
  /**
   * 主动注入一条入站消息（用于 idle-trigger、webui 直发、内部自检等）。
   * 与直接 `emit('inbound:message')` 等价 —— 都会走 gateway 入站相位链。
   */
  ingressMessage(message: IncomingMessage): Promise<void>;

  /**
   * 派发一条出站消息。
   *
   * 替代 `events.emit('outbound:message', msg)` —— 后者将逐步迁移：
   *   - 平台适配器仍可监听 `outbound:message` 接收最终发送指令；
   *   - 发出方应改用本接口，以经过 `outbound:dispatch` 钩子链。
   */
  dispatchOutbound(message: OutgoingMessage): Promise<void>;
}

// ----- Gateway 入站生命周期相位 -----

/**
 * Gateway 入站消息生命周期相位（按下面的顺序串行执行）。
 *
 * 每个相位是一个独立的命名钩子键，对应一个职责清晰的拦截点。
 * 同一相位内部的多个 handler 按 **注册顺序** 执行洋葱模型 (next 语义)，
 * 跨相位则由 plugin-gateway 顺序调度，无需任何优先级数字。
 *
 *   COMMAND  → 指令解析与执行（由 plugin-commands 占据）。指令的意图确认也在这里：发出者对确认提示的回复
 *              命中即吞掉、不进入后续相位，从而**不触发 agent.handleMessage 对在途生成的 abort**
 *   TRIGGER  → 要不要开口：禁言关键词、点名识别与判定，结果写入 message.triggerType（由生效的触发插件
 *              占据，即 trigger 服务胜者，如 plugin-trigger-policy 的计数与评分）
 *   FLOW     → 节流硬闸：禁言期一律吞；回复后冷却与限速只挡非 immediate 触发，其中带 source 的
 *              内部注入不过冷却、仍受限速（由 plugin-flow-control 占据）
 *   DISPATCH → 默认派发到 agent.handleMessage（plugin-gateway 提供 default action）
 *
 * 任一相位的 handler 不调用 next() 即视为"我已处理"，
 * 整个入站管道立即停止（不再进入后续相位）。
 *
 * 第三方插件可以注册到任一相位以获得清晰的语义位置，
 * 无需理解优先级数字、无需与其他插件协商占位。
 *
 * @note 该常量原位于 @aalis/core，cleanup-7 后迁到此处——入站相位是 gateway 的概念，
 *       core 不应知晓。
 */
export const INBOUND_PHASE = {
  COMMAND: 'inbound:command',
  TRIGGER: 'inbound:trigger',
  FLOW: 'inbound:flow',
  DISPATCH: 'inbound:dispatch',
} as const;

/** 默认相位执行顺序（gateway 内部调度使用）。 */
export const INBOUND_PHASE_ORDER = [
  INBOUND_PHASE.COMMAND,
  INBOUND_PHASE.TRIGGER,
  INBOUND_PHASE.FLOW,
  INBOUND_PHASE.DISPATCH,
] as const;

export type InboundPhase = (typeof INBOUND_PHASE_ORDER)[number];

// ----- 会话作用域匹配 -----
//
// 按会话作用域生效的相位插件（flow-control / trigger-policy 等）共用的纯函数。
// 作用域字符串写作 `platform:sessionType[:targetId]`，每段可写 `*` 或省略（均为通配）。
// 插件配置约定两个字段：`scopes`（生效名单）与 `overrides`（分作用域覆盖，每项带 `scope`
// 与要覆盖的字段）；写一条 override 即视为启用该作用域。

interface ScopePattern {
  platform: string;
  sessionType: string;
  targetId: string;
}

function parseScope(scope: string): ScopePattern {
  const parts = (scope || '').split(':');
  return { platform: parts[0] || '*', sessionType: parts[1] || '*', targetId: parts[2] || '*' };
}

function matchScope(pat: ScopePattern, platform: string, sessionType: string, targetId: string): boolean {
  return (
    (pat.platform === '*' || pat.platform === platform) &&
    (pat.sessionType === '*' || pat.sessionType === sessionType) &&
    (pat.targetId === '*' || pat.targetId === targetId)
  );
}

/** 具体度：targetId > sessionType > platform > 通配 */
function scopeSpecificity(pat: ScopePattern): number {
  return (pat.platform !== '*' ? 4 : 0) + (pat.sessionType !== '*' ? 2 : 0) + (pat.targetId !== '*' ? 1 : 0);
}

/** 入站消息在作用域里的 targetId：群聊取 groupId，私聊取 userId，其他为空串。 */
export function extractTargetId(message: Pick<IncomingMessage, 'sessionType' | 'groupId' | 'userId'>): string {
  if (message.sessionType === 'group') return message.groupId ?? '';
  if (message.sessionType === 'private') return message.userId ?? '';
  return '';
}

/** 入站消息所在的聊天窗口：作用域 `平台:类型:目标` 的三段与多方标记 */
export interface ChatScope {
  platform: string;
  /** 平台类型名 */
  type: string;
  /** 多方为 true，一对一为 false；安全判断只认它，不认类型名 */
  multiParty: boolean;
  /** 消息带的类型名不在平台的声明里（已按多方处理），调用方据此告警 */
  undeclared: boolean;
  /** 目标：多方为窗口 id（群号），一对一为对端账号；消息上没有时为空串 */
  targetId: string;
}

/**
 * 入站消息所在的聊天窗口，types 是这个平台的类型（api-platform 的 sessionTypesOf）：平台取 message.platform，
 * 类型名与多方标记经 resolveSessionType，目标按多方标记取（多方取 groupId，一对一取 userId：OneBot 的临时会话在私聊消息上
 * 也带群号，所以按类型取，不按有没有 groupId 取）
 */
export function chatScopeOf(
  message: Pick<IncomingMessage, 'platform' | 'sessionType' | 'groupId' | 'userId'>,
  types: readonly SessionTypeDecl[],
): ChatScope {
  const { name, multiParty, undeclared } = resolveSessionType(types, message.sessionType);
  const targetId = (multiParty ? message.groupId : message.userId) ?? '';
  return { platform: message.platform, type: name, multiParty, undeclared, targetId };
}

/** 聊天窗口在作用域里的三段：平台、类型名、目标 */
type WindowParts = Pick<ChatScope, 'platform' | 'type' | 'targetId'>;

/** 键的前两段里的 `%` 与 `:` 按百分号转义：不合写法的名字（带 `:`）拼出来也不与别的窗口撞键 */
const escapeSegment = (segment: string) => segment.replace(/[%:]/g, char => (char === '%' ? '%25' : '%3A'));
const unescapeSegment = (segment: string) => segment.replace(/%25|%3A/g, code => (code === '%25' ? '%' : ':'));

/**
 * 聊天窗口的键 `平台:类型:目标`：场所的窗口键与作用域同一套写法。不含机器人账号，同一个群里几个账号的会话是同一个窗口。
 * 平台名与类型名按约定不含 `:`；适配器发出不合约定的名字时，前两段里的 `%` 与 `:` 转义成 `%25`、`%3A`，不同的窗口不会拼成
 * 同一个键。目标可以含 `:`（如频道的 `<guild>:<channel>`），原样放在最后
 */
export function windowKey({ platform, type, targetId }: WindowParts): string {
  return `${escapeSegment(platform)}:${escapeSegment(type)}:${targetId}`;
}

/** 拆开 {@link windowKey} 拼出的键：前两段还原转义，目标取第二个 `:` 之后的全部；不到三段时为 undefined */
export function parseWindowKey(key: string): WindowParts | undefined {
  const first = key.indexOf(':');
  const second = key.indexOf(':', first + 1);
  if (second < 0) return undefined;
  return {
    platform: unescapeSegment(key.slice(0, first)),
    type: unescapeSegment(key.slice(first + 1, second)),
    targetId: key.slice(second + 1),
  };
}

/** `(platform, sessionType, targetId)` 是否命中 `scopes` 或任一 `overrides[].scope`。 */
export function isScopeEnabled(
  cfg: { scopes: readonly string[]; overrides: readonly { scope: string }[] },
  platform: string | undefined,
  sessionType: string | undefined,
  targetId?: string,
): boolean {
  const p = platform ?? '';
  const t = sessionType ?? '';
  const tid = targetId ?? '';
  return (
    cfg.scopes.some(s => matchScope(parseScope(s), p, t, tid)) ||
    cfg.overrides.some(o => matchScope(parseScope(o.scope), p, t, tid))
  );
}

/**
 * 取 `overrides` 中命中且最具体的一项，按键叠加到 `base` 之上（跳过 `scope` 与值为 `undefined`
 * 的键）；无命中时原样返回 `base`。具体度相同时取先出现的一项。
 */
export function resolveEffectiveConfig<T extends { overrides: readonly { scope: string }[] }>(
  base: T,
  platform: string | undefined,
  sessionType: string | undefined,
  targetId?: string,
): T {
  if (base.overrides.length === 0) return base;
  const p = platform ?? '';
  const t = sessionType ?? '';
  const tid = targetId ?? '';
  let best: { scope: string } | undefined;
  let bestSpec = -1;
  for (const o of base.overrides) {
    const pat = parseScope(o.scope);
    if (!matchScope(pat, p, t, tid)) continue;
    const spec = scopeSpecificity(pat);
    if (spec > bestSpec) {
      best = o;
      bestSpec = spec;
    }
  }
  if (!best) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(best)) {
    if (k === 'scope' || v === undefined) continue;
    merged[k] = v;
  }
  return merged as T;
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const gateway = defineService<GatewayService>('gateway');
