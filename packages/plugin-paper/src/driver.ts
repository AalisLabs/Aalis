// ============================================================
// 运行驱动：每块白纸一把锁、一条队列，把任务交给远端代理跑到终态、取回成品、按轮记账
//
// - 队列：同一块白纸一件做完才开下一件，不同白纸并行。白纸停开、提供者实例有未读的账本外代理告警时不出队；
//   出队时再核对一次上限并重记预留。
// - 先落盘再调远端：建代理前账本里已有这个代理（creating）与开轮中的任务（starting，path=create）；已绑定
//   代理开轮前任务已是 starting（path=run）。startRun 不幂等：结果未知时（读超时、临时故障、重启接回）先列
//   轮次，账本外的恰好一轮就认领，没有就重发，多于一轮按自唤醒处理；第一次 POST 就 busy 时立即核查。
// - 等待上限：busy、transient、rate-limited 的等待每件任务合计不超过 10 分钟，超过就判失败、释放预留。
// - 单轮时长：每件运行中的任务一个计时器（开轮时刻加 maxRunMinutes），与事件流无关；到点取消，取消按
//   10、30、60 秒退避仍失败就停开白纸。
// - 终态后：核查账本外的轮次、取回成品（写入口见 artifacts.ts）、按实际费用入账（暂缺时 20 秒一次、共 3 次，
//   仍缺就停开白纸，预留按临时花费保留，定期检查时再补取）。任务到终态（含失败、清空时取消排队的）后交给
//   完成通知（notices.ts）。
// - 自唤醒事件（代理上出现账本外的轮次）：取消在跑的、费用记进全局日账、停开白纸、下一次新建代理不带旧工程包；
//   删除这个代理（不只归档：定时唤醒的订阅跟着代理走），它上面还有本白纸的任务时等任务取回成品后再删。
// - 换新：代理累计花费、上一轮上下文超过上限或 owner 点了换新时建新代理；新代理有一轮成功取回之前每轮都带
//   旧工程包链接，成功之后删除旧代理。
// - 定期检查（reconcileMinutes）：清理过期的任务记录、对账（账本里全部未删除的代理，跳过开轮中的；账号下
//   账本外的代理）、补取暂缺的费用、删除退役的代理、闲置归档、定期清空。
// - 重启接回在 apply 返回后进行（start）；收尾时停止出队并落盘账本（drain）。不订阅 memory:clear。
// ============================================================

import {
  isRemoteAgentError,
  isTerminalRun,
  type RemoteAgentEntry,
  type RemoteAgentProvider,
  type RemoteRunSummary,
  type RunCost,
  type RunState,
  resolveRemoteAgent,
} from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger, ServiceRef } from '@aalis/core';
import { openCollector, paperDirUri, type RunCollector } from './artifacts.js';
import { book, canStart, dayKey, release, reserveFor } from './budget.js';
import type { PaperConfig, PaperSpec } from './config.js';
import {
  type AlertRecord,
  type LedgerStore,
  type PaperState,
  randomHex,
  type TaskRecord,
  UNFINISHED_STATES,
} from './ledger.js';
import { buildPrompt } from './prompt.js';
import { actorKey } from './rooms.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
/** busy、transient、rate-limited 的等待，每件任务合计不超过这么久 */
const WAIT_CAP_MS = 10 * MINUTE;
/** 代理说自己忙、又没有账本外的轮次（本白纸上一轮还在收尾）时多久再试 */
const BUSY_RETRY_MS = 30 * SECOND;
/** 限流响应没给等待时长时等多久 */
const RATE_LIMIT_MS = 60 * SECOND;
const COST_ATTEMPTS = 3;
const COST_RETRY_MS = 20 * SECOND;
/** 到点取消失败后的重试间隔 */
const CANCEL_RETRY_MS = [10 * SECOND, 30 * SECOND, 60 * SECOND];
/** 进展的 lastEventId 至少这么久落盘一次 */
const PROGRESS_SAVE_MS = 30 * SECOND;
const RESULT_TEXT_MAX = 2000;
/** 占着代理的任务状态（排队的不占） */
const ON_AGENT: ReadonlySet<TaskRecord['state']> = new Set(['starting', 'running', 'collecting']);

