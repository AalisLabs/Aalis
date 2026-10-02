/**
 * @aalis/api-approval — 审批契约
 *
 * 模型发起、需要 owner 批准的操作以审批对象的形式出现：发起方发起并等结算，审批对象推给在场的审批面，
 * owner 应答，结果回给发起方。本包只有类型、服务描述符 `approvals` 与卡片清洗函数 `sanitizeForCard`；
 * 实现见 @aalis/plugin-session-server。
 *
 * 三类使用方：
 * - 发起方（执行守卫）：`request(req, signal)` 发起一个审批并等它结算，拒绝时结果里带着回给模型的话；
 * - 审批面（WebUI、终端）：经绑定门面 `registerSurface(name)` 登记，随激活撤回。每个客户端 `attend` 一次，
 *   在场上报与应答都经它，审计里的审批面取登记身份，不取调用方自报；
 * - 展示方：`list()` 与 `approval:created`、`approval:settled` 事件。
 */

import type { ServiceRef } from '@aalis/core';
import { defineService, serviceRef } from '@aalis/core';

// ════════════════════════════════════════════════════════════
// 发起
// ════════════════════════════════════════════════════════════

/**
 * 发起回合的类别，由发起方（第一方是 plugin-authority 的执行守卫）按回合的来源算出（不按授权身份算：owner 建的定时任务
 * 会把创建者回填成授权身份）：
 * - `owner`：owner 自己的会话里 owner 亲手发来的消息；
 * - `owner-chain`：同一 owner 会话里后台任务完成后的续做；
 * - `subtask`：子任务回合；
 * - `autonomous`：定时任务、定时触发、空闲与主动发言、开话题，以及它们触发的编排；
 * - `room`：群房间，以及对端不是 owner 的私聊，owner 在 WebUI 里驱动房间也算；
 * - `other`：群成员或其他用户发起。
 *
 * 只有 `owner` 与 `owner-chain` 能产生审批，其余一律直接拒绝，不推给任何审批面。
 */
export type OriginKind = 'owner' | 'owner-chain' | 'subtask' | 'autonomous' | 'room' | 'other';

/** 发起回合的直接主体与它的类别 */
export interface ApprovalOrigin {
  kind: OriginKind;
  platform: string;
  userId?: string;
}

/** 发起一个审批：要执行的工具与它的参数（目前只有工具这一种目标） */
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
}

// ════════════════════════════════════════════════════════════
// 审批对象
// ════════════════════════════════════════════════════════════

/** pending 之后结算为其余四种之一：owner 批准、owner 拒绝或发起不被允许、没人应答（不在场、等满时限）、撤销 */
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

/** 结算之后的四种结局 */
export type SettledState = Exclude<ApprovalState, 'pending'>;

/**
 * 卡片上的事实，只取参数里已有的，各项逐字、与执行的参数一致：
 * - `command`、`cwd`：参数里的命令与工作目录；
 * - `diff`：由 file_edit（oldText、newText）、file_write 与 file_append（content）的参数生成，删的行以 `-` 开头、加的行以 `+` 开头；
 *   路径或内容疑似含密钥时没有 `patch`，只给路径；
 * - `params`：其余参数，逐字。
 *
 * 显示之前一律经 {@link sanitizeForCard} 清洗。
 */
export interface ApprovalFacts {
  command?: string;
  cwd?: string;
  diff?: { path: string; patch?: string };
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
  state: ApprovalState;
}

/**
 * 结算从哪里来：
 * - `owner`：owner 应答（批准或拒绝）；
 * - `absent`：没人在场（发起时，或等待中在场的审批面都断开、变为不在场）；
 * - `timeout`：等满时限；
 * - `ineligible`：发起回合的类别不能产生审批；
 * - `subtask`：子任务回合的审批不上浮给 owner；
 * - `rate-limit`：同一会话的审批超过频率上限；
 * - `turn-ended`：发起它的回合结束或中止；
 * - `shutdown`：审批服务停止。
 */
export type ApprovalSource =
  | 'owner'
  | 'absent'
  | 'timeout'
  | 'ineligible'
  | 'subtask'
  | 'rate-limit'
  | 'turn-ended'
  | 'shutdown';

/** 审批的结局。拒绝时 message 是回给模型的话：写明被什么拦下、能不能再申请；发起类别为 room 的只有一句通用的拒绝 */
export type ApprovalOutcome =
  | { approvalId: string; approved: true }
  | { approvalId: string; approved: false; source: ApprovalSource; message: string };

