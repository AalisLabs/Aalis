// ════════════════════════════════════════════════════════════
// 后台任务：可转后台的工具调用（RegisteredTool.background）在前台等满让出时限还没结束，就登记成后台任务、先回给模型。
// 做在执行器一层，所有声明了的工具一样。登记表即 backgroundTasks 服务：可查、可取输出、可停；变化发 background:changed，
// 状态变了写进插件数据。正常结束（含失败）时向起它的会话注入一条宿主通知，身份取起它的那次调用。
// ════════════════════════════════════════════════════════════

import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import {
  BACKGROUND_TASK_NOTICE,
  type BackgroundTask,
  type BackgroundTaskNoticeFacts,
  type BackgroundTaskOutput,
  type BackgroundTaskService,
  type BackgroundTaskStatus,
  integerIn,
  type ToolCallContext,
  type ToolDisplay,
  type ToolExecutionResult,
  toolFailed,
} from '@aalis/api-tools';
import type { Events, Logger } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { truncateChars } from '@aalis/util-text-normalize';

/** 让出时限的缺省（秒），工具可以声明自己的 */
export const DEFAULT_YIELD_SECONDS = 30;

interface BackgroundLimits {
  /** 前台最多等多少秒：模型给的 waitSeconds 与工具的让出时限都不超过它 */
  maxWaitSeconds: number;
  /** 同一会话里对话回合中同时在跑的可转后台调用数，前台与后台一起数 */
  maxPerSession: number;
}

/** 两项上限的缺省，插件配置的默认值取这里 */
export const DEFAULT_LIMITS: BackgroundLimits = { maxWaitSeconds: 600, maxPerSession: 4 };

/** 每次调用的输出缓冲只留末尾这么多字；一次调用推给界面的总量也不超过它 */
const OUTPUT_LIMIT = 64 * 1024;
/** 转后台时回给模型的已有输出的末尾 */
const YIELD_TAIL = 2000;
/** 找最后一行时只看输出的末尾这么多字 */
const LINE_SCAN = 1024;
/** 每个会话留最近多少条结束的 */
const MAX_ENDED_PER_SESSION = 20;
/** 停止后等落定的宽限：进程服务的中止契约在宽限后整组强制结束（2 秒），再留 1 秒收尾 */
const STOP_GRACE_MS = 3000;
/** 失败原因最多多少字 */
const REASON_MAX = 200;
const NOTICE_SOURCE_PREFIX = 'bg:';
const STORE_URI = 'pluginData:/tools/background-tasks.json';
const RESTART_REASON = 'Aalis 重启时还在跑';
const CLOSED_REASON = '工具注册表停用时还在跑';
const STATUSES: ReadonlySet<unknown> = new Set<BackgroundTaskStatus>([
  'running',
  'completed',
  'failed',
  'stopped',
  'aborted',
]);

/** 授权身份（同 ToolCallContext.actor） */
interface Identity {
  platform: string;
  userId: string;
}

/** 调用的有效授权身份，与 authority 守卫同一口径。没有 actor 也没有 userId 时 userId 为空串，即无主体 */
function identityOf(ctx: ToolCallContext): Identity {
  return ctx.actor ?? { platform: ctx.platform ?? '', userId: ctx.userId ?? '' };
}

const sameIdentity = (a: Identity, b: Identity) => a.platform === b.platform && a.userId === b.userId;

/** 对话回合里的调用：有 turnId 与 callId，转到后台后有可以通知的对话 */
export function inTurn(ctx: ToolCallContext): ctx is ToolCallContext & { turnId: string; callId: string } {
  return ctx.turnId !== undefined && ctx.callId !== undefined;
}

/** text 的末尾 n 字，不从代理对中间切开 */
function tailOf(text: string, n: number): string {
  if (text.length <= n) return text;
  const cut = text.length - n;
  const code = text.charCodeAt(cut);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut);
}

/** 用时：不到 1 秒、N 秒、M 分 S 秒、H 小时 M 分 */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return '不到 1 秒';
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

const iso = (at: number) => new Date(at).toISOString();

