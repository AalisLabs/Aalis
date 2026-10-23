/**
 * @aalis/api-approval — 审批契约
 *
 * 模型发起、需要批准的操作以审批对象的形式出现：发起方发起并等结算，审批对象推给在场的审批面，能批的人应答，结果回给
 * 发起方。审批只有一种，发起方给出这一张谁能批（canAnswer），另标出只有 owner 能批的那种（要 owner 确认的）。本包只有
 * 类型、服务描述符 `approvals` 与卡片清洗函数 `sanitizeForCard`、`clipForCard`；实现见 @aalis/plugin-session-server。
 *
 * 三类使用方：
 * - 发起方（执行守卫）：`request(req, signal)` 发起一个审批并等它结算，拒绝时结果里带着回给模型的话；
 * - 审批面（WebUI、终端、IM 私聊与群窗口）：经绑定门面 `registerSurface(name)` 登记，随激活撤回。每个客户端 `attend`
 *   一次，在场上报与应答都经它，审计里的审批面取登记身份，不取调用方自报。推给谁、算谁在场、认谁的应答是一条规则：
 *   客户端的身份能批这一张（canAnswer），且它的接入覆盖这张审批（{@link AttendScope}）；
 * - 展示方：`list()` 与 `approval:created`、`approval:settled` 事件。
 */

import { defineService } from '@aalis/core';
import type { TextRef } from '@aalis/schema-i18n';
import { t } from './texts.js';

// ════════════════════════════════════════════════════════════
// 发起
// ════════════════════════════════════════════════════════════

/**
 * 发起回合的类别，由发起方（第一方是 plugin-authority 的执行守卫）按这一轮从哪里来算出，不看会话类型与受众，也不判是不是
 * owner（不按授权身份算：owner 建的定时任务会把创建者回填成授权身份）：
 * - `hand`：人亲手发来的消息（不带来源，含群里没点名、被频率触发挑中的插话），不论在哪个会话、是不是 owner，以及它的续做；
 * - `subtask`：子任务回合；
 * - `autonomous`：定时任务、编排、空闲与主动发言、开话题、平台请求事件等其余注入与它们的续做，以及不在入站回合里的调用。
 *
 * 能不能产生审批由审批服务按类别与参与者判；不能的一律直接拒绝，不推给任何审批面。
 */
export type OriginKind = 'hand' | 'subtask' | 'autonomous';

/** 发起回合的类别与参与者 */
export interface ApprovalOrigin {
  kind: OriginKind;
  /** 这一轮的参与者（授权身份） */
  participants: { platform: string; userId: string }[];
}

/**
 * 发起一个审批：要执行的工具与它的参数（目前只有工具这一种目标）。canAnswer 与 ownerOnly 只在进程内交给提供者，不进推给
 * 审批面的审批对象
 */
export interface ApprovalRequest {
  sessionId: string;
  /** 发起它的回合；回合结束或中止时没结的审批按 cancelled 结算 */
  turnId?: string;
  /** 这次工具调用的 id，客户端据它把审批卡挂到工具卡上 */
  callId?: string;
  origin: ApprovalOrigin;
  tool: string;
  args: Record<string, unknown>;
  /** 命中的规则（如能力声明的确认要求、owner 的确认覆盖），记进审计 */
  rule: string;
  /** 这个人能不能批这一张：参与者审批是他自己就能做这个动作，要 owner 确认的是 owner */
  canAnswer: (who: ApprovalIdentity) => boolean;
  /** 只有 owner 能批的那种（要 owner 确认的，含与参与者审批合成的）：只给接入的覆盖用 */
  ownerOnly: boolean;
}

// ════════════════════════════════════════════════════════════
// 审批对象
// ════════════════════════════════════════════════════════════

/** pending 之后结算为其余四种之一：批准、拒绝或发起不被允许、没人应答（不在场、等满时限）、撤销 */
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

/** 结算之后的四种结局 */
export type SettledState = Exclude<ApprovalState, 'pending'>;

