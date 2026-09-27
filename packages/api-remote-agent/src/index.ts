// ============================================================
// @aalis/api-remote-agent — 远端代理契约
//
// 'remote-agent' 服务：把任务交给远端的长期编码代理（如 Cursor 云端代理）去做，跟踪每一轮到终态，
// 取回成品，按轮记账。多提供者：每个提供者插件实例是一个远端账号与模型的组合，provide 一个实例。
// 消费方（白纸枢纽）按配置里写的实例 id 用 resolveRemoteAgent 精确取，不用 current：偏好与优先级
// 决定的胜者不一定是配置点名的那个，取错提供者就是把任务交给了另一个账号、另一种出网方式。
//
// 远端账号的凭据只在提供者所在的宿主进程里用，不经这里的任何接口传出。
//
// 以后接自托管 worker 时，createAgent 会按次版本加「白纸执行环境」参数（可选字段，不破坏现有提供者），
// 形状等实测后定。
//
// 服务名：'remote-agent'
// ============================================================

import { defineService, type ServiceRef } from '@aalis/core';

// ----- 出网 -----

/** 远端代理的出网方式：不出网、只到白名单、不限；unknown = 提供者说不清 */
export type EgressMode = 'none' | 'allowlist' | 'open' | 'unknown';
/** 白纸允许的出网上限（上限不能写「未知」） */
export type EgressCeiling = Exclude<EgressMode, 'unknown'>;
export interface EgressReport {
  mode: EgressMode;
  /** provider-api：提供者从远端接口读到；owner-config：取自 owner 写的配置，Aalis 无法核实 */
  source: 'provider-api' | 'owner-config';
}

/** 出网从严到宽的次序；unknown 与 open 同级 */
const EGRESS_RANK: Record<EgressMode, number> = { none: 0, allowlist: 1, open: 2, unknown: 2 };

/**
 * 报告的出网方式是否不超过上限；unknown 按 open 算。来源不影响判定（owner-config 照 mode 判，
 * 是否核实由展示方标出）。认不出的 mode 或上限一律判为超过。
 */
export function egressWithin(report: EgressReport, ceiling: EgressCeiling): boolean {
  return EGRESS_RANK[report.mode] <= EGRESS_RANK[ceiling];
}

// ----- 工作区 -----

export interface WorkspaceLayout {
  /** 代理的工作目录（写进前言） */
  workDir: string;
  /** 交付目录；每件任务的成品放在 `${outDir}/<任务 id>/` */
  outDir: string;
  /** 每轮结束时的工程包路径 */
  bundlePath: string;
  /** 提供者特有的约束，逐条写进前言（如不改持久规则文件、不用订阅工具） */
  policyNotes: readonly string[];
}

// ----- 一轮 -----

export type RunStatus = 'creating' | 'running' | 'finished' | 'error' | 'cancelled' | 'expired';

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['finished', 'error', 'cancelled', 'expired']);

/** 这一轮是否已到终态（之后不会再变） */
export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export interface RunState {
  runId: string;
  status: RunStatus;
  /** 代理这一轮最后的文字说明 */
  resultText?: string;
}
/** progress 的 eventId 供断线后续传 */
export type RunProgress = { kind: 'progress'; eventId: string } | { kind: 'terminal'; state: RunState };
/** 一轮的实际费用；输入与缓存读取的 token 数供消费方判断上下文是否过长 */
export interface RunCost {
  chargedCents: number;
  inputTokens: number;
  cacheReadTokens: number;
}

// ----- 成品 -----

export interface ArtifactLimits {
  maxFileBytes: number;
  maxRunBytes: number;
  maxRunFiles: number;
  maxBundleBytes: number;
}
/**
 * 远端给的成品相对路径（去掉交付目录前缀之后）能否交给写入口；不能时返回原因。提供者与写入口都按它判定：
 * 写入口不只信提供者，自己再判一次。
 */
export function artifactRelProblem(rel: string): string | undefined {
  if (rel === '') return '路径为空';
  if (rel.startsWith('/')) return '绝对路径';
  if (rel.includes('\\')) return '路径含反斜杠';
  if (/[\p{Cc}\p{Cf}]/u.test(rel)) return '路径含控制字符或不可见的格式字符';
  const segments = rel.split('/');
  if (segments.includes('..')) return '路径含 .. 段';
  if (segments.some(s => s === '' || s === '.')) return '路径含空段或 . 段';
  return undefined;
}

/** 枢纽给的写入口：rel 由提供者去掉前缀后交来，写入口再做一次净化与上限检查，不合格就抛错 */
export interface ArtifactSink {
  putFile(rel: string, data: Uint8Array): Promise<void>;
  putBundle(data: Uint8Array): Promise<void>;
}
/** 取回了哪些文件由写入口自己记着，这里只报没有取回的 */
export interface CollectReport {
  /** 没有取回的文件与原因（路径不合格、超过上限、取不到下载链接等） */
  rejected: Array<{ path: string; reason: string }>;
}

// ----- 列举 -----

export interface RemoteAgentSummary {
  agentId: string;
  name: string;
}
export interface RemoteRunSummary {
  runId: string;
  status: RunStatus;
}

// ----- 错误 -----

/**
 * - unavailable：提供者不能用（鉴权失败、模型或参数不成立），message 写明原因
 * - busy：代理上已有一轮在跑
 * - archived：代理已归档，先 unarchiveAgent
 * - not-found：代理或这一轮不存在
 * - rate-limited：远端限流，retryAfterMs 给出要等多久
 * - rejected：远端拒绝这次请求，原样重试没有用
 * - transient：断线、超时、远端临时故障，可以重试
 */