/** 给模型看的任务：时刻写成 ISO 字符串，不带参数与结果 */
export function viewOf(task: BackgroundTask): Record<string, unknown> {
  return {
    taskId: task.id,
    tool: task.label,
    status: task.status,
    startedAt: iso(task.startedAt),
    ...(task.endedAt !== undefined ? { endedAt: iso(task.endedAt) } : {}),
    ...(task.lastLine !== undefined ? { lastLine: task.lastLine } : {}),
    ...(task.lastOutputAt !== undefined ? { lastOutputAt: iso(task.lastOutputAt) } : {}),
    ...(task.reason !== undefined ? { reason: task.reason } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
  };
}

/** 一次调用的输出缓冲：只留末尾 OUTPUT_LIMIT 字，记至今的总字数、最后一行与最后输出的时刻 */
class OutputTail {
  /** 输出的末尾：超出两倍上限才整段收回，免得每次写都复制整块缓冲 */
  private kept = '';
  /** 还没收尾的那一行（末尾 LINE_SCAN 字） */
  private partial = '';
  /** 至今的输出总字数 */
  end = 0;
  lastLine?: string;
  lastAt?: number;

  get text(): string {
    return tailOf(this.kept, OUTPUT_LIMIT);
  }

  append(chunk: string, at: number): void {
    this.kept += chunk;
    if (this.kept.length > 2 * OUTPUT_LIMIT) this.kept = tailOf(this.kept, OUTPUT_LIMIT);
    this.end += chunk.length;
    this.lastAt = at;
    // 进度条用回车改写同一行：回车与换行都算行尾
    const lines = (this.partial + chunk).split(/[\r\n]/);
    this.partial = tailOf(lines.pop() ?? '', LINE_SCAN);
    const line = [...lines, this.partial]
      .map(segment => tailOf(segment, LINE_SCAN).trim())
      .filter(Boolean)
      .at(-1);
    if (line) this.lastLine = line;
  }

  since(after = 0): BackgroundTaskOutput {
    const text = this.text;
    const start = this.end - text.length;
    const from = Math.min(after, this.end);
    return { text: text.slice(Math.max(from - start, 0)), end: this.end, truncated: from < start };
  }
}

/** 可转后台的调用怎么等：前台最多等多少秒（已按上限收住），是否立即转后台 */
export interface Plan {
  waitSeconds: number;
  immediate: boolean;
}

/** 一次可转后台的调用：从占到位置到落定。转后台之后带上登记的任务 */
interface Call {
  readonly sessionId: string;
  /** 对话回合里的才占名额：不在回合里的不会转后台 */
  readonly inTurn: boolean;
  /** 工具的登记项：撤回登记时按它找到在跑的调用 */
  readonly owner: object;
  readonly plan: Plan;
  readonly controller: AbortController;
  readonly output: OutputTail;
  record?: TaskRecord;
  /** 被停止（stop）：落定时记为 stopped，不通知 */
  stopRequested?: boolean;
}

/** 结束通知送到哪个平台、调用者是谁、回复时引用哪条消息：起它那次调用上下文的快照；会话取任务的，身份取 starter */
interface NoticeTarget {
  platform: string;
  callerUserId?: string;
  replyTo?: string;
}

interface TaskRecord {
  task: BackgroundTask;
  /** 起它的那次调用的授权身份：后台任务工具只放行同一身份与 owner，结束通知按它的身份 */
  starter: Identity;
  output: OutputTail;
  /** 没有的不通知：由结束通知开的回合里转后台的，链只延续一层 */
  notice?: NoticeTarget;
  /** 在跑的才有 */
  call?: Call;
  /** 落定（结束或删除）时兑现 */
  ended: Promise<void>;
  markEnded: () => void;
}

/** 执行器跑一次可转后台的调用要的东西 */
interface RunSpec {
  /** 工具名，即任务的显示名 */
  tool: string;
  /** 模型给的参数（含执行器取出的两项），记进任务的 call */
  args: Record<string, unknown>;
  ctx: ToolCallContext;
  /** 结局按它取退出码 */
  display?: ToolDisplay;
  /** 带上这次调用的中止信号与输出口跑工具；不拒绝 */
  invoke(ctx: ToolCallContext): Promise<ToolExecutionResult>;
}

interface BackgroundTasksDeps {
  logger: Logger;
  /** 发 tool:output、background:changed 与结束通知 */
  events: Pick<Events, 'emit'>;
  limits: BackgroundLimits;
  /** owner 看得到、停得了别人起的任务；没有 authority 时恒为 false，只认同一身份 */
  isOwner: (identity: Identity) => boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalOf = <T>(value: unknown, type: 'string' | 'number'): T | undefined =>
  typeof value === type ? (value as T) : undefined;

/** 读回的一条：形状不对的没有 */
function parseStored(value: unknown): { task: BackgroundTask; starter: Identity } | undefined {
  if (!isRecord(value)) return undefined;
  const { id, sessionId, kind, label, call, status, startedAt, starter } = value;
  if (typeof id !== 'string' || typeof sessionId !== 'string' || kind !== 'tool-call' || typeof label !== 'string') {
    return undefined;
  }
  if (!STATUSES.has(status) || typeof startedAt !== 'number') return undefined;
  if (
    !isRecord(call) ||
    typeof call.tool !== 'string' ||
    !isRecord(call.args) ||
    typeof call.turnId !== 'string' ||
    typeof call.callId !== 'string'
  ) {
    return undefined;
  }
  if (!isRecord(starter) || typeof starter.platform !== 'string' || typeof starter.userId !== 'string') {
    return undefined;
  }
  const endedAt = optionalOf<number>(value.endedAt, 'number');
  const lastLine = optionalOf<string>(value.lastLine, 'string');
  const lastOutputAt = optionalOf<number>(value.lastOutputAt, 'number');
  const reason = optionalOf<string>(value.reason, 'string');
  const exitCode = Number.isInteger(value.exitCode) ? (value.exitCode as number) : undefined;
  return {
    task: {
      id,
      sessionId,
      kind,
      label,
      call: { tool: call.tool, args: call.args, turnId: call.turnId, callId: call.callId },
      status: status as BackgroundTaskStatus,
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(lastLine !== undefined ? { lastLine } : {}),
      ...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
    },
    starter: { platform: starter.platform, userId: starter.userId },
  };
}

/** 结果里的 error 写成一句原因；结果不是 JSON 对象或没有 error 时没有 */
function errorOf(content: string): string | undefined {
  try {
    const error: unknown = Reflect.get(JSON.parse(content) as object, 'error');
    if (error === undefined) return undefined;
    return truncateChars(typeof error === 'string' ? error : JSON.stringify(error), REASON_MAX, '…');
  } catch {
    return undefined;
  }
}

/** 等 promise 落定，最多等 ms，中止信号到达即返回 */
function within(promise: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
    void promise.then(done);
  });
}