/**
 * 卡片上的事实，按工具定义上声明的展示种类（api-tools 的 `display`）从参数里取，各项逐字、与执行的参数一致：
 * - `command`、`cwd`：命令类工具声明的命令与工作目录；
 * - `diff`：改文件类工具声明的路径与删、加两侧的参数生成，删的行以 `-` 开头、加的行以 `+` 开头；
 * - `params`：其余参数，逐字。没声明展示种类的工具，全部参数都在这里。
 *
 * 显示之前一律经 {@link sanitizeForCard} 清洗，要截断的经 {@link clipForCard}。
 */
export interface ApprovalFacts {
  command?: string;
  cwd?: string;
  diff?: { path: string; patch: string };
  params: Record<string, unknown>;
}

export interface Approval {
  /** 由审批服务签发 */
  id: string;
  sessionId: string;
  turnId?: string;
  callId?: string;
  origin: ApprovalOrigin;
  target: 'tool';
  tool: string;
  facts: ApprovalFacts;
  /** 可选的应答；拒绝可以附说明 */
  options: Array<'approve' | 'deny'>;
  /** 请求内容（会话、回合、调用、工具与参数）的哈希，应答时原样带回 */
  contentHash: string;
  /** 到期的时刻（毫秒时间戳），是这张审批自己的事实：审批服务推出时按它的等待时限填，到时没人应答即按过期结算 */
  expiresAt: number;
  state: ApprovalState;
}

/**
 * 结算从哪里来：
 * - `answer`：能批的人应答（批准或拒绝）；
 * - `absent`：没人在场（发起时，或等待中在场的审批面都断开、变为不在场，且宽限内没有恢复）；
 * - `timeout`：等满时限；
 * - `ineligible`：发起回合的类别或参与者不能产生审批（不是人亲手发起的，或参与者里没有人能批）；
 * - `subtask`：子任务回合的审批不上浮；
 * - `rate-limit`：同一会话的审批超过频率上限；
 * - `turn-ended`：发起它的回合结束或中止；
 * - `shutdown`：审批服务停止。
 */
export type ApprovalSource =
  | 'answer'
  | 'absent'
  | 'timeout'
  | 'ineligible'
  | 'subtask'
  | 'rate-limit'
  | 'turn-ended'
  | 'shutdown';

/** 一个审批怎样结算的：结局、从哪里来、结算的时刻（毫秒时间戳），有人应答的带上应答人 */
export interface ApprovalSettlement {
  state: SettledState;
  source: ApprovalSource;
  at: number;
  by?: ApprovalIdentity;
}

/** 审批的结局。批准时 by 是批的人；拒绝时 message 是回给模型的话：写明被什么拦下、能不能再申请 */
export type ApprovalOutcome =
  | { approvalId: string; approved: true; by: ApprovalIdentity }
  | { approvalId: string; approved: false; source: ApprovalSource; message: string };

// ════════════════════════════════════════════════════════════
// 审批面
// ════════════════════════════════════════════════════════════

/** 审批面的客户端收到的推送 */
export interface ApprovalSink {
  /** 有审批要处理：在场时推出；变为在场时补推还没结的 */
  requested(approval: Approval): void;
  /** 推给过它的审批结算了 */
  settled(approvalId: string, settlement: ApprovalSettlement): void;
}

export interface ApprovalAnswer {
  approvalId: string;
  decision: 'approve' | 'deny';
  /** 原样带回审批对象的 contentHash */
  contentHash: string;
  note?: string;
}

/**
 * 应答被拒的原因：`forbidden` 应答人不能批这一张；`not-found` 不是本服务签发的 id，或还在等的审批不归这个接入覆盖；
 * `approval-settled` 已经结算（先答先得，后到的都是它，不论接入覆盖不覆盖它）；`hash-mismatch` 内容哈希对不上；
 * `unavailable` 审批服务不在
 */
export type ApprovalRefusal = 'forbidden' | 'not-found' | 'approval-settled' | 'hash-mismatch' | 'unavailable';