/** 退避：5 秒起翻倍，封顶 60 秒 */
function backoff(attempt: number): number {
  return Math.min(5 * SECOND * 2 ** attempt, 60 * SECOND);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 这件任务等远端的时间用完了：判为失败 */
class GaveUp extends Error {}

/** 一件任务在 busy、transient、rate-limited 上已经等过多久 */
interface Waits {
  spent: number;
}

/** next：接着看这块白纸的下一件；pause：白纸停下等 owner 或告警处理；idle：没有可做的 */
type Outcome = 'next' | 'pause' | 'idle';

interface DriverDeps {
  remote: ServiceRef<RemoteAgentProvider>;
  sessionManager: ServiceRef<SessionManagerService>;
  storage: StorageService;
  ledger: LedgerStore;
  cfg: PaperConfig;
  logger: Logger;
  /** 激活的取消信号：停机、停用时中止一切远端调用与等待 */
  signal: AbortSignal;
  now: () => number;
  /** 有任务到了终态（账本已落盘）：交给完成通知 */
  ended: () => void;
}

export class PaperDriver {
  readonly #d: DriverDeps;
  /** 各白纸的运行循环 */
  readonly #loops = new Map<string, Promise<void>>();
  /** 循环在跑时又被踢了一下：这一轮结束后再跑一轮 */
  readonly #rekick = new Set<string>();
  /** 白纸锁：出队并跑完一件任务、闲置归档互斥 */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  /** 定期检查与到点取消这些不属于任何循环的后台活，收尾时一起等 */
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #reaping = new Set<string>();
  /** 本次运行里确认删除的代理：列账号下的代理时迟到的旧结果不算账本外 */
  readonly #forgotten = new Set<string>();
  #interval?: ReturnType<typeof setInterval>;
  #reconciling = false;
  #draining = false;

  constructor(deps: DriverDeps) {
    this.#d = deps;
  }

  /** 接回进行中的任务并开始定期检查；账本读取失败时什么都不做（远端任务一律不开） */
  start(): void {
    const { signal, ledger, cfg } = this.#d;
    if (ledger.failure || signal.aborted) return;
    this.#interval = setInterval(() => this.#track(this.#reconcile()), cfg.reconcileMinutes * MINUTE);
    signal.addEventListener('abort', () => this.#stopTimers(), { once: true });
    for (const paperId of this.#papersWithWork()) this.kick(paperId);
  }

  /** 这块白纸有新任务或状态变了：没在跑就开一个运行循环 */
  kick(paperId: string): void {
    if (this.#closed() || this.#d.ledger.failure) return;
    if (this.#loops.has(paperId)) {
      this.#rekick.add(paperId);
      return;
    }
    const loop = this.#loop(paperId)
      .catch(err => this.#d.logger.error(`白纸 ${paperId} 的运行循环出错，下次触发时接着跑: ${describe(err)}`))
      .finally(() => {
        this.#loops.delete(paperId);
        if (this.#rekick.delete(paperId)) this.kick(paperId);
      });
    this.#loops.set(paperId, loop);
  }

  /** 收尾：停止出队与定期检查，等在途的活按中止信号退出，落盘账本 */
  async drain(): Promise<void> {
    this.#draining = true;
    this.#stopTimers();
    await Promise.allSettled([...this.#loops.values(), ...this.#inflight]);
    const { ledger, logger } = this.#d;
    if (!ledger.failure) await ledger.save().catch(err => logger.error(`白纸账本落盘失败: ${describe(err)}`));
    await ledger.flush();
  }

  // ----- owner 的管理动作（WebUI 白纸页调用）-----

  /** 恢复一块停开的白纸；它没停开时返回 false */
  async resume(paperId: string): Promise<boolean> {
    const { ledger } = this.#d;
    const resumed = await ledger.exclusive(async () => {
      const paper = ledger.data.papers[paperId];
      if (!paper?.halted) return false;
      delete paper.halted;
      await ledger.save();
      return true;
    });
    if (resumed) {
      this.#d.logger.info(`白纸 ${paperId} 已由 owner 恢复`);
      this.kick(paperId);
    }
    return resumed;
  }

  /** 下一件任务建新代理 */
  async rotate(paperId: string): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      this.#paper(paperId).rotateNext = true;
      await ledger.save();
    });
  }

  /** 清空：取消排队的任务，删除这块白纸的代理与白纸目录；有任务在跑时拒绝并返回原因 */
  clear(paperId: string): Promise<string | undefined> {
    return this.#clear(paperId, false);
  }

  /** 标为已读；账本外代理的告警标为已读后，用这个提供者实例的白纸解除停开 */
  async acknowledge(alertId: string): Promise<boolean> {
    const { ledger } = this.#d;
    const found = await ledger.exclusive(async () => {
      const alert = ledger.data.alerts.find(a => a.id === alertId);
      if (!alert || alert.acknowledged) return false;
      alert.acknowledged = true;
      await ledger.save();
      return true;
    });
    if (found) for (const paperId of this.#papersWithWork()) this.kick(paperId);
    return found;
  }

  // ----- 运行循环 -----

  async #loop(paperId: string): Promise<void> {
    while (!this.#closed()) {
      this.#rekick.delete(paperId);
      const outcome = await this.#locked(paperId, () => this.#step(paperId));
      if (outcome !== 'next') return;
    }
  }

  /** 白纸锁：前一段结束才进入 */
  #locked<T>(paperId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.#locks.get(paperId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.#locks.set(paperId, tail);
    void tail.then(() => {
      if (this.#locks.get(paperId) === tail) this.#locks.delete(paperId);
    });
    return run;
  }

  async #step(paperId: string): Promise<Outcome> {
    const tasks = Object.values(this.#d.ledger.data.tasks)
      .filter(t => t.paperId === paperId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const task = tasks.find(t => ON_AGENT.has(t.state)) ?? tasks.find(t => t.state === 'queued');
    if (!task) return 'idle';
    const waits: Waits = { spent: 0 };
    try {
      return await this.#advance(task, waits);
    } catch (err) {
      if (this.#d.signal.aborted) return 'idle';
      if (err instanceof GaveUp) return this.#fail(task, '远端忙或不可用');
      throw err;
    }
  }

  async #advance(task: TaskRecord, waits: Waits): Promise<Outcome> {
    if (task.state === 'queued') {
      const held = await this.#dequeue(task, waits);
      if (held) return held;
    } else if (task.state === 'starting') {
      const held = await this.#resumeStart(task, waits);
      if (held) return held;
    }
    const final = task.state === 'running' ? await this.#follow(task) : undefined;
    if (task.state === 'running' || task.state === 'collecting') return this.#finish(task, final, waits);
    return 'next';
  }

  /** 出队：通过各项核对后开轮；返回 undefined 表示已开轮（任务转 running） */
  async #dequeue(task: TaskRecord, waits: Waits): Promise<Outcome | undefined> {
    const { ledger, cfg } = this.#d;
    const paper = this.#paper(task.paperId);
    if (paper.halted) return 'pause';
    const spec = this.#spec(task.paperId);
    if (!spec?.remoteAgentType) return this.#fail(task, '这块白纸已不在配置里，或没有配置远端代理类型');
    const type = spec.remoteAgentType;
    if (ledger.data.alerts.some(a => a.kind === 'unknown-agent' && !a.acknowledged && a.providerType === type)) {
      return 'pause';
    }

    // 出队时预算可能已变：去掉本件原来的预留再判，通过就按现在的均值重记
    const refused = await ledger.exclusive(async () => {
      if (task.state !== 'queued') return 'moved';
      const room = this.#d.sessionManager.require().resolveConfig(task.room, task.platform);
      const day = dayKey(this.#d.now(), cfg.budgetTimeZone);
      const user = actorKey(task.initiator);
      const held = ledger.data.reserves[task.id];
      delete ledger.data.reserves[task.id];
      const cents = reserveFor(ledger.data, task.paperId, cfg.reserveDefaultCents);
      const limits = {
        globalCents: cfg.globalDailyCents,
        roomCents: room.remoteAgentRoomDailyCents,
        userCents: room.remoteAgentUserDailyCents,
        // 按人件数是受理时的上限，本件受理时已计入
        userTasks: undefined,
      };
      const verdict = canStart(ledger.data, day, task.room, user, limits, cents);
      if (!verdict.ok) {
        if (held) ledger.data.reserves[task.id] = held;
        return verdict.reason;
      }
      ledger.data.reserves[task.id] = { cents, day, room: task.room, user };
      await ledger.save();
      return undefined;
    });
    if (refused === 'moved') return 'next';
    if (refused) return this.#fail(task, refused);

    const entry = await this.#provider(type, waits);
    try {
      await this.#retrying(waits, () => entry.instance.ready(this.#d.signal));
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      const detail = `远端代理「${type}」不可用：${describe(err)}`;
      await this.#haltPaper(task.paperId, 'provider', detail, { kind: 'provider', providerType: type });
      return 'pause';
    }

    const bound = paper.binding ? ledger.data.agents[paper.binding] : undefined;
    const rotate =
      !bound ||
      paper.rotateNext ||
      paper.noBundleNext ||
      bound.providerType !== type ||
      bound.costCents > spec.rotateAfterCents ||
      (bound.lastContextTokens ?? 0) > spec.rotateAfterInputTokens;
    if (rotate) return this.#createPath(task, entry, paper.binding, waits);
    return this.#runPath(task, entry, paper.binding ?? '', waits);
  }

  /** 新建代理：代理与开轮中的任务先落盘，再建 */
  async #createPath(
    task: TaskRecord,
    entry: RemoteAgentEntry,
    old: string | undefined,
    waits: Waits,
  ): Promise<Outcome | undefined> {
    const { ledger } = this.#d;
    const paper = this.#paper(task.paperId);
    const agentId = await this.#retrying(waits, async () => entry.instance.mintAgentId());
    const replaces = paper.noBundleNext ? undefined : old;
    const written = await ledger.exclusive(async () => {
      if (task.state !== 'queued' || paper.halted || paper.binding !== old) return false;
      const now = this.#d.now();
      ledger.data.agents[agentId] = {
        providerType: entry.contextId,
        paperId: task.paperId,
        name: `aalis-paper-${randomHex(4)}`,
        state: 'creating',
        createdAt: now,
        costCents: 0,
        ...(replaces ? { replaces } : {}),
      };
      task.state = 'starting';
      task.agentId = agentId;
      task.start = { path: 'create', requestedAt: now };
      await ledger.save();
      return true;
    });
    if (!written) return 'next';
    return this.#create(task, entry, waits);
  }

  /** 建代理（同一 agentId 重试是安全的：提供者按 id 取回已建的） */
  async #create(task: TaskRecord, entry: RemoteAgentEntry, waits: Waits): Promise<Outcome | undefined> {
    const agentId = task.agentId ?? '';
    const agent = this.#d.ledger.data.agents[agentId];
    if (!agent) return this.#fail(task, '账本里找不到开轮中的代理');
    try {
      const prompt = await this.#prompt(task, entry, agent.replaces, waits);
      const { runId } = await this.#retrying(waits, () =>
        entry.instance.createAgent({ agentId, name: agent.name, prompt }, this.#d.signal),
      );
      await this.#started(task, runId, this.#d.now());
      return undefined;
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      return this.#fail(task, `建远端代理失败：${describe(err)}`);
    }
  }

  /** 已绑定代理：已归档的先取消归档，核查一次账本外的轮次，开轮中的任务落盘后开轮 */
  async #runPath(
    task: TaskRecord,
    entry: RemoteAgentEntry,
    agentId: string,
    waits: Waits,
  ): Promise<Outcome | undefined> {
    const { ledger } = this.#d;
    try {
      if (ledger.data.agents[agentId]?.state === 'archived') await this.#unarchive(entry, agentId, waits);
      const unknown = await this.#retrying(waits, () => this.#unknownRuns(entry, agentId));
      if (unknown.length > 0) {
        await this.#selfWake(agentId, unknown);
        return 'pause';
      }
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      if (isRemoteAgentError(err) && err.code === 'not-found') {
        await this.#forget(agentId, '远端已找不到这个代理');
        return 'next';
      }
      return this.#fail(task, `远端代理出错：${describe(err)}`);
    }
    const paper = this.#paper(task.paperId);
    const written = await ledger.exclusive(async () => {
      if (task.state !== 'queued' || paper.halted || paper.binding !== agentId) return false;
      task.state = 'starting';
      task.agentId = agentId;
      task.start = { path: 'run', requestedAt: this.#d.now() };
      await ledger.save();
      return true;
    });
    if (!written) return 'next';
    return this.#postRun(task, entry, waits, false);
  }

  /** 重启接回开轮中的任务：新建代理按同一 agentId 重建，已绑定代理先认领 */
  async #resumeStart(task: TaskRecord, waits: Waits): Promise<Outcome | undefined> {
    const agent = task.agentId ? this.#d.ledger.data.agents[task.agentId] : undefined;
    if (!agent) return this.#fail(task, '账本里找不到开轮中的代理');
    const entry = await this.#provider(agent.providerType, waits);
    if (task.start?.path === 'create') return this.#create(task, entry, waits);
    return this.#postRun(task, entry, waits, true);
  }

  /**
   * 在已绑定的代理上开一轮。startRun 不幂等：结果未知（resumed 或临时故障）时先列轮次认领；
   * busy 时核查是不是账本外的轮次在跑。
   */
  async #postRun(
    task: TaskRecord,
    entry: RemoteAgentEntry,
    waits: Waits,
    resumed: boolean,
  ): Promise<Outcome | undefined> {
    const agentId = task.agentId ?? '';
    let check: 'claim' | 'busy' | undefined = resumed ? 'claim' : undefined;
    let unarchive = false;
    let delay = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        if (unarchive) {
          await this.#unarchive(entry, agentId, waits);
          unarchive = false;
        }
        if (check) {
          const unknown = await this.#retrying(waits, () => this.#unknownRuns(entry, agentId));
          if (check === 'claim' && unknown.length === 1) {
            this.#d.logger.info(`白纸任务 ${task.id} 认领远端轮次 ${unknown[0].runId}`);
            await this.#started(task, unknown[0].runId, task.start?.requestedAt ?? this.#d.now());
            return undefined;
          }
          if (unknown.length > 0) {
            await this.#requeue(task);
            await this.#selfWake(agentId, unknown);
            return 'pause';
          }
          // busy 却没有账本外的轮次：是本白纸上一轮还在收尾
          if (check === 'busy') delay = BUSY_RETRY_MS;
          check = undefined;
        }
        if (delay > 0) {
          await this.#wait(waits, delay);
          delay = 0;
        }
        const replaces = this.#d.ledger.data.agents[agentId]?.replaces;
        const prompt = await this.#prompt(task, entry, replaces, waits);
        const { runId } = await entry.instance.startRun(agentId, prompt, this.#d.signal);
        await this.#started(task, runId, this.#d.now());
        return undefined;
      } catch (err) {
        if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
        const remote = isRemoteAgentError(err) ? err : undefined;
        const code = remote?.code ?? 'transient';
        if (code === 'rate-limited') delay = remote?.retryAfterMs ?? RATE_LIMIT_MS;
        else if (code === 'busy') check = 'busy';
        else if (code === 'archived') unarchive = true;
        else if (code === 'not-found') {
          await this.#forget(agentId, '远端已找不到这个代理');
          return 'next';
        } else if (code === 'unavailable' || code === 'rejected') {
          return this.#fail(task, `远端拒绝开轮：${describe(err)}`);
        } else {
          check = 'claim';
          delay = backoff(attempt);
        }
      }
    }
  }

  async #unarchive(entry: RemoteAgentEntry, agentId: string, waits: Waits): Promise<void> {
    const { ledger } = this.#d;
    await this.#retrying(waits, () => entry.instance.unarchiveAgent(agentId, this.#d.signal));
    await ledger.exclusive(async () => {
      const agent = ledger.data.agents[agentId];
      if (agent?.state !== 'archived') return;
      agent.state = 'active';
      await ledger.save();
    });
  }

  /** 前言；新代理在第一轮成功取回之前带旧代理的工程包链接 */
  async #prompt(task: TaskRecord, entry: RemoteAgentEntry, replaces: string | undefined, waits: Waits) {
    const bundleUrl = replaces ? await this.#bundleUrl(replaces, waits) : undefined;
    return buildPrompt({ layout: entry.instance.layout, taskId: task.id, text: task.text, bundleUrl });
  }

  async #bundleUrl(agentId: string, waits: Waits): Promise<string | undefined> {
    const old = this.#d.ledger.data.agents[agentId];
    const entry = old && resolveRemoteAgent(this.#d.remote, old.providerType);
    if (!entry) return undefined;
    try {
      return await this.#retrying(waits, () => entry.instance.bundleLink(agentId, this.#d.signal));
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      this.#d.logger.warn(`取旧代理 ${agentId} 的工程包链接失败，新代理这一轮从空工作区开始: ${describe(err)}`);
      return undefined;
    }
  }

  /** 拿到 runId：记进轮次表，任务转 running；新建的代理转为绑定，原来绑定的退役 */
  async #started(task: TaskRecord, runId: string, startedAt: number): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      const agentId = task.agentId ?? '';
      ledger.data.runs[runId] = { agentId, taskId: task.id, cost: { state: 'pending' } };
      task.state = 'running';
      task.runId = runId;
      task.startedAt = startedAt;
      delete task.start;
      delete task.lastEventId;
      const agent = ledger.data.agents[agentId];
      if (agent?.state === 'creating') {
        const paper = this.#paper(task.paperId);
        const old = paper.binding;
        agent.state = 'active';
        paper.binding = agentId;
        const retired = old && old !== agentId ? ledger.data.agents[old] : undefined;
        if (retired) retired.state = 'retired';
        delete paper.rotateNext;
        delete paper.noBundleNext;
      }
      await ledger.save();
    });
    this.#d.logger.info(`白纸任务 ${task.id} 开轮（代理 ${task.agentId}，轮次 ${runId}）`);
  }

  async #requeue(task: TaskRecord): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      if (task.state !== 'starting') return;
      task.state = 'queued';
      delete task.start;
      delete task.agentId;
      await ledger.save();
    });
  }

  /** 跟踪一轮直到终态；断线等由提供者处理，这里只在提供者放弃或不在场时退避重连 */
  async #follow(task: TaskRecord): Promise<RunState> {
    const { ledger, logger, signal } = this.#d;
    const agentId = task.agentId ?? '';
    const runId = task.runId ?? '';
    const providerType = ledger.data.agents[agentId]?.providerType ?? '';
    this.#armDeadline(task);
    let savedAt = this.#d.now();
    for (let attempt = 0; ; attempt++) {
      const entry = resolveRemoteAgent(this.#d.remote, providerType);
      if (entry) {
        try {
          const events = entry.instance.followRun(agentId, runId, { lastEventId: task.lastEventId, signal });
          for await (const event of events) {
            if (event.kind === 'terminal') return event.state;
            task.lastEventId = event.eventId;
            attempt = 0;
            if (this.#d.now() - savedAt >= PROGRESS_SAVE_MS) {
              savedAt = this.#d.now();
              await ledger.save().catch(err => logger.warn(`白纸账本落盘失败（进展）: ${describe(err)}`));
            }
          }
          const state = await entry.instance.getRun(agentId, runId, signal);
          if (isTerminalRun(state.status)) return state;
        } catch (err) {
          if (signal.aborted) throw err;
          if (isRemoteAgentError(err) && err.code === 'not-found') return { runId, status: 'error' };
          logger.warn(`跟踪白纸任务 ${task.id} 的轮次 ${runId} 出错，稍后重连: ${describe(err)}`);
        }
      } else {
        logger.warn(`远端代理「${providerType}」不在场，稍后再跟踪白纸任务 ${task.id}`);
      }
      await sleep(backoff(attempt), signal);
    }
  }

  /** 单轮时长上限：从持久化的开轮时刻起算，与事件流无关 */
  #armDeadline(task: TaskRecord): void {
    if (this.#deadlines.has(task.id) || task.startedAt === undefined) return;
    const due = task.startedAt + this.#d.cfg.maxRunMinutes * MINUTE - this.#d.now();
    const timer = setTimeout(
      () => {
        this.#deadlines.delete(task.id);
        this.#track(this.#timeout(task));
      },
      Math.max(0, due),
    );
    this.#deadlines.set(task.id, timer);
  }

  #clearDeadline(taskId: string): void {
    clearTimeout(this.#deadlines.get(taskId));
    this.#deadlines.delete(taskId);
  }

  async #timeout(task: TaskRecord): Promise<void> {
    const { ledger, logger, signal, cfg } = this.#d;
    const runId = task.runId;
    const agentId = task.agentId ?? '';
    const providerType = ledger.data.agents[agentId]?.providerType ?? '';
    logger.warn(`白纸任务 ${task.id} 到了单轮时长上限（${cfg.maxRunMinutes} 分钟），取消这一轮`);
    for (let i = 0; i <= CANCEL_RETRY_MS.length; i++) {
      if (i > 0) await sleep(CANCEL_RETRY_MS[i - 1], signal);
      if (task.state !== 'running' || task.runId !== runId) return;
      // 先记下取消来源：远端可能在取消请求返回之前就交出终态
      const via = task.cancelledVia;
      task.cancelledVia ??= 'timeout';
      try {
        const entry = resolveRemoteAgent(this.#d.remote, providerType);
        if (!entry) throw new Error(`远端代理「${providerType}」不在场`);
        await entry.instance.cancelRun(agentId, runId ?? '', signal);
        return;
      } catch (err) {
        if (task.state === 'running') task.cancelledVia = via;
        if (signal.aborted) return;
        logger.warn(`取消白纸任务 ${task.id} 超时的轮次失败: ${describe(err)}`);
      }
    }
    await this.#haltPaper(task.paperId, 'cancel-failed', `白纸任务 ${task.id} 超时的轮次 ${runId} 取消不了`, {
      kind: 'cancel-failed',
      subject: agentId,
      providerType,
    });
  }

  /** 终态后：核查账本外的轮次、取回成品、入账，任务到终态 */
  async #finish(task: TaskRecord, final: RunState | undefined, waits: Waits): Promise<Outcome> {
    const { ledger, logger, signal } = this.#d;
    this.#clearDeadline(task.id);
    const agentId = task.agentId ?? '';
    const runId = task.runId ?? '';
    if (task.state === 'running') {
      await ledger.exclusive(async () => {
        task.state = 'collecting';
        await ledger.save();
      });
    }
    const entry = await this.#provider(ledger.data.agents[agentId]?.providerType ?? '', waits);
    const state = final ?? (await this.#terminalState(entry, agentId, runId, waits));

    try {
      const unknown = await this.#retrying(waits, () => this.#unknownRuns(entry, agentId));
      if (unknown.length > 0) await this.#selfWake(agentId, unknown);
    } catch (err) {
      if (signal.aborted || err instanceof GaveUp) throw err;
      logger.warn(`终态后核查代理 ${agentId} 的轮次失败，留给定期对账: ${describe(err)}`);
    }

    const collected = await this.#collect(task, entry, waits);
    await this.#settleCost(runId, entry, true);

    const outcome: TaskRecord['state'] =
      state.status === 'cancelled' ? 'cancelled' : state.status === 'finished' && !collected.error ? 'done' : 'failed';
    await ledger.exclusive(async () => {
      task.state = outcome;
      if (outcome !== 'cancelled') delete task.cancelledVia;
      if (outcome === 'failed') {
        task.error = collected.error ?? (state.status === 'expired' ? '远端这一轮已过期' : '远端这一轮出错或已不存在');
      }
      task.endedAt = this.#d.now();
      if (state.resultText) task.resultText = truncate(state.resultText, RESULT_TEXT_MAX);
      task.artifacts = collected.artifacts;
      if (collected.bundle) task.bundle = collected.bundle;
      const agent = ledger.data.agents[agentId];
      if (agent) {
        agent.lastRunEndedAt = task.endedAt;
        // 新代理这一轮成功取回：不再需要旧代理的工程包
        if (outcome === 'done') delete agent.replaces;
      }
      await ledger.save();
    });
    logger.info(`白纸任务 ${task.id} 结束：${outcome}，成品 ${collected.artifacts.length} 件`);
    this.#d.ended();
    await this.#reap();
    return 'next';
  }

  async #terminalState(entry: RemoteAgentEntry, agentId: string, runId: string, waits: Waits): Promise<RunState> {
    try {
      const state = await this.#retrying(waits, () => entry.instance.getRun(agentId, runId, this.#d.signal));
      return isTerminalRun(state.status) ? state : { ...state, status: 'error' };
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      return { runId, status: 'error' };
    }
  }

  /** 取回本件成品；失败的整次重来（先清掉半截），等不下去就按失败记 */
  async #collect(
    task: TaskRecord,
    entry: RemoteAgentEntry,
    waits: Waits,
  ): Promise<{ artifacts: TaskRecord['artifacts']; bundle?: { sizeBytes: number }; error?: string }> {
    const { ledger, logger, signal, storage, cfg } = this.#d;
    const takenIds = new Set(Object.values(ledger.data.tasks).flatMap(t => t.artifacts.map(a => a.id)));
    for (let attempt = 0; ; attempt++) {
      let collector: RunCollector;
      try {
        collector = await openCollector({
          storage,
          paperId: task.paperId,
          taskId: task.id,
          caps: cfg.artifacts,
          takenIds,
        });
        const report = await entry.instance.collectArtifacts(
          task.agentId ?? '',
          task.id,
          collector,
          cfg.artifacts,
          signal,
        );
        for (const r of report.rejected) logger.warn(`白纸任务 ${task.id} 的成品 ${r.path} 被拒收：${r.reason}`);
      } catch (err) {
        if (signal.aborted) throw err;
        const remote = isRemoteAgentError(err) ? err : undefined;
        const retryable = !remote || remote.code === 'transient' || remote.code === 'rate-limited';
        const ms = remote?.code === 'rate-limited' ? (remote.retryAfterMs ?? RATE_LIMIT_MS) : backoff(attempt);
        if (retryable && waits.spent + ms <= WAIT_CAP_MS) {
          logger.warn(`取回白纸任务 ${task.id} 的成品失败，稍后整次重来: ${describe(err)}`);
          await this.#wait(waits, ms);
          continue;
        }
        return { artifacts: [], error: `取回成品失败：${describe(err)}` };
      }
      if (collector.full) {
        const detail = `白纸目录超过总占用上限 ${cfg.artifacts.maxPaperBytes} 字节，任务 ${task.id} 余下的成品已拒收`;
        await this.#haltPaper(task.paperId, 'storage-full', detail, { kind: 'storage-full' });
      }
      return { artifacts: collector.artifacts, bundle: collector.bundle };
    }
  }

  /** 按实际费用入账；暂缺时 20 秒一次、共 3 次，仍缺就停开白纸（预留保留） */
  async #settleCost(runId: string, entry: RemoteAgentEntry, latest: boolean): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    const run = ledger.data.runs[runId];
    if (!run || run.cost.state === 'booked') return;
    for (let i = 0; i < COST_ATTEMPTS; i++) {
      if (i > 0) await sleep(COST_RETRY_MS, signal);
      let cost: RunCost | undefined;
      try {
        cost = await entry.instance.runCost(run.agentId, runId, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        logger.warn(`取轮次 ${runId} 的费用失败: ${describe(err)}`);
      }
      if (cost) {
        await this.#book(runId, cost, latest);
        return;
      }
    }
    const agent = ledger.data.agents[run.agentId];
    const detail = `轮次 ${runId} 的费用取不到，预留按临时花费保留；在 WebUI 核实后恢复`;
    await ledger.exclusive(async () => {
      run.cost = { state: 'missing' };
      if (agent) this.#halt(agent.paperId, 'cost-missing', detail);
      this.#alert({ kind: 'cost-missing', subject: runId, providerType: agent?.providerType, message: detail });
      await ledger.save();
    });
    logger.warn(detail);
  }

  async #book(runId: string, cost: RunCost, latest: boolean): Promise<void> {
    const { ledger, cfg } = this.#d;
    await ledger.exclusive(async () => {
      const run = ledger.data.runs[runId];
      if (!run || run.cost.state === 'booked') return;
      book(ledger.data, dayKey(this.#d.now(), cfg.budgetTimeZone), runId, cost.chargedCents);
      if (run.taskId) release(ledger.data, run.taskId);
      const agent = ledger.data.agents[run.agentId];
      if (agent && latest) agent.lastContextTokens = cost.inputTokens + cost.cacheReadTokens;
      await ledger.save();
    });
  }

  /**
   * 自唤醒事件：代理上出现账本外的轮次。停开白纸、下一次新建代理不带旧工程包，取消在跑的账本外轮次、
   * 费用记进全局日账，删除代理（它上面还有本白纸的任务时由那件任务结束后的清理删除）。
   */
  async #selfWake(agentId: string, unknown: RemoteRunSummary[]): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    const agent = ledger.data.agents[agentId];
    if (!agent) return;
    const detail = `代理 ${agent.name}（${agentId}）上出现账本外的轮次 ${unknown.map(r => r.runId).join('、')}，按自唤醒处理：取消并删除代理，下一次新建代理不带旧工程包`;
    await ledger.exclusive(async () => {
      for (const r of unknown) ledger.data.runs[r.runId] ??= { agentId, cost: { state: 'pending' } };
      agent.state = 'retired';
      delete agent.replaces;
      for (const other of Object.values(ledger.data.agents)) if (other.replaces === agentId) delete other.replaces;
      const paper = this.#paper(agent.paperId);
      if (paper.binding === agentId) delete paper.binding;
      paper.noBundleNext = true;
      this.#halt(agent.paperId, 'unknown-run', detail);
      this.#alert({ kind: 'unknown-run', subject: agentId, providerType: agent.providerType, message: detail });
      await ledger.save();
    });
    logger.warn(`白纸 ${agent.paperId} 停开：${detail}`);
    const entry = resolveRemoteAgent(this.#d.remote, agent.providerType);
    if (entry) {
      for (const r of unknown) {
        if (isTerminalRun(r.status)) continue;
        try {
          await entry.instance.cancelRun(agentId, r.runId, signal);
        } catch (err) {
          if (signal.aborted) throw err;
          await this.#alertOnce({
            kind: 'cancel-failed',
            subject: agentId,
            providerType: agent.providerType,
            message: `账本外的轮次 ${r.runId} 取消不了（删除代理时一并终止）：${describe(err)}`,
          });
        }
      }
      for (const r of unknown) await this.#settleCost(r.runId, entry, false);
    }
    await this.#reap();
  }

  /** 删除退役的代理：上面没有未结束的任务、也不再是别的代理的工程包来源；失败的留给下次对账 */
  async #reap(): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    for (const [agentId, agent] of Object.entries(ledger.data.agents)) {
      if (agent.state !== 'retired' || this.#reaping.has(agentId)) continue;
      if (Object.values(ledger.data.tasks).some(t => t.agentId === agentId && ON_AGENT.has(t.state))) continue;
      if (Object.values(ledger.data.agents).some(a => a.replaces === agentId)) continue;
      const entry = resolveRemoteAgent(this.#d.remote, agent.providerType);
      if (!entry) continue;
      this.#reaping.add(agentId);
      try {
        await entry.instance.deleteAgent(agentId, signal);
        await this.#forget(agentId);
        logger.info(`已删除远端代理 ${agent.name}（${agentId}）`);
      } catch (err) {
        if (signal.aborted) throw err;
        await this.#alertOnce({
          kind: 'delete-failed',
          subject: agentId,
          providerType: agent.providerType,
          message: `删除远端代理 ${agent.name}（${agentId}）失败，下次对账重试：${describe(err)}`,
        });
      } finally {
        this.#reaping.delete(agentId);
      }
    }
  }

  /** 代理已确认不存在：连同它的轮次记录一起从账本移除，绑定与引用一并清掉，开轮中的任务回到队列 */
  async #forget(agentId: string, why?: string): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      delete ledger.data.agents[agentId];
      for (const [runId, run] of Object.entries(ledger.data.runs))
        if (run.agentId === agentId) delete ledger.data.runs[runId];
      for (const paper of Object.values(ledger.data.papers)) if (paper.binding === agentId) delete paper.binding;
      for (const agent of Object.values(ledger.data.agents)) if (agent.replaces === agentId) delete agent.replaces;
      for (const task of Object.values(ledger.data.tasks)) {
        if (task.agentId !== agentId || task.state !== 'starting') continue;
        task.state = 'queued';
        delete task.start;
        delete task.agentId;
      }
      await ledger.save();
    });
    this.#forgotten.add(agentId);
    if (why) this.#d.logger.warn(`代理 ${agentId} ${why}，从账本移除`);
  }

  // ----- 定期检查 -----

  async #reconcile(): Promise<void> {
    if (this.#reconciling || this.#closed() || this.#d.ledger.failure) return;
    this.#reconciling = true;
    try {
      await this.#prune();
      for (const type of this.#providerTypes()) {
        const entry = resolveRemoteAgent(this.#d.remote, type);
        if (!entry) continue;
        await this.#reconcileRuns(entry);
        await this.#reconcileAgents(entry);
      }
      await this.#retryCosts();
      await this.#reap();
      await this.#archiveIdle();
      await this.#clearDue();
      for (const paperId of this.#papersWithWork()) this.kick(paperId);
    } finally {
      this.#reconciling = false;
    }
  }

  /** 已结束超过保留天数的任务记录；轮次记录不随它清理（留到代理确认删除） */
  async #prune(): Promise<void> {
    const { ledger, cfg } = this.#d;
    const cutoff = this.#d.now() - cfg.taskRetentionDays * DAY;
    await ledger.exclusive(async () => {
      let removed = 0;
      for (const [id, task] of Object.entries(ledger.data.tasks)) {
        if (UNFINISHED_STATES.has(task.state) || ledger.data.reserves[id]) continue;
        if ((task.endedAt ?? task.createdAt) >= cutoff) continue;
        delete ledger.data.tasks[id];
        removed++;
      }
      if (removed > 0) await ledger.save();
    });
  }

  /** 账本里这个提供者的全部未删除代理（跳过开轮中的）：有账本外的轮次就按自唤醒处理 */
  async #reconcileRuns(entry: RemoteAgentEntry): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    for (const [agentId, agent] of Object.entries(ledger.data.agents)) {
      if (agent.providerType !== entry.contextId || this.#opening(agentId)) continue;
      let runs: RemoteRunSummary[];
      try {
        runs = await entry.instance.listRuns(agentId, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        const idle = !Object.values(ledger.data.tasks).some(t => t.agentId === agentId && ON_AGENT.has(t.state));
        if (isRemoteAgentError(err) && err.code === 'not-found' && idle)
          await this.#forget(agentId, '远端已找不到这个代理');
        else logger.warn(`对账：列代理 ${agentId} 的轮次失败: ${describe(err)}`);
        continue;
      }
      // 列轮次期间可能开了新一轮：以落盘后的账本为准，开轮中的仍然跳过
      if (!ledger.data.agents[agentId] || this.#opening(agentId)) continue;
      const unknown = runs.filter(r => !ledger.data.runs[r.runId]);
      if (unknown.length > 0) await this.#selfWake(agentId, unknown);
    }
  }

  /** 账号下账本外的代理：同一 agentId 只建一条告警；未读期间每次对账都记 warn */
  async #reconcileAgents(entry: RemoteAgentEntry): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    let listed: Awaited<ReturnType<RemoteAgentProvider['listAgents']>>;
    try {
      listed = await entry.instance.listAgents(signal);
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn(`对账：列远端代理「${entry.contextId}」账号下的代理失败: ${describe(err)}`);
      return;
    }
    let added = false;
    for (const summary of listed) {
      if (ledger.data.agents[summary.agentId] || this.#forgotten.has(summary.agentId)) continue;
      const alert = ledger.data.alerts.find(a => a.kind === 'unknown-agent' && a.subject === summary.agentId);
      if (alert?.acknowledged) continue;
      logger.warn(
        `远端代理「${entry.contextId}」的账号下有账本外的代理 ${summary.name}（${summary.agentId}）；` +
          '在 WebUI 核实并标为已读之前，用这个提供者的白纸停开',
      );
      if (alert) continue;
      this.#alert({
        kind: 'unknown-agent',
        subject: summary.agentId,
        providerType: entry.contextId,
        message: `账号下有账本外的代理 ${summary.name}（${summary.agentId}）`,
      });
      added = true;
    }
    if (added) await ledger.exclusive(() => ledger.save());
  }

  /** 补取暂缺的费用（包括结束时没来得及取的） */
  async #retryCosts(): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    for (const [runId, run] of Object.entries(ledger.data.runs)) {
      if (run.cost.state === 'booked') continue;
      const task = run.taskId ? ledger.data.tasks[run.taskId] : undefined;
      if (run.cost.state === 'pending' && task && ON_AGENT.has(task.state)) continue;
      const agent = ledger.data.agents[run.agentId];
      const entry = agent && resolveRemoteAgent(this.#d.remote, agent.providerType);
      if (!entry) continue;
      try {
        const cost = await entry.instance.runCost(run.agentId, runId, signal);
        if (cost) await this.#book(runId, cost, false);
      } catch (err) {
        if (signal.aborted) throw err;
        logger.warn(`对账：补取轮次 ${runId} 的费用失败: ${describe(err)}`);
      }
    }
  }

  /** 代理最后一轮结束 idleArchiveMinutes 后没有新任务：先核查，再归档 */
  async #archiveIdle(): Promise<void> {
    const { ledger, cfg } = this.#d;
    for (const [paperId, paper] of Object.entries(ledger.data.papers)) {
      const agent = paper.binding ? ledger.data.agents[paper.binding] : undefined;
      if (!agent || agent.state !== 'active' || agent.lastRunEndedAt === undefined) continue;
      const spec = this.#spec(paperId) ?? cfg.defaults;
      if (this.#d.now() - agent.lastRunEndedAt < spec.idleArchiveMinutes * MINUTE) continue;
      if (this.#hasUnfinished(paperId) || this.#locks.has(paperId)) continue;
      await this.#locked(paperId, () => this.#archive(paperId, paper.binding ?? ''));
    }
  }

  async #archive(paperId: string, agentId: string): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    const agent = ledger.data.agents[agentId];
    // 拿到锁之后再核对一次：这期间可能来了新任务，或代理已不再绑定
    if (ledger.data.papers[paperId]?.binding !== agentId || agent?.state !== 'active') return;
    if (this.#hasUnfinished(paperId)) return;
    const entry = resolveRemoteAgent(this.#d.remote, agent.providerType);
    if (!entry) return;
    try {
      const unknown = await this.#unknownRuns(entry, agentId);
      if (unknown.length > 0) {
        await this.#selfWake(agentId, unknown);
        return;
      }
      await entry.instance.archiveAgent(agentId, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn(`闲置归档代理 ${agentId} 失败，下次检查再试: ${describe(err)}`);
      return;
    }
    await ledger.exclusive(async () => {
      if (agent.state !== 'active') return;
      agent.state = 'archived';
      await ledger.save();
    });
    logger.info(`代理 ${agent.name}（${agentId}）闲置，已归档`);
  }

  /** 定期清空：距上次清空满 clearAfterDays、且白纸上没有未结束的任务（在账本锁里判） */
  async #clearDue(): Promise<void> {
    const { ledger, cfg } = this.#d;
    for (const [paperId, paper] of Object.entries(ledger.data.papers)) {
      const spec = this.#spec(paperId) ?? cfg.defaults;
      if (this.#d.now() - paper.lastClearedAt < spec.clearAfterDays * DAY) continue;
      await this.#clear(paperId, true);
    }
  }

  /** periodic：定期清空只在白纸完全空闲时做，排队的任务也不取消 */
  async #clear(paperId: string, periodic: boolean): Promise<string | undefined> {
    const { ledger, logger, storage } = this.#d;
    const refused = await ledger.exclusive(async () => {
      const tasks = Object.values(ledger.data.tasks).filter(t => t.paperId === paperId);
      const busy = periodic ? UNFINISHED_STATES : ON_AGENT;
      if (tasks.some(t => busy.has(t.state))) return '这块白纸有任务在跑，等它结束或先取消再清空';
      const now = this.#d.now();
      for (const task of tasks) {
        if (task.state === 'queued') {
          task.state = 'cancelled';
          task.cancelledVia = 'webui';
          task.endedAt = now;
          release(ledger.data, task.id);
        }
        if (task.artifacts.length > 0) task.artifactsCleared = true;
      }
      for (const agent of Object.values(ledger.data.agents)) {
        if (agent.paperId !== paperId) continue;
        agent.state = 'retired';
        delete agent.replaces;
      }
      const paper = this.#paper(paperId);
      delete paper.binding;
      delete paper.rotateNext;
      delete paper.noBundleNext;
      paper.lastClearedAt = now;
      await ledger.save();
      return undefined;
    });
    if (refused) return refused;
    this.#d.ended();
    try {
      await storage.delete(paperDirUri(paperId));
    } catch (err) {
      if (!isStorageNotFound(err)) logger.warn(`删除白纸 ${paperId} 的目录失败: ${describe(err)}`);
    }
    logger.info(`白纸 ${paperId} 已清空`);
    await this.#reap();
    return undefined;
  }

  // ----- 小工具 -----

  #closed(): boolean {
    return this.#draining || this.#d.signal.aborted;
  }

  #stopTimers(): void {
    clearInterval(this.#interval);
    for (const timer of this.#deadlines.values()) clearTimeout(timer);
    this.#deadlines.clear();
  }

  #track(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work
      .catch(err => {
        if (!this.#d.signal.aborted) this.#d.logger.error(`白纸后台任务出错: ${describe(err)}`);
      })
      .finally(() => this.#inflight.delete(tracked));
    this.#inflight.add(tracked);
  }

  /** 白纸的状态（没有就建，从现在起算定期清空） */
  #paper(paperId: string): PaperState {
    const papers = this.#d.ledger.data.papers;
    papers[paperId] ??= { lastClearedAt: this.#d.now() };
    return papers[paperId];
  }

  /** n:<名> 取具名白纸（配置里没有了返回 undefined），r:<哈希> 取默认属性 */
  #spec(paperId: string): PaperSpec | undefined {
    return paperId.startsWith('n:') ? this.#d.cfg.papers.get(paperId.slice(2)) : this.#d.cfg.defaults;
  }

  #hasUnfinished(paperId: string): boolean {
    return Object.values(this.#d.ledger.data.tasks).some(t => t.paperId === paperId && UNFINISHED_STATES.has(t.state));
  }

  #papersWithWork(): Set<string> {
    return new Set(
      Object.values(this.#d.ledger.data.tasks)
        .filter(t => UNFINISHED_STATES.has(t.state))
        .map(t => t.paperId),
    );
  }

  /** 开轮中：代理还在建，或上面有 starting 的任务（runId 可能还没落盘） */
  #opening(agentId: string): boolean {
    const { data } = this.#d.ledger;
    if (data.agents[agentId]?.state === 'creating') return true;
    return Object.values(data.tasks).some(t => t.agentId === agentId && t.state === 'starting');
  }

  #providerTypes(): Set<string> {
    const { ledger, cfg } = this.#d;
    return new Set(
      [
        ...Object.values(ledger.data.agents).map(a => a.providerType),
        cfg.defaults.remoteAgentType,
        ...[...cfg.papers.values()].map(s => s.remoteAgentType),
      ].filter(Boolean),
    );
  }

  async #unknownRuns(entry: RemoteAgentEntry, agentId: string): Promise<RemoteRunSummary[]> {
    const runs = await entry.instance.listRuns(agentId, this.#d.signal);
    return runs.filter(r => !this.#d.ledger.data.runs[r.runId]);
  }

  /** 按实例 id 精确取提供者；不在场时按临时故障等（计入等待上限） */
  async #provider(type: string, waits: Waits): Promise<RemoteAgentEntry> {
    for (let attempt = 0; ; attempt++) {
      const entry = resolveRemoteAgent(this.#d.remote, type);
      if (entry) return entry;
      this.#d.logger.warn(`远端代理「${type}」不在场，稍后再试`);
      await this.#wait(waits, backoff(attempt));
    }
  }

  /** 调一次远端；transient、rate-limited 与认不出的错误按退避重试（计入等待上限），其余原样抛出 */
  async #retrying<T>(waits: Waits, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (this.#d.signal.aborted) throw err;
        const remote = isRemoteAgentError(err) ? err : undefined;
        if (remote && remote.code !== 'transient' && remote.code !== 'rate-limited') throw err;
        const ms = remote?.code === 'rate-limited' ? (remote.retryAfterMs ?? RATE_LIMIT_MS) : backoff(attempt);
        this.#d.logger.warn(`远端调用失败，${Math.round(ms / SECOND)} 秒后重试: ${describe(err)}`);
        await this.#wait(waits, ms);
      }
    }
  }

  async #wait(waits: Waits, ms: number): Promise<void> {
    if (waits.spent + ms > WAIT_CAP_MS) throw new GaveUp();
    waits.spent += ms;
    await sleep(ms, this.#d.signal);
  }

  async #haltPaper(
    paperId: string,
    reason: NonNullable<PaperState['halted']>['reason'],
    detail: string,
    alert: Pick<AlertRecord, 'kind' | 'subject' | 'providerType'>,
  ): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      this.#halt(paperId, reason, detail);
      this.#alert({ ...alert, message: detail });
      await ledger.save();
    });
    this.#d.logger.warn(`白纸 ${paperId} 停开：${detail}`);
  }

  /** 停开；已经停开的保留最早的原因 */
  #halt(paperId: string, reason: NonNullable<PaperState['halted']>['reason'], detail: string): void {
    this.#paper(paperId).halted ??= { reason, detail, at: this.#d.now() };
  }

  #alert(fields: Pick<AlertRecord, 'kind' | 'subject' | 'providerType' | 'message'>): void {
    this.#d.ledger.data.alerts.push({ id: `al-${randomHex(4)}`, at: this.#d.now(), acknowledged: false, ...fields });
  }

  /** 同类、同对象的未读告警已有一条时不再加 */
  async #alertOnce(fields: Pick<AlertRecord, 'kind' | 'subject' | 'providerType' | 'message'>): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      if (ledger.data.alerts.some(a => a.kind === fields.kind && a.subject === fields.subject && !a.acknowledged))
        return;
      this.#alert(fields);
      await ledger.save();
    });
  }

  async #fail(task: TaskRecord, reason: string): Promise<Outcome> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      // 新建代理没建成：这个代理退役，远端若已建出来由清理删掉
      const agent = task.start?.path === 'create' && task.agentId ? ledger.data.agents[task.agentId] : undefined;
      if (agent?.state === 'creating') agent.state = 'retired';
      task.state = 'failed';
      task.error = reason;
      task.endedAt = this.#d.now();
      delete task.start;
      release(ledger.data, task.id);
      await ledger.save();
    });
    this.#clearDeadline(task.id);
    this.#d.logger.warn(`白纸任务 ${task.id} 失败：${reason}`);
    this.#d.ended();
    await this.#reap();
    return 'next';
  }
}