/** 等调用落定，最多等 ms；中止信号到达后不再计时、只等落定：被中止的调用不转后台 */
function settleWithin<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<{ value: T } | undefined> {
  return new Promise(resolve => {
    const stopTimer = () => clearTimeout(timer);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stopTimer);
      resolve(undefined);
    }, ms);
    signal.addEventListener('abort', stopTimer, { once: true });
    void promise.then(value => {
      stopTimer();
      signal.removeEventListener('abort', stopTimer);
      resolve({ value });
    });
  });
}

/**
 * 后台任务登记与可转后台调用的运行。执行器（ToolRegistry）经它占位置、跑调用、撤回；四个后台任务工具经它查、取输出、
 * 等待与停止；插件把会话删除、停机、停用与存储接到它上面
 */
export class BackgroundTasks implements BackgroundTaskService {
  readonly limits: BackgroundLimits;
  private readonly logger: Logger;
  private readonly events: Pick<Events, 'emit'>;
  private readonly isOwner: (identity: Identity) => boolean;
  private readonly records = new Map<string, TaskRecord>();
  /** 占着位置的可转后台调用：从过守卫之前到落定 */
  private readonly calls = new Set<Call>();
  /** 本次运行的标识：任务 id 带上它，与读回的旧 id 不撞号 */
  private readonly runTag = crypto.randomUUID().slice(0, 6);
  private counter = 0;
  /** 读回成功之后才写盘；读不出来时本次运行只记在内存里，不覆盖原文件 */
  private storage?: StorageService;
  private writing: Promise<void> = Promise.resolve();
  /** 已排上、还没开始的一次写：之后的变化由它一并写入 */
  private writeQueued = false;
  /** 收到 app:stopping 之后：不再通知 */
  private shuttingDown = false;