export type RemoteAgentErrorCode =
  | 'unavailable'
  | 'busy'
  | 'archived'
  | 'not-found'
  | 'rate-limited'
  | 'rejected'
  | 'transient';

/**
 * 提供者方法按错误码抛它；消费方用 {@link isRemoteAgentError} 认，不用 instanceof。
 * message 与 cause 里不得带凭据或预签名链接的查询串。
 */
export class RemoteAgentError extends Error {
  override name = 'RemoteAgentError';
  readonly code: RemoteAgentErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: RemoteAgentErrorCode, message: string, options?: ErrorOptions & { retryAfterMs?: number }) {
    super(message, options);
    this.code = code;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * 是否为提供者抛出的 {@link RemoteAgentError}。只按 `name` 判定：进程里装有两份本包时，提供者抛出的是
 * 它解析到的那份类，消费方换一份做 instanceof 就不成立，按 name 两份都认得。
 */
export function isRemoteAgentError(err: unknown): err is RemoteAgentError {
  return (err as { name?: unknown } | null | undefined)?.name === 'RemoteAgentError';
}

// ----- 提供者 -----

/**
 * 远端代理提供者。方法失败时抛 {@link RemoteAgentError}（signal 中止引起的拒绝除外）。
 */
export interface RemoteAgentProvider {
  /** shared：同账号下的代理能互读对话；枢纽按 ready() 报告的 accountKey 限制使用它的白纸数 */
  readonly transcriptIsolation: 'shared' | 'per-agent';
  readonly layout: WorkspaceLayout;
  /**
   * 出网方式。取自 owner 配置的立即返回；要问远端接口或执行环境的（source 为 provider-api）按次读取，
   * 结果由提供者自己缓存。失败抛 {@link RemoteAgentError}，消费方按取不到处理（不当作放行）。
   */
  egress(signal: AbortSignal): Promise<EgressReport>;
  /**
   * 懒连接：鉴权与模型参数校验，失败抛 unavailable（带原因）。成功结果由提供者缓存，消费方可以频繁调用
   * （受理、出队、诊断都直接调它，不另设缓存）。
   * accountKey 是远端账号的不透明标识（哈希），同账号的实例返回同一个值；不含账号原文。
   */
  ready(signal: AbortSignal): Promise<{ accountKey: string }>;
  mintAgentId(): string;
  /** 同 agentId 重试是安全的；返回这一代理的首轮 runId */
  createAgent(req: { agentId: string; name: string; prompt: string }, signal: AbortSignal): Promise<{ runId: string }>;
  startRun(agentId: string, prompt: string, signal: AbortSignal): Promise<{ runId: string }>;
  /** 跟踪一轮直到终态；最后一项必为 terminal。断线、重连、410 回退都在提供者内部处理 */
  followRun(
    agentId: string,
    runId: string,
    opts: { lastEventId?: string; signal: AbortSignal },
  ): AsyncIterable<RunProgress>;
  getRun(agentId: string, runId: string, signal: AbortSignal): Promise<RunState>;
  /** 已到终态视为成功 */
  cancelRun(agentId: string, runId: string, signal: AbortSignal): Promise<void>;
  /** 这个代理的全部轮次；取不全时抛错，不返回部分结果（消费方的对账与开轮认领依赖列表完整） */
  listRuns(agentId: string, signal: AbortSignal): Promise<RemoteRunSummary[]>;
  /** undefined = 费用暂缺 */
  runCost(agentId: string, runId: string, signal: AbortSignal): Promise<RunCost | undefined>;
  collectArtifacts(
    agentId: string,
    taskId: string,
    sink: ArtifactSink,
    limits: ArtifactLimits,
    signal: AbortSignal,
  ): Promise<CollectReport>;
  /**
   * 旧代理工程包的位置，写进新代理的前言、由新代理自己取得：新代理能访问的链接（如临时下载链接），或新代理
   * 能读的路径（执行环境不出网时）。没有工程包返回 undefined
   */
  bundleLink(agentId: string, signal: AbortSignal): Promise<string | undefined>;
  archiveAgent(agentId: string, signal: AbortSignal): Promise<void>;
  unarchiveAgent(agentId: string, signal: AbortSignal): Promise<void>;
  /** 不存在视为成功 */
  deleteAgent(agentId: string, signal: AbortSignal): Promise<void>;
  /** 列出账号下的代理（提供者可按 owner 配置排除 owner 自管的代理）；取不全时抛错，不返回部分结果 */
  listAgents(signal: AbortSignal): Promise<RemoteAgentSummary[]>;
}

export const remoteAgent = defineService<RemoteAgentProvider>('remote-agent');

// ----- 按名取提供者 -----

/** 一个 'remote-agent' 提供者的快照（ServiceRef.all() 所返 ServiceView 的 instance/contextId/label 子集） */
export interface RemoteAgentEntry {
  instance: RemoteAgentProvider;
  contextId: string;
  label?: string;
}

/** 按提供者实例 id 精确取；不存在返回 undefined，不回落到别的提供者 */
export function resolveRemoteAgent(
  source: ServiceRef<RemoteAgentProvider>,
  type: string,
): RemoteAgentEntry | undefined {
  return source.all().find(e => e.contextId === type);
}