/** 应答的结果。被拒时 message 是给应答人看的原因，可以是文字对象（出口按读者语言渲染） */
export type ApprovalResponse = { ok: true } | { ok: false; refusal: ApprovalRefusal; message: string | TextRef };

/**
 * 审批面的一个客户端（WebUI 的一条连接、终端、owner 的一个 IM 身份经一个机器人账号、群窗口里的一个人）：在场上报与应答都记在
 * 它接入的审批面的登记身份名下
 */
export interface ApprovalAttendance {
  /**
   * 在场上报。true 表示刚有活动（WebUI 另要页面可见），最近一次这样的上报在时限内即算在场；推给它、还没结的审批也让它一直
   * 算在场。false 表示离开（页面转到后台、IM 私聊推不到），即刻不在场：推给它、还没结的审批对它算没收到，它变为在场时补推
   */
  presence(active: boolean): void;
  respond(answer: ApprovalAnswer): ApprovalResponse;
  /** 客户端断开 */
  leave(): void;
}

/** 审批面客户端经认证得出的身份：应答人就是它 */
export interface ApprovalIdentity {
  platform: string;
  userId: string;
}

/**
 * 接入的限定，两种：
 * - 群窗口（给 `window`，群窗口的根会话 id；根会话已经定了机器人账号，不再给 selfId）：只覆盖这个窗口发起的、不是只有 owner
 *   能批的审批。群窗口是公开的面，不发只有 owner 能批的；
 * - IM 私聊（不给 `window`）：只覆盖只有 owner 能批的、这一轮的参与者里有接入的身份、且所在会话的根会话的机器人账号
 *   （`originChat.selfId`）等于 `selfId` 的审批，两边都没有账号算相同
 */
export interface AttendScope {
  selfId?: string;
  window?: string;
}

/** 登记过的审批面 */
export interface ApprovalSurface {
  /** 登记名（webui、cli、chat） */
  readonly name: string;
  /**
   * 接入一个客户端。给了限定的只覆盖限定的那些审批（{@link AttendScope}：IM 私聊每个身份与机器人账号一份，群窗口每个窗口与
   * 发言者一份）：只因它们算在场、只收和只能应答它们；不给的覆盖全部，只给 owner 的面（WebUI 的连接、终端）：别的身份不限定地
   * 接入会收到各会话里它能批的审批，别人的接入一律限定群窗口。推给它、算它在场、认它的应答另要接入的身份能批这一张
   */
  attend(who: ApprovalIdentity, sink: ApprovalSink, scope?: AttendScope): ApprovalAttendance;
}

/** 提供者那一侧的审批面登记；登记撤回时 detach */
export interface SurfaceBinding {
  attend(who: ApprovalIdentity, sink: ApprovalSink, scope?: AttendScope): ApprovalAttendance;
  detach(): void;
}

// ════════════════════════════════════════════════════════════
// 服务
// ════════════════════════════════════════════════════════════

/** 提供者契约。审批面不直接在这里登记：经 {@link approvals} 的绑定门面登记，随激活撤回 */
export interface ApprovalService {
  /** 发起一个审批并等它结算。signal 是发起回合的中止信号，中止即按 cancelled 结算 */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>;
  /** 已推给审批面、还没结算的审批 */
  list(filter?: { sessionId?: string }): Approval[];
  /** 登记审批面；registrant 是登记方的插件实例，审计记在它名下 */
  attachSurface(name: string, registrant: string): SurfaceBinding;
}

/** `approvals` 的业务层：调用转发给选中的那一家，审批面登记自动归属这次激活 */
export interface BoundApprovals extends ApprovalService {
  /**
   * 登记审批面：同一激活同名再登记替换旧的；提供者换人自动重挂，随激活撤回。
   * 提供者不在场时接入的客户端照样拿到句柄：在场上报不生效，应答回 `unavailable`；提供者上线后下一次上报时接上
   */
  registerSurface(name: string): ApprovalSurface;
}