  constructor(deps: BackgroundTasksDeps) {
    this.logger = deps.logger;
    this.events = deps.events;
    this.limits = deps.limits;
    this.isOwner = deps.isOwner;
  }

  // ---- 服务 ----

  list(filter?: { sessionId?: string }): BackgroundTask[] {
    return [...this.records.values()]
      .filter(record => filter?.sessionId === undefined || record.task.sessionId === filter.sessionId)
      .map(record => ({ ...record.task }));
  }

  output(id: string, after?: number): BackgroundTaskOutput | undefined {
    return this.records.get(id)?.output.since(after);
  }

  async stop(id: string): Promise<BackgroundTask | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    const call = record.call;
    if (call) {
      call.stopRequested = true;
      call.controller.abort();
      await within(record.ended, STOP_GRACE_MS);
    }
    return { ...record.task };
  }

  // ---- 后台任务工具 ----

  /** 本会话里调用者看得到的任务：同一授权身份起的，owner 看得到全部 */
  visible(ctx: ToolCallContext): BackgroundTask[] {
    const caller = identityOf(ctx);
    const owner = this.isOwner(caller);
    return [...this.records.values()]
      .filter(record => record.task.sessionId === ctx.sessionId && (owner || sameIdentity(record.starter, caller)))
      .map(record => ({ ...record.task }));
  }

  /** 等这些任务都落定，最多等 ms，中止信号到达即返回 */
  wait(ids: string[], ms: number, signal?: AbortSignal): Promise<void> {
    return within(Promise.all(ids.flatMap(id => this.records.get(id)?.ended ?? [])), ms, signal);
  }

  // ---- 执行器 ----

  /** 不可转后台的调用的输出口：有 turnId 与 callId 时转成 tool:output */
  outputFor(ctx: ToolCallContext): (text: string) => void {
    let sent = 0;
    return text => {
      this.stream(ctx, text, sent);
      sent += text.length;
    };
  }

  /**
   * 占一个位置。同一会话里对话回合中在跑的可转后台调用（前台与后台一起数，等审批的也算）满了时，回拒绝的结果（JSON），
   * 列出调用者看得到的在跑的任务，不执行、不过守卫。不在回合里的调用不会转后台，不占名额、不受上限挡
   */
  admit(ctx: ToolCallContext, owner: object, plan: Plan): Call | string {
    const counted = inTurn(ctx);
    const inSession = [...this.calls].filter(call => call.inTurn && call.sessionId === ctx.sessionId);
    if (counted && inSession.length >= this.limits.maxPerSession) {
      return JSON.stringify({
        error:
          `这个会话里已有 ${inSession.length} 个可转后台的工具调用在跑（上限 ${this.limits.maxPerSession}，前台与后台一起数），` +
          '先等待或停掉一个',
        running: this.visible(ctx)
          .filter(task => task.status === 'running')
          .map(viewOf),
      });
    }
    const call: Call = {
      sessionId: ctx.sessionId,
      inTurn: counted,
      owner,
      plan,
      controller: new AbortController(),
      output: new OutputTail(),
    };
    this.calls.add(call);
    return call;
  }

  /** 占了位置却没执行（守卫拒绝、回合已中止）：放回去 */
  release(call: Call): void {
    this.calls.delete(call);
  }

  /**
   * 跑一次占到位置、过了守卫的可转后台调用。让出时限从这里算起，前台时回合中止一并中止它。到时没结束或要求立即转后台：
   * 对话回合里的调用登记成后台任务、摘掉与回合的联动，先回给模型任务 id 与已有输出的末尾；不在对话回合里的（没有 turnId 或 callId，
   * 没有可通知的对话）中止并回报已有输出
   */
  async run(call: Call, spec: RunSpec): Promise<ToolExecutionResult> {
    const { ctx } = spec;
    const { signal } = call.controller;
    const onTurnAbort = () => call.controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener('abort', onTurnAbort, { once: true });
    const unlink = () => ctx.signal?.removeEventListener('abort', onTurnAbort);
    const startedAt = Date.now();
    const settled = spec.invoke({ ...ctx, signal, output: text => this.write(call, ctx, text) });
    void settled.then(() => this.calls.delete(call));
    const { waitSeconds, immediate } = call.plan;
    if (!immediate) {
      const finished = await settleWithin(settled, waitSeconds * 1000, signal);
      if (finished) {
        unlink();
        return finished.value;
      }
    }
    unlink();
    if (!inTurn(ctx)) {
      call.controller.abort();
      await within(settled, STOP_GRACE_MS);
      return this.yielded(call, {
        error: `${waitSeconds} 秒内没有结束，已中止；要多等就给 waitSeconds`,
      });
    }
    const record = this.register(call, spec, { turnId: ctx.turnId, callId: ctx.callId, startedAt });
    void settled.then(result => this.finish(record, result, spec.display));
    return this.yielded(call, {
      taskId: record.task.id,
      status: 'running',
      message: record.notice
        ? '已转到后台，结束时会通知你；不必等它，可以先回复。'
        : '已转到后台。这一轮由后台任务的结束通知开启，它结束时不再通知；用 background_wait 等它或用 background_output 查看。',
    });
  }

  /** 工具撤回登记（所属插件停用）：这个登记在跑的调用一并中止，后台的落成 aborted */
  withdraw(owner: object, name: string): void {
    this.abortWhere(call => call.owner === owner, `工具 ${name} 已撤回登记`);
  }

  // ---- 插件接线 ----

  /**
   * 读回插件数据里的登记：还在跑的落成 aborted（重启时还在跑），每个会话留最近的结束的，与读回之前起的任务并存，之后状态
   * 变了就写。文件不存在按没有记录起步；内容读不懂告警后同样起步，下次写盘时覆盖；读不出来（权限、存储不可用）告警，
   * 本次运行只记在内存里，不覆盖它
   */
  async restore(storage: StorageService): Promise<void> {
    let text: string | undefined;
    try {
      text = String(await storage.readFile(STORE_URI, 'utf8'));
    } catch (err) {
      if (!isStorageNotFound(err)) {
        this.logger.warn(`后台任务登记 ${STORE_URI} 读不出来，本次运行只记在内存里，不覆盖它:`, err);
        return;
      }
    }
    this.storage = storage;
    if (text !== undefined) this.adopt(text);
    this.persist();
  }

  /** 会话删除：停掉它的调用与任务、删掉登记，不通知 */
  deleteSession(sessionId: string): void {
    for (const call of this.calls) if (call.sessionId === sessionId) call.controller.abort();
    const records = [...this.records.values()].filter(record => record.task.sessionId === sessionId);
    if (records.length === 0) return;
    for (const record of records) this.remove(record);
    this.logger.info(`会话 ${sessionId} 已删除，删掉它的 ${records.length} 个后台任务`);
    this.persist();
  }

  /** 收到 app:stopping：此后结束的不通知 */
  shutdown(): void {
    this.shuttingDown = true;
  }

  /** 停用（收尾）：在跑的调用一并中止，后台的落成 aborted，等写盘落定 */
  async close(): Promise<void> {
    this.abortWhere(() => true, this.shuttingDown ? RESTART_REASON : CLOSED_REASON);
    await this.writing;
  }

  // ---- 内部 ----

  /**
   * 推给界面：有 turnId 与 callId 时转成 tool:output。sent 是这次调用此前写过的字数，推出的总量不超过 OUTPUT_LIMIT：
   * 界面按条目累加输出，前台最多要等 maxWaitSeconds，持续大量输出的命令不能把它撑满
   */
  private stream(ctx: ToolCallContext, text: string, sent: number): void {
    const room = OUTPUT_LIMIT - sent;
    if (room <= 0 || !inTurn(ctx)) return;
    const chunk = truncateChars(text, room);
    const { sessionId, turnId, callId } = ctx;
    if (chunk) void this.events.emit('tool:output', { sessionId, turnId, callId, text: chunk });
  }

  /** 可转后台的调用写输出：进缓冲；在前台时转成 tool:output，转后台之后更新任务的最后一行 */
  private write(call: Call, ctx: ToolCallContext, text: string): void {
    if (!text) return;
    const sent = call.output.end;
    call.output.append(text, Date.now());
    const record = call.record;
    if (!record) {
      this.stream(ctx, text, sent);
      return;
    }
    if (record.call !== call) return;
    record.task.lastLine = call.output.lastLine;
    record.task.lastOutputAt = call.output.lastAt;
    this.changed(record);
  }

  private yielded(call: Call, fields: Record<string, unknown>): ToolExecutionResult {
    const tail = tailOf(call.output.text, YIELD_TAIL);
    return { content: JSON.stringify({ ...fields, ...(tail ? { output: tail } : {}) }) };
  }

  private register(call: Call, spec: RunSpec, at: { turnId: string; callId: string; startedAt: number }): TaskRecord {
    const { ctx } = spec;
    let markEnded = () => {};
    const ended = new Promise<void>(resolve => {
      markEnded = resolve;
    });
    const chained = ctx.inbound?.source?.startsWith(NOTICE_SOURCE_PREFIX) === true;
    const { lastLine, lastAt } = call.output;
    const record: TaskRecord = {
      task: {
        id: `bg_${this.runTag}_${++this.counter}`,
        sessionId: ctx.sessionId,
        kind: 'tool-call',
        label: spec.tool,
        call: { tool: spec.tool, args: spec.args, turnId: at.turnId, callId: at.callId },
        status: 'running',
        startedAt: at.startedAt,
        ...(lastLine !== undefined ? { lastLine } : {}),
        ...(lastAt !== undefined ? { lastOutputAt: lastAt } : {}),
      },
      starter: identityOf(ctx),
      output: call.output,
      // 身份跟链源头：platform、actor 与 callerUserId 都取这次调用，通知回合的权限不高于它
      ...(chained
        ? {}
        : {
            notice: {
              platform: ctx.platform ?? 'unknown',
              ...(ctx.userId !== undefined ? { callerUserId: ctx.userId } : {}),
              ...(ctx.inbound?.messageId !== undefined ? { replyTo: ctx.inbound.messageId } : {}),
            },
          }),
      call,
      ended,
      markEnded,
    };
    call.record = record;
    this.records.set(record.task.id, record);
    this.logger.debug(`工具 ${spec.tool} 的调用转到后台: ${record.task.id}`);
    this.changed(record);
    this.persist();
    return record;
  }

  /**
   * 后台任务的调用落定：按结局落成 completed、failed 或 stopped，记下结果与命令的退出码；失败的原因只取结果里的 error。
   * 正常结束（含失败）的通知起它的会话
   */
  private finish(record: TaskRecord, result: ToolExecutionResult, display: ToolDisplay | undefined): void {
    const call = record.call;
    // 已经落成 aborted（撤回、停用）或随会话删掉的不再改
    if (!call || this.records.get(record.task.id) !== record) return;
    const exitCode =
      display?.kind === 'command' && display.result ? integerIn(result.content, display.result.exitCode) : undefined;
    const ending = { result, ...(exitCode !== undefined ? { exitCode } : {}) };
    if (call.stopRequested) {
      this.land(record, 'stopped', ending);
      return;
    }
    const status = toolFailed(result.content, exitCode) ? 'failed' : 'completed';
    const reason = status === 'failed' ? errorOf(result.content) : undefined;
    this.land(record, status, { ...ending, ...(reason !== undefined ? { reason } : {}) });
    if (record.notice && !this.shuttingDown) this.notify(record, status, record.notice);
  }

  private land(
    record: TaskRecord,
    status: BackgroundTaskStatus,
    fields: Pick<BackgroundTask, 'reason' | 'result' | 'exitCode'>,
  ): void {
    Object.assign(record.task, { status, endedAt: Date.now(), ...fields });
    record.call = undefined;
    record.markEnded();
    this.changed(record);
    this.prune(record.task.sessionId);
    this.persist();
  }

  private abortWhere(match: (call: Call) => boolean, reason: string): void {
    for (const call of this.calls) {
      if (!match(call)) continue;
      call.controller.abort();
      if (call.record?.call === call) this.land(call.record, 'aborted', { reason });
    }
  }

  private remove(record: TaskRecord): void {
    this.records.delete(record.task.id);
    record.markEnded();
    void this.events.emit('background:changed', { removed: record.task.id, sessionId: record.task.sessionId });
  }

  /** 每个会话留在跑的与最近 MAX_ENDED_PER_SESSION 条结束的 */
  private prune(sessionId: string): void {
    const ended = [...this.records.values()].filter(
      record => record.task.sessionId === sessionId && record.task.status !== 'running',
    );
    if (ended.length <= MAX_ENDED_PER_SESSION) return;
    ended.sort((a, b) => (a.task.endedAt ?? a.task.startedAt) - (b.task.endedAt ?? b.task.startedAt));
    for (const record of ended.slice(0, ended.length - MAX_ENDED_PER_SESSION)) this.remove(record);
  }

  private changed(record: TaskRecord): void {
    void this.events.emit('background:changed', { task: { ...record.task } });
  }

  /**
   * 结束通知只放宿主取得的事实：任务 id、工具名、结局与退出码、用时，正文写给模型，同样的事实另给界面。参数由模型写出
   * （可能受过注入），输出与结果受外部内容左右，都不进通知（通知以 system 呈现且会归档）；它们由模型用 background_output 取，
   * 以 tool 角色进上下文。只有正常结束（completed、failed）的通知
   */
  private notify(
    { task, starter }: TaskRecord,
    status: BackgroundTaskNoticeFacts['status'],
    target: NoticeTarget,
  ): void {
    const durationMs = (task.endedAt ?? task.startedAt) - task.startedAt;
    const { exitCode } = task;
    const ending =
      status === 'completed'
        ? '已完成'
        : exitCode !== undefined && exitCode !== 0
          ? `失败：退出码 ${exitCode}`
          : '失败';
    const facts: BackgroundTaskNoticeFacts = {
      tool: task.label,
      status,
      durationMs,
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
    const message: IncomingMessage = {
      content: `后台任务 ${task.id}（${task.label}）${ending}，用时 ${formatDuration(durationMs)}。结果与输出用 background_output 查看。`,
      sessionId: task.sessionId,
      platform: target.platform,
      source: `${NOTICE_SOURCE_PREFIX}${task.id}`,
      actor: starter,
      hostNotice: {
        kind: BACKGROUND_TASK_NOTICE,
        id: task.id,
        ...(target.callerUserId !== undefined ? { callerUserId: target.callerUserId } : {}),
        ...(target.replyTo !== undefined ? { replyTo: target.replyTo } : {}),
        facts,
      },
    };
    this.logger.info(`后台任务 ${task.id} 已结束，结束通知注入会话 ${task.sessionId}`);
    this.events.emit('inbound:message', message).catch(err => {
      this.logger.warn(
        `后台任务 ${task.id} 的结束通知注入失败，不重试: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** 并进读回的登记：读回之前起的任务照留，id 相同的以内存为准 */
  private adopt(text: string): void {
    let entries: unknown[];
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) throw new Error('顶层不是 { tasks: [...] }');
      entries = parsed.tasks;
    } catch (err) {
      this.logger.warn(`后台任务登记 ${STORE_URI} 读不懂，按没有记录起步，下次写盘时覆盖:`, err);
      return;
    }
    let dropped = 0;
    const sessions = new Set<string>();
    for (const entry of entries) {
      const stored = parseStored(entry);
      if (!stored || this.records.has(stored.task.id)) {
        dropped++;
        continue;
      }
      const { task } = stored;
      if (task.status === 'running') {
        Object.assign(task, {
          status: 'aborted',
          reason: RESTART_REASON,
          endedAt: task.lastOutputAt ?? task.startedAt,
        });
      }
      const record: TaskRecord = { ...stored, output: new OutputTail(), ended: Promise.resolve(), markEnded: () => {} };
      this.records.set(task.id, record);
      sessions.add(task.sessionId);
      this.changed(record);
    }
    if (dropped > 0) this.logger.warn(`后台任务登记 ${STORE_URI} 里有 ${dropped} 条读不懂，已丢掉`);
    for (const sessionId of sessions) this.prune(sessionId);
  }

  /** 写盘排队：整份写入，只记字段与起它的身份，不记输出与结果；已排上、还没开始的那次写会带上之后的变化 */
  private persist(): void {
    const storage = this.storage;
    if (!storage || this.writeQueued) return;
    this.writeQueued = true;
    this.writing = this.writing.then(async () => {
      this.writeQueued = false;
      const tasks = [...this.records.values()].map(({ task: { result: _result, ...fields }, starter }) => ({
        ...fields,
        starter,
      }));
      try {
        await storage.writeFile(STORE_URI, JSON.stringify({ tasks }));
      } catch (err) {
        this.logger.warn(`后台任务登记写入 ${STORE_URI} 失败，下次状态变了再写:`, err);
      }
    });
  }
}