// ════════════════════════════════════════════════════════════
// 审批面
// ════════════════════════════════════════════════════════════

/** 审批面的客户端收到的推送 */
export interface ApprovalSink {
  /** 有审批要处理：在场时推出；变为在场时补推还没结的 */
  requested(approval: Approval): void;
  /** 推给过它的审批结算了 */
  settled(approvalId: string, state: SettledState): void;
}

export interface ApprovalAnswer {
  approvalId: string;
  decision: 'approve' | 'deny';
  /** 原样带回审批对象的 contentHash */
  contentHash: string;
  note?: string;
}

/**
 * 应答被拒的原因：`forbidden` 应答人不是 owner；`not-found` 不是本服务签发的 id；`approval-settled` 已经结算
 * （先答先得，后到的都是它）；`hash-mismatch` 内容哈希对不上；`unavailable` 审批服务不在
 */
export type ApprovalRefusal = 'forbidden' | 'not-found' | 'approval-settled' | 'hash-mismatch' | 'unavailable';

export type ApprovalResponse = { ok: true } | { ok: false; refusal: ApprovalRefusal; message: string };

/** 审批面的一个客户端（WebUI 的一条连接、终端）：在场上报与应答都记在它接入的审批面的登记身份名下 */
export interface ApprovalAttendance {
  /**
   * 在场上报。true 表示刚有键盘或指针活动（WebUI 另要页面可见），最近一次这样的上报在时限内即算在场；
   * false 表示离开（页面转到后台），即刻不在场
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

/** 登记过的审批面 */
export interface ApprovalSurface {
  /** 登记名（webui、cli） */
  readonly name: string;
  /** 接入一个客户端 */
  attend(who: ApprovalIdentity, sink: ApprovalSink): ApprovalAttendance;
}

/** 提供者那一侧的审批面登记；登记撤回时 detach */
export interface SurfaceBinding {
  attend(who: ApprovalIdentity, sink: ApprovalSink): ApprovalAttendance;
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

/** `approvals` 的绑定接口：调用那一半是 ServiceRef，审批面登记自动归属这次激活 */
export interface BoundApprovals extends ServiceRef<ApprovalService> {
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
  function attend(entry: Entry, who: ApprovalIdentity, sink: ApprovalSink): ApprovalAttendance {
    let left = false;
    let current: { binding: SurfaceBinding; attendance: ApprovalAttendance } | undefined;
    const bound = () => {
      const binding = entry.binding;
      if (left || !binding) return undefined;
      if (current?.binding !== binding) current = { binding, attendance: binding.attend(who, sink) };
      return current.attendance;
    };
    bound();
    return {
      presence: active => bound()?.presence(active),
      respond: answer => bound()?.respond(answer) ?? { ok: false, refusal: 'unavailable', message: '审批服务不在' },
      leave() {
        left = true;
        current?.attendance.leave();
        current = undefined;
      },
    };
  }

  return serviceRef(port, {
    // 箭头函数：对象字面量方法带隐式 this，会被当成上下文敏感、让 E 改从返回类型推断
    registerSurface: (name: string): ApprovalSurface => {
      const entry: Entry = { name };
      surfaces.add(entry);
      return { name, attend: (who, sink) => attend(entry, who, sink) };
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

function clean(text: string): string {
  return text
    .replace(CONTROL, char => (char === '\n' || char === '\t' ? char : `\\x${hex(char, 2)}`))
    .replace(INVISIBLE, char => `⟨U+${hex(char, 4)}⟩`);
}

/**
 * 审批卡显示事实之前的清洗：控制符（含 ANSI 转义序列的 ESC）转义成 `\x1B` 的样子显示；双向控制符、零宽字符等
 * 看不见的字符换成 `⟨U+202E⟩` 的样子。换行与制表符保留。原文里的每个字符都显示出来，不隐藏、不改变顺序。
 * 给了 limit 且原文超过 limit 个字符时，保留开头与结尾共 limit 个字符，中间写明省略了多少；截断按原文的字符算，
 * 不会切开转义或占位符。
 */
export function sanitizeForCard(text: string, limit?: number): string {
  const chars = [...text];
  if (limit === undefined || chars.length <= limit) return clean(text);
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return `${clean(chars.slice(0, head).join(''))}…（省略 ${chars.length - limit} 字）…${clean(chars.slice(chars.length - tail).join(''))}`;
}