export const approvals = defineService<ApprovalService, BoundApprovals>('approvals', port => {
  interface Entry {
    name: string;
    binding?: SurfaceBinding;
  }
  const surfaces = port.registrar<Entry>({
    key: entry => entry.name,
    register: (service, entry) => {
      const binding = service.attachSurface(entry.name, port.id);
      entry.binding = binding;
      return () => {
        if (entry.binding === binding) entry.binding = undefined;
        binding.detach();
      };
    },
  });

  /** 客户端的句柄转到当前提供者的登记上；提供者换了，下一次调用时在新的登记上重新接入 */
  function attend(entry: Entry, who: ApprovalIdentity, sink: ApprovalSink, scope?: AttendScope): ApprovalAttendance {
    let left = false;
    let current: { binding: SurfaceBinding; attendance: ApprovalAttendance } | undefined;
    const bound = () => {
      const binding = entry.binding;
      if (left || !binding) return undefined;
      if (current?.binding !== binding) current = { binding, attendance: binding.attend(who, sink, scope) };
      return current.attendance;
    };
    bound();
    return {
      presence: active => bound()?.presence(active),
      respond: answer => bound()?.respond(answer) ?? { ok: false, refusal: 'unavailable', message: t('serviceAbsent') },
      leave() {
        left = true;
        current?.attendance.leave();
        current = undefined;
      },
    };
  }

  return Object.assign(Object.create(port.provider) as BoundApprovals, {
    registerSurface: (name: string): ApprovalSurface => {
      const entry: Entry = { name };
      surfaces.add(entry);
      return { name, attend: (who, sink, scope) => attend(entry, who, sink, scope) };
    },
  });
});

declare module '@aalis/core' {
  /** 审批事件（由审批服务的提供者发出） */
  interface AalisEvents {
    /** 一个审批推给了审批面 */
    'approval:created': [approval: Approval];
    /** 一个推给过审批面的审批结算了，state 是结局 */
    'approval:settled': [approval: Approval];
  }
}

// ════════════════════════════════════════════════════════════
// 卡片清洗
// ════════════════════════════════════════════════════════════

/** 控制符（C0、DEL、C1；ANSI 转义序列以 ESC 或 CSI 开头），换行与制表符除外 */
const CONTROL = /[\p{Cc}]/gu;
/** 看不见或会改变显示顺序的字符：格式符（双向控制、零宽字符、软连字符、标签字符等）、行与段分隔符、落单的代理项 */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

const hex = (char: string, width: number) => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(width, '0');

/**
 * 审批卡显示事实之前的清洗：控制符（含 ANSI 转义序列的 ESC）转义成 `\x1B` 的样子显示；双向控制符、零宽字符等
 * 看不见的字符换成 `⟨U+202E⟩` 的样子。换行与制表符保留。原文里的每个字符都显示出来，不隐藏、不改变顺序。
 */
export function sanitizeForCard(text: string): string {
  return text
    .replace(CONTROL, char => (char === '\n' || char === '\t' ? char : `\\x${hex(char, 2)}`))
    .replace(INVISIBLE, char => `⟨U+${hex(char, 4)}⟩`);
}

/** {@link clipForCard} 的结果：清洗过的开头与结尾，中间省略的字数（没有截断时为 0，整段在 head、tail 为空） */
export interface CardClip {
  head: string;
  omitted: number;
  tail: string;
}

/**
 * 清洗（同 {@link sanitizeForCard}）并截断：原文超过 limit 个字符时保留开头与结尾共 limit 个字符，交出两段与中间省略的
 * 字数，显示方在两段之间按读者语言写明省略了多少。截断按原文的字符算，不会切开转义或占位符。
 */
export function clipForCard(text: string, limit: number): CardClip {
  const chars = [...text];
  if (chars.length <= limit) return { head: sanitizeForCard(text), omitted: 0, tail: '' };
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return {
    head: sanitizeForCard(chars.slice(0, head).join('')),
    omitted: chars.length - limit,
    tail: sanitizeForCard(chars.slice(chars.length - tail).join('')),
  };
}
