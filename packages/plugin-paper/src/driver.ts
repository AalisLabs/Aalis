// ============================================================
// 运行驱动：每块白纸一把锁、一条队列，把任务交给远端代理跑到终态、取回成品、按轮记账
//
// - 队列：同一块白纸一件做完才开下一件，不同白纸并行。白纸停开、提供者实例有未读的账本外代理告警时不出队；
//   出队时把受理时的核对（房间开关与白纸指向、类型白名单、出网上限、同账号隔离）重跑一遍，不过就判失败，
//   再核对一次上限并重记预留。
// - 先落盘再调远端：建代理前账本里已有这个代理（creating）与开轮中的任务（starting，path=create）；已绑定
//   代理开轮前任务已是 starting（path=run）。startRun 不幂等：结果未知时（读超时、临时故障、重启接回）先列
//   轮次，账本外的恰好一轮就认领（记一条告警请 owner 核对），没有就重发，多于一轮按自唤醒处理；从没有结果
//   未知的请求时，busy 加账本外的轮次立即按自唤醒处理。结果未知之后认领不了（列不出轮次，或重启接回时提供者
//   等满上限仍不在场）：任务留在开轮中、预留保留，等下次触发再认领，第一次挂一条告警（claim-failed）；owner
//   可以放弃跟踪，任务判为失败，之后列得出这个代理的轮次时那一轮记到它名下（orphanRun）；放弃之后才认领到或开出的
//   一轮没人跟踪，请远端取消。
// - 等待上限：开轮之前 busy、transient、rate-limited（含 archived 后的取消归档）的等待每件任务合计不超过
//   10 分钟，超过就判失败、释放预留，结果未知之后的认领除外（见上）；终态之后另算一份，等不到时任务留在取回
//   成品中，下次触发再取。
// - 单轮时长：每件运行中的任务一个计时器（开轮时刻加 maxRunMinutes），与事件流无关；到点取消，取消按
//   10、30、60 秒退避仍失败就停开白纸，之后 owner 可以放弃跟踪（任务判为失败，费用等这一轮结束后补记）。
// - 终态后：核查账本外的轮次、取回成品（写入口见 artifacts.ts）、按实际费用入账（暂缺时 20 秒一次、共 3 次，
//   仍缺就停开白纸，预留按临时花费保留，定期检查时再补取；owner 也可以核销）。任务到终态（含失败、清空时
//   取消排队的）后交给完成通知（notices.ts）；失败原因只写宿主撰写的类别，远端报错的原文只进日志。
// - 自唤醒事件（代理上出现账本外的轮次）：取消在跑的、费用记进全局日账、停开白纸、下一次新建代理不带旧工程包；
//   删除这个代理（不只归档：定时唤醒的订阅跟着代理走），它上面还有本白纸的任务时等任务取回成品后再删。
// - 删除代理之前结清它名下的费用（删掉之后就取不到了）：自唤醒与建代理判为失败的代理照删，取不到的按估计
//   入账；其余的等费用入账后再删。
// - 换新：代理累计花费超过上限或 owner 点了换新时建新代理（不按 token 数：提供者报的是一轮里全部模型调用的
//   累计，不是上下文长度）；新代理有一轮成功取回之前每轮都带旧工程包链接，成功之后删除旧代理。
// - 定期检查（reconcileMinutes）：清理过期的任务记录、对账（账本里全部未删除的代理，跳过开轮中的；账号下
//   账本外的代理）、补取暂缺的费用、删除退役的代理、闲置归档、定期清空。对账里列代理或轮次失败按提供者实例
//   计连续次数（一次对账里有一次列表失败就算一次，全部列出才清零），到 3 次由诊断项报出；这次没对账的实例
//   （提供者不在场，或已不在配置与账本里）清掉。
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
import { type PaperConfig, specOf } from './config.js';
import {
  type AlertRecord,
  type LedgerStore,
  type PaperState,
  randomHex,
  type TaskRecord,
  UNFINISHED_STATES,
} from './ledger.js';
import { normalizeActivity, progressLabel } from './progress.js';
import { buildPrompt } from './prompt.js';
import { actorKey, checkRemote, type Isolation, pausedReason, resolveRoomPaper } from './rooms.js';
import { TaskJournal } from './task-journal.js';
import { category, describe, truncate } from './util.js';

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
const MISSING_WORKSPACE = '无法取得旧工程包，已停止换新并保留旧代理；先在旧工作区保存工程包再重试';
/** 对账里列表连续失败到这么多次，诊断项报出 */
const LISTING_FAILURE_REPORT = 3;
/** 占着代理的任务状态（排队的不占） */
const ON_AGENT: ReadonlySet<TaskRecord['state']> = new Set(['starting', 'running', 'collecting']);

/** 退避：5 秒起翻倍，封顶 60 秒 */
function backoff(attempt: number): number {
  return Math.min(5 * SECOND * 2 ** attempt, 60 * SECOND);
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
  journal?: TaskJournal;
  remote: ServiceRef<RemoteAgentProvider>;
  sessionManager: ServiceRef<SessionManagerService>;
  storage: StorageService;
  ledger: LedgerStore;
  /** 同账号隔离（出队时与受理时同一套核对） */
  isolation: Isolation;
  cfg: PaperConfig;
  logger: Logger;
  /** 激活的取消信号：停机、停用时中止一切远端调用与等待 */
  signal: AbortSignal;
  now: () => number;
  /** 有任务到了终态（账本已落盘）：交给完成通知 */
  ended: () => void;
}

export class PaperDriver {
  readonly journal: TaskJournal;
  readonly #d: DriverDeps;
  /** 各白纸的运行循环 */
  readonly #loops = new Map<string, Promise<void>>();
  /** 循环在跑时又被踢了一下：这一轮结束后再跑一轮 */
  readonly #rekick = new Set<string>();
  /** 白纸锁：出队并跑完一件任务、闲置归档互斥 */
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  /** 正在跟踪的任务：owner 放弃跟踪时经它停下 */
  readonly #following = new Map<string, AbortController>();
  /** 定期检查与到点取消这些不属于任何循环的后台活，收尾时一起等 */
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #reaping = new Set<string>();
  /** 本次运行里确认删除的代理：列账号下的代理时迟到的旧结果不算账本外 */
  readonly #forgotten = new Set<string>();
  /** 提供者实例 id → 对账里列表连续失败的次数与最近一次对账里失败的类别 */
  readonly #listingFailures = new Map<string, { count: number; categories: string[] }>();
  #interval?: ReturnType<typeof setInterval>;
  #reconciling = false;
  #draining = false;

  constructor(deps: DriverDeps) {
    this.#d = deps;
    this.journal = deps.journal ?? new TaskJournal(deps.storage, deps.logger, deps.now);
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
    if (!ledger.failure) {
      await ledger.exclusive(() => ledger.save()).catch(err => logger.error(`白纸账本落盘失败: ${describe(err)}`));
    }
    await ledger.flush();
    await this.journal.flush();
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

  /** 归档这块白纸在用的代理（下一件任务开轮前自动取消归档）；不能归档时返回原因 */
  async archive(paperId: string): Promise<string | undefined> {
    const agentId = this.#d.ledger.data.papers[paperId]?.binding;
    if (!agentId || this.#d.ledger.data.agents[agentId]?.state !== 'active') return '这块白纸没有在用的代理';
    // 白纸锁被占着就是有任务在出队或在跑：不等它（可能要等一整轮），直接回原因
    if (this.#hasUnfinished(paperId) || this.#locks.has(paperId)) return '这块白纸有任务未结束，等做完再归档';
    return this.#locked(paperId, () => this.#archive(paperId, agentId, 'owner 要求'));
  }

  /**
   * 取消一件任务（paper_cancel 与 WebUI 共用，via 记取消来源）。排队中的直接移出并释放预留；运行中的先记下
   * 取消来源再请远端取消这一轮：远端可能在取消请求返回之前就交出终态，那时再记就晚了（经工具取消的不通知，
   * 被 owner 取消的通知里要写明）。取消失败时还原；这一轮最终不是 cancelled 时由 #finish 清掉。开轮中、
   * 取回成品中与已结束的不取消。gate 在账本锁里核对这件任务能不能由调用方取消，不能时返回原因。
   * 远端调用不占账本锁；费用照常等终态入账，预留到那时再释放。
   */
  async cancel(
    taskId: string,
    via: 'tool' | 'webui',
    gate?: (task: TaskRecord) => string | undefined,
  ): Promise<{ ok: true; taskId: string; state?: 'cancelled'; message?: string } | { ok: false; error: string }> {
    const { ledger, logger, signal } = this.#d;
    type Running = { agentId: string; runId: string; previous: TaskRecord['cancelledVia'] };
    const step = await ledger.exclusive(async () => {
      const task = Object.hasOwn(ledger.data.tasks, taskId) ? ledger.data.tasks[taskId] : undefined;
      if (!task) return { ok: false as const, error: `没有任务 ${taskId}` };
      const refused = gate?.(task);
      if (refused) return { ok: false as const, error: refused };
      switch (task.state) {
        case 'queued': {
          const reserve = ledger.data.reserves[taskId];
          task.state = 'cancelled';
          task.endedAt = this.#d.now();
          task.cancelledVia = via;
          release(ledger.data, taskId);
          try {
            await ledger.save();
          } catch (err) {
            task.state = 'queued';
            delete task.endedAt;
            delete task.cancelledVia;
            if (reserve) ledger.data.reserves[taskId] = reserve;
            logger.error(`白纸账本写入失败，任务未取消: ${describe(err)}`);
            return { ok: false as const, error: '白纸账本写入失败，任务未取消' };
          }
          return { ok: true as const, taskId, state: 'cancelled' as const };
        }
        case 'running': {
          if (!task.agentId || !task.runId) {
            return { ok: false as const, error: '这件任务的远端轮次未知，取消不了，请 owner 在 WebUI 处理' };
          }
          const running: Running = { agentId: task.agentId, runId: task.runId, previous: task.cancelledVia };
          task.cancelledVia = via;
          return running;
        }
        case 'starting':
          return { ok: false as const, error: '这件任务正在开轮，稍后再取消' };
        case 'collecting':
          return { ok: false as const, error: '这一轮已经结束，正在取回成品，取消不了' };
        default:
          return { ok: false as const, error: `这件任务已经结束（${task.state}）` };
      }
    });
    if ('ok' in step) {
      if (step.ok) {
        logger.info(`白纸任务 ${taskId} 已取消（${via}）`);
        this.#d.ended();
      }
      return step;
    }

    const restore = () =>
      ledger.exclusive(async () => {
        const task = ledger.data.tasks[taskId];
        if (task && UNFINISHED_STATES.has(task.state) && task.cancelledVia === via) task.cancelledVia = step.previous;
      });
    const providerType = ledger.data.agents[step.agentId]?.providerType ?? '';
    const entry = resolveRemoteAgent(this.#d.remote, providerType);
    if (!entry) {
      await restore();
      return { ok: false, error: `远端代理「${providerType}」不在场，取消不了` };
    }
    try {
      await entry.instance.cancelRun(step.agentId, step.runId, signal);
    } catch (err) {
      await restore();
      // 回包经 paper_cancel 交给模型：只写类别，提供者报错的原文只进日志
      logger.warn(`白纸任务 ${taskId} 请远端取消轮次 ${step.runId} 失败（${via}）: ${describe(err)}`);
      return { ok: false, error: `远端取消失败（${category(err)}）` };
    }
    logger.info(`白纸任务 ${taskId} 已请远端取消轮次 ${step.runId}（${via}）`);
    await this.journal.record(taskId, undefined, { type: 'cancel_requested', runId: step.runId, via });
    return ledger.exclusive(async () => {
      const task = ledger.data.tasks[taskId];
      if (task && UNFINISHED_STATES.has(task.state)) {
        await ledger.save().catch(err => logger.error(`白纸账本写入失败（取消标记）: ${describe(err)}`));
      }
      return { ok: true as const, taskId, message: '已请远端取消这一轮；费用按实际发生的入账' };
    });
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

  /**
   * 放弃跟踪一件停不下来、也等不到结果的任务（提供者长期不可用时，它会一直占着白纸与预留），两种情形：
   * - 运行中的任务到点取消失败、白纸因此停开：判为失败并写明远端可能仍在运行；轮次记录与预留保留，这一轮到
   *   终态后由定期检查补记费用。
   * - 开轮中、start.path 为 run 的任务认领失败过（见 #claimFailed）：判为失败并写明远端可能已开出一轮；预留保留，
   *   记下 orphanRun，之后列得出这个代理的轮次时由 #unaccounted 把那一轮记到它名下，不当成自唤醒。运行循环
   *   若还在认领这件任务，下一步看到它已结束就停下（见 #postRun）。
   * 两种都让下一件任务建新代理。不能放弃时返回原因。
   */
  async abandon(taskId: string): Promise<string | undefined> {
    const { ledger, logger } = this.#d;
    const refused = await ledger.exclusive(async () => {
      const task = Object.hasOwn(ledger.data.tasks, taskId) ? ledger.data.tasks[taskId] : undefined;
      if (!task) return `没有任务 ${taskId}`;
      if (task.state === 'running') {
        const cancelFailed = ledger.data.alerts.some(a => a.kind === 'cancel-failed' && a.subject === task.agentId);
        if (!ledger.data.papers[task.paperId]?.halted || !cancelFailed) {
          return '运行中的任务只在到点取消失败、白纸停开之后才能放弃跟踪；先试「取消」';
        }
        task.error = '远端这一轮取消不了，owner 放弃跟踪；远端可能仍在运行，费用等这一轮结束后补记';
      } else if (task.state === 'starting') {
        const claimFailed = ledger.data.alerts.some(a => a.kind === 'claim-failed' && a.subject === task.id);
        if (task.start?.path !== 'run' || !claimFailed) {
          return '开轮中的任务只在开轮结果未知、认领失败之后才能放弃跟踪';
        }
        task.error = '开轮结果未知、认领不了，owner 放弃跟踪；远端可能已开出一轮，列得出轮次后费用记到本件名下';
        task.orphanRun = true;
        delete task.start;
      } else {
        return '只有运行中与开轮中的任务能放弃跟踪';
      }
      task.state = 'failed';
      task.endedAt = this.#d.now();
      this.#paper(task.paperId).rotateNext = true;
      await ledger.save();
      return undefined;
    });
    if (refused) return refused;
    this.#clearDeadline(taskId);
    this.#following.get(taskId)?.abort();
    logger.warn(`白纸任务 ${taskId} 已由 owner 放弃跟踪，远端这一轮可能仍在运行或已开出`);
    await this.journal.record(taskId, undefined, { type: 'tracking_abandoned' });
    this.#d.ended();
    return undefined;
  }

  /**
   * 核销一件已结束任务的预留：它还没入账的轮次按预留额估计入账（之后不再补取），预留释放。用于费用一直取不到、
   * 预留一直占着额度的情形。不能核销时返回原因。
   */
  async writeOff(taskId: string): Promise<string | undefined> {
    const { ledger, logger } = this.#d;
    const refused = await ledger.exclusive(async () => {
      const task = Object.hasOwn(ledger.data.tasks, taskId) ? ledger.data.tasks[taskId] : undefined;
      if (!task) return `没有任务 ${taskId}`;
      if (UNFINISHED_STATES.has(task.state)) return '这件任务还没结束，预留等它结束后按实际费用入账';
      if (!ledger.data.reserves[taskId]) return '这件任务没有占着预留';
      for (const [runId, run] of Object.entries(ledger.data.runs)) {
        if (run.taskId === taskId && run.cost.state !== 'booked') this.#estimate(runId);
      }
      release(ledger.data, taskId);
      await ledger.save();
      return undefined;
    });
    if (!refused) logger.info(`白纸任务 ${taskId} 的预留已由 owner 核销`);
    return refused;
  }

  /**
   * 对账里列代理或轮次连续失败到 3 次的提供者实例（诊断项用）：账本外的代理与轮次这期间查不出来。
   * categories 只有宿主撰写的类别，不带提供者报错的原文
   */
  listingFailures(): Array<{ type: string; count: number; categories: string[] }> {
    return [...this.#listingFailures]
      .filter(([, f]) => f.count >= LISTING_FAILURE_REPORT)
      .map(([type, f]) => ({ type, ...f }));
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
    await this.journal.record(task.id, 'task', {
      type: 'task',
      name: task.name,
      text: task.text,
      room: task.room,
      paperId: task.paperId,
      createdAt: task.createdAt,
      observedState: task.state,
      note: task.state === 'queued' ? '任务开始跟踪' : '接回既有任务；启用任务日志前的事件可能未收录',
    });
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
    // 放弃跟踪时 #follow 返回 undefined，任务已判为失败
    const final = task.state === 'running' ? await this.#follow(task) : undefined;
    if (task.state === 'running' || task.state === 'collecting') return this.#finish(task, final);
    return 'next';
  }

  /**
   * 出队：受理时的核对重跑一遍（受理之后房间开关、白纸指向、类型白名单、出网与同账号隔离都可能变了），
   * 再核预算，通过后开轮；返回 undefined 表示已开轮（任务转 running）。核对不过的判为失败；白纸停开、
   * 提供者实例有未读的账本外代理告警时不出队。
   */
  async #dequeue(task: TaskRecord, waits: Waits): Promise<Outcome | undefined> {
    const { ledger, cfg, signal } = this.#d;
    const paper = this.#paper(task.paperId);
    const spec = specOf(this.#d.cfg, task.paperId);
    if (!spec?.remoteAgentType) return this.#fail(task, '这块白纸已不在配置里，或没有配置远端代理类型');
    const type = spec.remoteAgentType;
    if (pausedReason(ledger.data, task.paperId, type)) return 'pause';

    const roomPaper = await resolveRoomPaper(
      this.#d.sessionManager.require(),
      cfg,
      task.room,
      task.platform || undefined,
    );
    if ('unavailable' in roomPaper) return this.#fail(task, `出队时核对不过：${roomPaper.unavailable}`);
    if (roomPaper.paperId !== task.paperId) {
      return this.#fail(task, '出队时核对不过：发起房间现在用的不是这块白纸');
    }
    const present = await this.#provider(type, waits);
    try {
      await this.#retrying(waits, () => present.instance.ready(signal));
    } catch (err) {
      if (signal.aborted || err instanceof GaveUp) throw err;
      // 停开说明经受理的拒绝理由交给模型：只写类别，提供者报错的原文只进日志
      const detail = `远端代理「${type}」不可用（${category(err)}）`;
      await this.#haltPaper(task.paperId, 'provider', detail, { kind: 'provider', providerType: type }, describe(err));
      return 'pause';
    }
    const remote = await checkRemote({
      paper: roomPaper,
      remote: this.#d.remote,
      ledger,
      isolation: this.#d.isolation,
      signal,
    });
    if ('unavailable' in remote) {
      if (pausedReason(ledger.data, task.paperId, type)) return 'pause';
      return this.#fail(task, `出队时核对不过：${remote.unavailable}`);
    }
    const entry = remote.provider;

    // 出队时预算可能已变：去掉本件原来的预留再判，通过就按现在的均值重记
    const refused = await ledger.exclusive(async () => {
      if (task.state !== 'queued') return 'moved';
      const room = roomPaper.room;
      const day = dayKey(this.#d.now(), cfg.budgetTimeZone);
      const user = actorKey(task.initiator);
      const held = ledger.data.reserves[task.id];
      delete ledger.data.reserves[task.id];
      const cents = reserveFor(ledger.data, task.paperId, cfg.reserveDefaultCents);
      const limits = {
        globalCents: cfg.globalDailyCents,
        paperCents: roomPaper.spec.dailyCents,
        roomCents: room.remoteAgentRoomDailyCents,
        userCents: room.remoteAgentUserDailyCents,
        // 按人件数是受理时的上限，本件受理时已计入
        userTasks: undefined,
      };
      const verdict = canStart(ledger.data, day, task.paperId, task.room, user, limits, cents);
      if (!verdict.ok) {
        if (held) ledger.data.reserves[task.id] = held;
        return verdict.reason;
      }
      ledger.data.reserves[task.id] = { cents, day, paperId: task.paperId, room: task.room, user };
      await ledger.save();
      return undefined;
    });
    if (refused === 'moved') return 'next';
    if (refused) return this.#fail(task, refused);

    const bound = paper.binding ? ledger.data.agents[paper.binding] : undefined;
    const rotate =
      !bound ||
      paper.rotateNext ||
      paper.noBundleNext ||
      bound.providerType !== type ||
      bound.costCents > spec.rotateAfterCents;
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
    const replaces = paper.noBundleNext ? undefined : old;
    const prompt = await this.#prompt(task, entry, replaces, waits);
    if (prompt === undefined) {
      // 换新前还没向远端发创建请求；同一提供者可留在原工作区继续，等产出工程包再换新。
      if (replaces && ledger.data.agents[replaces]?.providerType === entry.contextId) {
        this.#d.logger.warn(`白纸 ${task.paperId} 没有可用的工程包，暂缓换新，在原工作区继续制作`);
        return this.#runPath(task, entry, replaces, waits);
      }
      return this.#fail(task, MISSING_WORKSPACE);
    }
    const agentId = entry.instance.mintAgentId();
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
    return this.#create(task, entry, waits, prompt);
  }

  /** 建代理（同一 agentId 重试是安全的：提供者按 id 取回已建的） */
  async #create(
    task: TaskRecord,
    entry: RemoteAgentEntry,
    waits: Waits,
    preparedPrompt?: string,
  ): Promise<Outcome | undefined> {
    const agentId = task.agentId ?? '';
    const agent = this.#d.ledger.data.agents[agentId];
    if (!agent) return this.#fail(task, '账本里找不到开轮中的代理');
    try {
      const prompt = preparedPrompt ?? (await this.#prompt(task, entry, agent.replaces, waits));
      if (prompt === undefined) return this.#fail(task, MISSING_WORKSPACE);
      await this.journal.record(task.id, `prompt:${task.start?.requestedAt}`, {
        type: 'prompt',
        agentId,
        text: prompt,
      });
      const { runId, startedAt } = await this.#retrying(waits, () =>
        entry.instance.createAgent({ agentId, name: agent.name, prompt }, this.#d.signal),
      );
      // 用时与单轮时长从远端这一轮开跑时算：建代理的响应要几十秒才回，建出之前又可能有取工程包链接与退避的等待，
      // 重启接回时远端可能刚建出。提供者给的时刻限在请求时刻与现在之间（两边时钟可能有偏差），没给时按请求时刻
      const now = this.#d.now();
      const requestedAt = task.start?.requestedAt ?? now;
      const at = startedAt === undefined ? requestedAt : Math.min(Math.max(startedAt, requestedAt), now);
      await this.#started(task, runId, at);
      return undefined;
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      this.#d.logger.warn(`白纸任务 ${task.id} 建远端代理失败: ${describe(err)}`);
      return this.#fail(task, `建远端代理失败（${category(err)}）`);
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
      this.#d.logger.warn(`白纸任务 ${task.id} 开轮前核查代理 ${agentId} 出错: ${describe(err)}`);
      return this.#fail(task, `远端代理出错（${category(err)}）`);
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

  /**
   * 重启接回开轮中的任务：新建代理按同一 agentId 重建（提供者等满上限仍不在场就判失败）；已绑定代理先认领，
   * 提供者等满上限仍不在场时不判失败（远端那一轮可能在跑），按认领失败留在开轮中，与 #finish 的做法一致
   */
  async #resumeStart(task: TaskRecord, waits: Waits): Promise<Outcome | undefined> {
    const agent = task.agentId ? this.#d.ledger.data.agents[task.agentId] : undefined;
    if (!agent) return this.#fail(task, '账本里找不到开轮中的代理');
    if (task.start?.path === 'create')
      return this.#create(task, await this.#provider(agent.providerType, waits), waits);
    let entry: RemoteAgentEntry;
    try {
      entry = await this.#provider(agent.providerType, waits);
    } catch (err) {
      if (this.#d.signal.aborted || !(err instanceof GaveUp)) throw err;
      const absent = `远端代理「${agent.providerType}」不在场`;
      return this.#claimFailed(task, agent.providerType, absent, `${absent}，等待超过上限`);
    }
    return this.#postRun(task, entry, waits, true);
  }

  /**
   * 在已绑定的代理上开一轮。startRun 不幂等：结果未知（resumed、临时故障或认不出的错误）时先列轮次认领；
   * busy 时核查是不是账本外的轮次在跑。发出过结果未知的请求之后，账本外恰好一轮就认领（不管这次是
   * 认领核查还是 busy 核查：那一轮很可能是本件开出的）；从没有结果未知的请求时，busy 加账本外的轮次按自唤醒处理。
   * 发出过结果未知的请求之后列不出轮次（远端找不到代理除外）：远端那一轮可能在跑，任务留在开轮中（预留保留），
   * 等下次触发时按重启接回的路径再认领；列出之前不重发，也不判失败（见 #claimFailed）。
   * owner 在这期间放弃跟踪了（任务已不在开轮中）：下一步之前停下，不认领、不重发。
   */
  async #postRun(
    task: TaskRecord,
    entry: RemoteAgentEntry,
    waits: Waits,
    resumed: boolean,
  ): Promise<Outcome | undefined> {
    const agentId = task.agentId ?? '';
    let check: 'claim' | 'busy' | undefined = resumed ? 'claim' : undefined;
    let uncertain = resumed;
    let unarchive = false;
    let delay = 0;
    for (let attempt = 0; ; attempt++) {
      if (task.state !== 'starting') return 'next';
      try {
        if (unarchive) {
          await this.#unarchive(entry, agentId, waits);
          unarchive = false;
        }
        if (check) {
          let unknown: RemoteRunSummary[];
          try {
            unknown = await this.#retrying(waits, () => this.#unknownRuns(entry, agentId));
          } catch (err) {
            const gone = isRemoteAgentError(err) && err.code === 'not-found';
            if (!uncertain || gone || this.#d.signal.aborted) throw err;
            const waited = err instanceof GaveUp;
            const detail = `列代理 ${agentId} 的轮次失败：${waited ? '等待超过上限' : describe(err)}`;
            return this.#claimFailed(task, entry.contextId, waited ? '等待超过上限' : category(err), detail);
          }
          if (task.state !== 'starting') return 'next';
          if (uncertain && unknown.length === 1) {
            await this.#claim(task, entry, unknown[0].runId);
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
        if (task.state !== 'starting') return 'next';
        if (prompt === undefined) return this.#fail(task, MISSING_WORKSPACE);
        await this.journal.record(task.id, `prompt:${task.start?.requestedAt}`, {
          type: 'prompt',
          agentId,
          text: prompt,
        });
        const { runId } = await entry.instance.startRun(agentId, prompt, this.#d.signal);
        await this.#started(task, runId, this.#d.now());
        return undefined;
      } catch (err) {
        if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
        const remote = isRemoteAgentError(err) ? err : undefined;
        const code = remote?.code ?? 'transient';
        if (code === 'rate-limited') delay = remote?.retryAfterMs ?? RATE_LIMIT_MS;
        else if (code === 'busy') check = 'busy';
        else if (code === 'archived') {
          // 取消归档可能要一会儿才生效：按退避等，计入等待上限
          unarchive = true;
          delay = backoff(attempt);
        } else if (code === 'not-found') {
          await this.#forget(agentId, '远端已找不到这个代理');
          return 'next';
        } else if (code === 'unavailable' || code === 'rejected') {
          this.#d.logger.warn(`白纸任务 ${task.id} 开轮被拒: ${describe(err)}`);
          return this.#fail(task, `远端拒绝开轮（${category(err)}）`);
        } else {
          check = 'claim';
          uncertain = true;
          delay = backoff(attempt);
        }
      }
    }
  }

  /**
   * 开轮结果未知、认领不了（列不出轮次，或重启接回时提供者等满上限仍不在场）：任务留在开轮中、预留保留，等下次
   * 触发再认领，不判失败（远端那一轮可能在跑）。每件任务只在第一次挂一条告警（标为已读后也不再挂），写宿主撰写的
   * 类别；detail 是提供者报错的原文，只进 warn。提供者一直不可用时 owner 可以放弃跟踪（见 abandon）。
   */
  async #claimFailed(task: TaskRecord, providerType: string, cause: string, detail: string): Promise<Outcome> {
    const { ledger, logger } = this.#d;
    if (task.state !== 'starting') return 'next';
    logger.warn(`白纸任务 ${task.id} 开轮结果未知，认领失败，留在开轮中等下次认领: ${detail}`);
    await ledger.exclusive(async () => {
      if (ledger.data.alerts.some(a => a.kind === 'claim-failed' && a.subject === task.id)) return;
      this.#alert({
        kind: 'claim-failed',
        subject: task.id,
        providerType,
        message:
          `开轮结果未知，白纸任务 ${task.id} 认领不了（${cause}），留在开轮中、预留保留，远端这一轮可能在跑；` +
          '提供者一直不可用时，可在任务表「放弃跟踪」',
      });
      await ledger.save();
    });
    return 'pause';
  }

  /**
   * 开轮结果未知时认领账本外的唯一一轮。开轮前已核查过代理上没有账本外的轮次，能认领的一轮都开在这之后，
   * 开轮时刻分不出它是本件开出的、还是同一时间窗里定时唤醒开出的，所以记一条告警请 owner 核对。
   */
  async #claim(task: TaskRecord, entry: RemoteAgentEntry, runId: string): Promise<void> {
    const agentId = task.agentId ?? '';
    this.#d.logger.info(`白纸任务 ${task.id} 认领远端轮次 ${runId}`);
    await this.#started(task, runId, task.start?.requestedAt ?? this.#d.now());
    await this.#alertOnce({
      kind: 'claim-unverified',
      subject: runId,
      providerType: entry.contextId,
      message:
        `开轮结果未知，白纸任务 ${task.id} 认领了代理 ${agentId} 上唯一一轮账本外的轮次 ${runId}；` +
        '核对不了它是本件开出的还是代理自己唤醒的，请在远端后台核对',
    });
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
    if (replaces && !bundleUrl) return undefined;
    return buildPrompt({
      layout: entry.instance.layout,
      taskId: task.id,
      text: task.text,
      maxRunMinutes: this.#d.cfg.maxRunMinutes,
      bundleUrl,
      publication: task.publication !== undefined,
    });
  }

  async #bundleUrl(agentId: string, waits: Waits): Promise<string | undefined> {
    const old = this.#d.ledger.data.agents[agentId];
    const entry = old && resolveRemoteAgent(this.#d.remote, old.providerType);
    if (!entry) return undefined;
    try {
      return await this.#retrying(waits, () => entry.instance.bundleLink(agentId, this.#d.signal));
    } catch (err) {
      if (this.#d.signal.aborted || err instanceof GaveUp) throw err;
      this.#d.logger.warn(`取旧代理 ${agentId} 的工程包链接失败，停止换新并保留旧代理: ${describe(err)}`);
      return undefined;
    }
  }

  /**
   * 拿到 runId：记进轮次表，任务转 running；新建的代理转为绑定，原来绑定的退役。owner 在开轮途中放弃跟踪了
   * （任务已不在开轮中）：这一轮照样记到本件名下，费用照常入账后释放预留，任务不再转 running，并请远端取消这一轮
   * （见 #cancelOrphan）
   */
  async #started(task: TaskRecord, runId: string, startedAt: number): Promise<void> {
    const { ledger } = this.#d;
    const abandoned = await ledger.exclusive(async () => {
      const agentId = task.agentId ?? '';
      ledger.data.runs[runId] = { agentId, taskId: task.id, cost: { state: 'pending' } };
      if (task.state !== 'starting') {
        task.runId = runId;
        delete task.orphanRun;
        await ledger.save();
        return true;
      }
      task.state = 'running';
      task.runId = runId;
      task.startedAt = startedAt;
      delete task.start;
      delete task.lastEventId;
      delete task.progress;
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
      return false;
    });
    if (abandoned) {
      await this.#cancelOrphan(task.id, task.agentId ?? '', runId);
      return;
    }
    this.#d.logger.info(`白纸任务 ${task.id} 开轮（代理 ${task.agentId}，轮次 ${runId}）`);
    await this.journal.record(task.id, `start:${runId}`, { type: 'started', agentId: task.agentId, runId, startedAt });
  }

  /**
   * 记到放弃跟踪的任务名下的一轮（放弃之后才认领到或开出）：没人再跟踪、取回成品，单轮时长的到点取消也只管运行中
   * 的任务，尽力请远端取消，免得它跑到远端自己的上限。取消失败只记 warn（提供者报错的原文只进日志），费用照常
   * 等这一轮到终态后入账
   */
  async #cancelOrphan(taskId: string, agentId: string, runId: string): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    const providerType = ledger.data.agents[agentId]?.providerType ?? '';
    try {
      const entry = resolveRemoteAgent(this.#d.remote, providerType);
      if (!entry) throw new Error(`远端代理「${providerType}」不在场`);
      await entry.instance.cancelRun(agentId, runId, signal);
      logger.info(`放弃跟踪的白纸任务 ${taskId} 名下的轮次 ${runId} 已请远端取消`);
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn(
        `放弃跟踪的白纸任务 ${taskId} 名下的轮次 ${runId} 请远端取消失败（${category(err)}）: ${describe(err)}`,
      );
    }
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

  /**
   * 跟踪一轮直到终态；断线等由提供者处理，这里只在提供者放弃或不在场时退避重连。owner 放弃跟踪时
   * （见 abandon）停下，返回 undefined。
   */
  async #follow(task: TaskRecord): Promise<RunState | undefined> {
    const { ledger, logger } = this.#d;
    const agentId = task.agentId ?? '';
    const runId = task.runId ?? '';
    const providerType = ledger.data.agents[agentId]?.providerType ?? '';
    const stop = new AbortController();
    this.#following.set(task.id, stop);
    const signal = AbortSignal.any([this.#d.signal, stop.signal]);
    this.#armDeadline(task);
    let savedAt = this.#d.now();
    let journalHealthy = true;
    try {
      for (let attempt = 0; ; attempt++) {
        const entry = resolveRemoteAgent(this.#d.remote, providerType);
        if (entry) {
          try {
            const events = entry.instance.followRun(agentId, runId, { lastEventId: task.lastEventId, signal });
            for await (const event of events) {
              if (event.kind === 'terminal') {
                await this.journal.flush(task.id);
                await this.journal.record(task.id, `terminal:${runId}`, { type: 'terminal', ...event.state });
                await this.journal.flush(task.id);
                return event.state;
              }
              if (event.kind === 'log') {
                await this.journal.record(task.id, undefined, { type: 'remote', runId, record: event.record });
                continue;
              }
              if (!journalHealthy) journalHealthy = await this.journal.flush(task.id);
              const logged = await this.journal.record(task.id, `${runId}:${event.eventId}`, {
                type: 'progress',
                runId,
                eventId: event.eventId,
                ...(event.activity ? { activity: normalizeActivity(event.activity) } : {}),
                ...(event.record ? { record: event.record } : {}),
              });
              journalHealthy &&= logged;
              if (journalHealthy) task.lastEventId = event.eventId;
              if (event.activity) {
                const activity = normalizeActivity(event.activity);
                const label = activity && progressLabel(activity, true);
                const previous = task.progress?.activity;
                if (label && activity && JSON.stringify(previous) !== JSON.stringify(activity)) {
                  task.progress = {
                    activity,
                    at: this.#d.now(),
                  };
                  logger.info(`白纸任务 ${task.id} 进展：${label}`);
                }
              }
              attempt = 0;
              if (this.#d.now() - savedAt >= PROGRESS_SAVE_MS) {
                savedAt = this.#d.now();
                await ledger
                  .exclusive(() => ledger.save())
                  .catch(err => logger.warn(`白纸账本落盘失败（进展）: ${describe(err)}`));
              }
            }
            const state = await entry.instance.getRun(agentId, runId, signal);
            if (isTerminalRun(state.status)) return state;
          } catch (err) {
            if (signal.aborted) throw err;
            if (isRemoteAgentError(err) && err.code === 'not-found') return { runId, status: 'error' };
            logger.warn(`跟踪白纸任务 ${task.id} 的轮次 ${runId} 出错，稍后重连: ${describe(err)}`);
            await this.journal.record(task.id, undefined, { type: 'reconnect', runId, reason: category(err) });
          }
        } else {
          logger.warn(`远端代理「${providerType}」不在场，稍后再跟踪白纸任务 ${task.id}`);
        }
        await sleep(backoff(attempt), signal);
      }
    } catch (err) {
      if (stop.signal.aborted && !this.#d.signal.aborted) return undefined;
      throw err;
    } finally {
      this.#following.delete(task.id);
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
    await this.journal.record(task.id, `timeout:${runId}`, {
      type: 'timeout',
      runId,
      maxRunMinutes: cfg.maxRunMinutes,
    });
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

  /**
   * 终态后：核查账本外的轮次、取回成品、入账，任务到终态。这一段的等待另算上限（开轮前等过的不计在内）；
   * 远端取不到这一轮时任务留在取回成品中，等下次触发再取，不判失败（这一轮已经花了钱）。
   */
  async #finish(task: TaskRecord, final: RunState | undefined): Promise<Outcome> {
    const { ledger, logger, signal } = this.#d;
    this.#clearDeadline(task.id);
    const agentId = task.agentId ?? '';
    const runId = task.runId ?? '';
    if (task.state === 'running') {
      await this.journal.record(task.id, `collecting:${runId}`, { type: 'collecting', runId });
      await ledger.exclusive(async () => {
        task.state = 'collecting';
        await ledger.save();
      });
    }
    const waits: Waits = { spent: 0 };
    let entry: RemoteAgentEntry;
    let state: RunState;
    try {
      entry = await this.#provider(ledger.data.agents[agentId]?.providerType ?? '', waits);
      state = final ?? (await this.#terminalState(entry, agentId, runId, waits));
    } catch (err) {
      if (signal.aborted || !(err instanceof GaveUp)) throw err;
      logger.warn(`白纸任务 ${task.id} 的轮次已结束，远端暂时取不到，留在取回成品中等下次触发`);
      return 'pause';
    }

    // 尽力而为：一次不成就留给定期对账，不占取回成品的等待
    try {
      const unknown = await this.#unknownRuns(entry, agentId);
      if (unknown.length > 0) await this.#selfWake(agentId, unknown);
    } catch (err) {
      if (signal.aborted) throw err;
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
      const agent = ledger.data.agents[agentId];
      if (agent) {
        agent.lastRunEndedAt = task.endedAt;
        // 新代理这一轮成功取回：不再需要旧代理的工程包
        if (outcome === 'done') delete agent.replaces;
      }
      await ledger.save();
    });
    logger.info(`白纸任务 ${task.id} 结束：${outcome}，成品 ${collected.artifacts.length} 件`);
    await this.journal.record(task.id, `finished:${runId}`, {
      type: 'finished',
      runId,
      state: outcome,
      error: task.error,
      costCents: task.costCents,
      artifacts: task.artifacts,
      resultText: state.resultText,
    });
    await this.journal.flush(task.id);
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
  ): Promise<{ artifacts: TaskRecord['artifacts']; error?: string }> {
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
        logger.warn(`取回白纸任务 ${task.id} 的成品失败: ${describe(err)}`);
        return { artifacts: [], error: `取回成品失败（${category(err)}）` };
      }
      if (collector.full) {
        const detail = `白纸目录超过总占用上限 ${cfg.artifacts.maxPaperBytes} 字节，任务 ${task.id} 余下的成品已拒收`;
        await this.#haltPaper(task.paperId, 'storage-full', detail, { kind: 'storage-full' });
      }
      return { artifacts: collector.artifacts };
    }
  }

  /**
   * 按实际费用入账；暂缺时 20 秒一次、共 3 次，仍缺就停开白纸（预留保留）。terminal：已知这一轮到了终态；
   * 否则每次先确认终态再取（刚请求取消的一轮可能还在收尾，不拿收尾前的部分金额）
   */
  async #settleCost(runId: string, entry: RemoteAgentEntry, terminal: boolean): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    const run = ledger.data.runs[runId];
    if (!run || run.cost.state === 'booked') return;
    for (let i = 0; i < COST_ATTEMPTS; i++) {
      if (i > 0) await sleep(COST_RETRY_MS, signal);
      let cost: RunCost | undefined;
      try {
        cost = terminal
          ? await entry.instance.runCost(run.agentId, runId, signal)
          : await this.#finalCost(entry, run.agentId, runId);
      } catch (err) {
        if (signal.aborted) throw err;
        logger.warn(`取轮次 ${runId} 的费用失败: ${describe(err)}`);
      }
      if (cost) {
        await this.#book(runId, cost);
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

  async #book(runId: string, cost: RunCost): Promise<void> {
    const { ledger, cfg } = this.#d;
    await ledger.exclusive(async () => {
      const run = ledger.data.runs[runId];
      if (!run || run.cost.state === 'booked') return;
      book(ledger.data, dayKey(this.#d.now(), cfg.budgetTimeZone), runId, cost.cents);
      if (run.taskId) release(ledger.data, run.taskId);
      await ledger.save();
    });
  }

  /**
   * 自唤醒事件：代理上出现账本外的轮次。停开白纸、下一次新建代理不带旧工程包，取消在跑的账本外轮次、
   * 费用记进全局日账，删除代理（它上面还有本白纸的任务时由那件任务结束后的清理删除）。删除不等费用入账：
   * 订阅跟着代理走，取不到的费用在删除时按估计入账。
   */
  async #selfWake(agentId: string, unknown: RemoteRunSummary[]): Promise<void> {
    const { ledger, logger, signal } = this.#d;
    const agent = ledger.data.agents[agentId];
    if (!agent) return;
    const detail = `代理 ${agent.name}（${agentId}）上出现账本外的轮次 ${unknown.map(r => r.runId).join('、')}，按自唤醒处理：取消并删除代理，下一次新建代理不带旧工程包`;
    await ledger.exclusive(async () => {
      for (const r of unknown) ledger.data.runs[r.runId] ??= { agentId, cost: { state: 'pending' } };
      agent.state = 'retired';
      agent.deleteNow = true;
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

  /**
   * 删除退役的代理：上面没有未结束的任务、也不再是别的代理的工程包来源。删除前先结清它名下的费用
   * （见 #settleBeforeDelete），结不清又不急着删的留到定期检查；删除失败的留给下次对账。
   */
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
        if (!(await this.#settleBeforeDelete(entry, agentId, agent.deleteNow === true))) continue;
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

  /**
   * 删除代理之前结清它名下的费用（删掉之后就取不到了）：先把远端有、账本里没有的轮次记下（例如建代理判为
   * 失败、远端其实已建出的首轮），再给没入账的补取一次终态后的费用。仍有没入账的：now 为真（deleteNow）
   * 照删，由 #forget 按估计入账；否则这次不删，等定期检查补上费用。远端已没有这个代理时照删。
   * 返回这次能不能删。
   */
  async #settleBeforeDelete(entry: RemoteAgentEntry, agentId: string, now: boolean): Promise<boolean> {
    const { ledger, logger, signal } = this.#d;
    let listed: RemoteRunSummary[];
    try {
      listed = await entry.instance.listRuns(agentId, signal);
    } catch (err) {
      if (isRemoteAgentError(err) && err.code === 'not-found') return true;
      throw err;
    }
    const added = await this.#unaccounted(agentId, listed);
    if (added.length > 0) {
      await ledger.exclusive(async () => {
        for (const r of added) ledger.data.runs[r.runId] ??= { agentId, cost: { state: 'pending' } };
        await ledger.save();
      });
      logger.warn(`删除代理 ${agentId} 之前发现账本外的轮次 ${added.map(r => r.runId).join('、')}，先记下再结清费用`);
    }
    for (const runId of this.#unbooked(agentId)) {
      try {
        const cost = await this.#finalCost(entry, agentId, runId);
        if (cost) await this.#book(runId, cost);
      } catch (err) {
        if (signal.aborted) throw err;
        logger.warn(`删除代理前补取轮次 ${runId} 的费用失败: ${describe(err)}`);
      }
    }
    return now || this.#unbooked(agentId).length === 0;
  }

  #unbooked(agentId: string): string[] {
    return Object.entries(this.#d.ledger.data.runs)
      .filter(([, run]) => run.agentId === agentId && run.cost.state !== 'booked')
      .map(([runId]) => runId);
  }

  /**
   * 代理已确认不存在：名下还没入账的轮次费用再也取不到了，按估计入账（见 #estimate）；然后连同轮次记录一起从
   * 账本移除，绑定与引用一并清掉，开轮中的任务回到队列，放弃跟踪时开轮结果未知的任务释放预留
   */
  async #forget(agentId: string, why?: string): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      for (const [runId, run] of Object.entries(ledger.data.runs)) {
        if (run.agentId !== agentId) continue;
        if (run.cost.state !== 'booked') {
          const cents = this.#estimate(runId);
          this.#alert({
            kind: 'cost-estimated',
            subject: runId,
            providerType: ledger.data.agents[agentId]?.providerType,
            message: `代理 ${agentId} 已删除，轮次 ${runId} 的费用取不到，按估计 ${cents} 美分入账；请在远端后台核对`,
          });
        }
        delete ledger.data.runs[runId];
      }
      delete ledger.data.agents[agentId];
      for (const paper of Object.values(ledger.data.papers)) if (paper.binding === agentId) delete paper.binding;
      for (const agent of Object.values(ledger.data.agents)) if (agent.replaces === agentId) delete agent.replaces;
      for (const task of Object.values(ledger.data.tasks)) {
        if (task.agentId !== agentId) continue;
        // 放弃跟踪时开轮结果未知的：代理已不存在，远端不会有这一轮在跑
        if (task.orphanRun) {
          delete task.orphanRun;
          release(ledger.data, task.id);
        }
        if (task.state !== 'starting') continue;
        task.state = 'queued';
        delete task.start;
        delete task.agentId;
      }
      await ledger.save();
    });
    this.#forgotten.add(agentId);
    if (why) this.#d.logger.warn(`代理 ${agentId} ${why}，从账本移除`);
  }

  /**
   * 费用取不到的一轮按估计入账（持账本锁调用），之后不再补取：有任务的按这件任务的预留额，账本外的按这块白纸
   * 一件任务的预留额；这件任务的预留随之释放。返回估计的金额
   */
  #estimate(runId: string): number {
    const { ledger, cfg } = this.#d;
    const run = ledger.data.runs[runId];
    const held = run?.taskId ? ledger.data.reserves[run.taskId] : undefined;
    const paperId = ledger.data.agents[run?.agentId ?? '']?.paperId ?? '';
    const cents = held?.cents ?? reserveFor(ledger.data, paperId, cfg.reserveDefaultCents);
    book(ledger.data, dayKey(this.#d.now(), cfg.budgetTimeZone), runId, cents, true);
    if (run?.taskId) release(ledger.data, run.taskId);
    return cents;
  }

  /** 一轮到终态之后的费用：还没到终态（刚请求取消、还在收尾）或费用暂缺时返回 undefined */
  async #finalCost(entry: RemoteAgentEntry, agentId: string, runId: string): Promise<RunCost | undefined> {
    const state = await entry.instance.getRun(agentId, runId, this.#d.signal);
    if (!isTerminalRun(state.status)) return undefined;
    return entry.instance.runCost(agentId, runId, this.#d.signal);
  }

  // ----- 定期检查 -----

  async #reconcile(): Promise<void> {
    if (this.#reconciling || this.#closed() || this.#d.ledger.failure) return;
    this.#reconciling = true;
    try {
      await this.#prune();
      const reconciled = new Set<string>();
      for (const type of this.#providerTypes()) {
        const entry = resolveRemoteAgent(this.#d.remote, type);
        if (!entry) continue;
        reconciled.add(type);
        const failed = [...(await this.#reconcileRuns(entry)), ...(await this.#reconcileAgents(entry))];
        if (failed.length === 0) this.#listingFailures.delete(type);
        else {
          const count = (this.#listingFailures.get(type)?.count ?? 0) + 1;
          this.#listingFailures.set(type, { count, categories: [...new Set(failed)] });
        }
      }
      // 这次没对账的（提供者停用、移除，或已不在配置与账本里）：计数不再有意义，诊断项不报
      for (const type of this.#listingFailures.keys()) if (!reconciled.has(type)) this.#listingFailures.delete(type);
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
        if (
          UNFINISHED_STATES.has(task.state) ||
          ledger.data.reserves[id] ||
          (task.state === 'done' && (task.publication?.state === 'pending' || task.publication?.state === 'submitted'))
        )
          continue;
        if ((task.endedAt ?? task.createdAt) >= cutoff) continue;
        delete ledger.data.tasks[id];
        removed++;
      }
      if (removed > 0) await ledger.save();
    });
  }

  /** 账本里这个提供者的全部未删除代理（跳过开轮中的）：有账本外的轮次就按自唤醒处理。返回列不出来的类别 */
  async #reconcileRuns(entry: RemoteAgentEntry): Promise<string[]> {
    const { ledger, logger, signal } = this.#d;
    const failed: string[] = [];
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
        else {
          logger.warn(`对账：列代理 ${agentId} 的轮次失败: ${describe(err)}`);
          failed.push(`列轮次：${category(err)}`);
        }
        continue;
      }
      // 列轮次期间可能开了新一轮：以落盘后的账本为准，开轮中的仍然跳过
      if (!ledger.data.agents[agentId] || this.#opening(agentId)) continue;
      const unknown = await this.#unaccounted(agentId, runs);
      if (unknown.length > 0) await this.#selfWake(agentId, unknown);
    }
    return failed;
  }

  /** 账号下账本外的代理：同一 agentId 只建一条告警；未读期间每次对账都记 warn。返回列不出来的类别 */
  async #reconcileAgents(entry: RemoteAgentEntry): Promise<string[]> {
    const { ledger, logger, signal } = this.#d;
    let listed: Awaited<ReturnType<RemoteAgentProvider['listAgents']>>;
    try {
      listed = await entry.instance.listAgents(signal);
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn(`对账：列远端代理「${entry.contextId}」账号下的代理失败: ${describe(err)}`);
      return [`列代理：${category(err)}`];
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
    return [];
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
        const cost = await this.#finalCost(entry, run.agentId, runId);
        if (cost) await this.#book(runId, cost);
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
      const spec = specOf(cfg, paperId) ?? cfg.defaults;
      if (this.#d.now() - agent.lastRunEndedAt < spec.idleArchiveMinutes * MINUTE) continue;
      if (this.#hasUnfinished(paperId) || this.#locks.has(paperId)) continue;
      await this.#locked(paperId, () => this.#archive(paperId, paper.binding ?? '', '闲置'));
    }
  }

  /** 先核查账本外的轮次，再归档（持白纸锁调用）；没有归档时返回原因，why 只进日志 */
  async #archive(paperId: string, agentId: string, why: string): Promise<string | undefined> {
    const { ledger, logger, signal } = this.#d;
    const agent = ledger.data.agents[agentId];
    // 拿到锁之后再核对一次：这期间可能来了新任务，或代理已不再绑定
    if (ledger.data.papers[paperId]?.binding !== agentId || agent?.state !== 'active') return '这块白纸没有在用的代理';
    if (this.#hasUnfinished(paperId)) return '这块白纸有任务未结束，等做完再归档';
    const entry = resolveRemoteAgent(this.#d.remote, agent.providerType);
    if (!entry) return `远端代理「${agent.providerType}」不在场`;
    try {
      const unknown = await this.#unknownRuns(entry, agentId);
      if (unknown.length > 0) {
        await this.#selfWake(agentId, unknown);
        return '代理上有账本外的轮次，已按自唤醒处理（白纸停开，代理删除）';
      }
      await entry.instance.archiveAgent(agentId, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn(`归档代理 ${agentId}（${why}）失败: ${describe(err)}`);
      return `归档失败：${describe(err)}`;
    }
    await ledger.exclusive(async () => {
      if (agent.state !== 'active') return;
      agent.state = 'archived';
      await ledger.save();
    });
    logger.info(`代理 ${agent.name}（${agentId}）已归档（${why}）`);
    return undefined;
  }

  /** 定期清空：距上次清空满 clearAfterDays、且白纸上没有未结束的任务（在账本锁里判） */
  async #clearDue(): Promise<void> {
    const { ledger, cfg } = this.#d;
    for (const [paperId, paper] of Object.entries(ledger.data.papers)) {
      const spec = specOf(cfg, paperId) ?? cfg.defaults;
      if (this.#d.now() - paper.lastClearedAt < spec.clearAfterDays * DAY) continue;
      await this.#clear(paperId, true);
    }
  }

  /** periodic：定期清空只在白纸完全空闲时做，排队的任务也不取消 */
  async #clear(paperId: string, periodic: boolean): Promise<string | undefined> {
    const { ledger, logger, storage } = this.#d;
    const refused = await ledger.exclusive(async () => {
      const tasks = Object.values(ledger.data.tasks).filter(t => t.paperId === paperId);
      if (
        tasks.some(
          t => t.state === 'done' && (t.publication?.state === 'pending' || t.publication?.state === 'submitted'),
        )
      )
        return '这块白纸有待提交或已提交发布的作品，等发布流程结束后再清空';
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
    return this.#unaccounted(agentId, await entry.instance.listRuns(agentId, this.#d.signal));
  }

  /**
   * 列出的轮次里账本外的。这个代理上有放弃跟踪时开轮结果未知的任务（orphanRun）时先按它处理：账本外恰好一轮就
   * 记到它名下（与认领一样分不出是不是本件开出的，记一条 claim-unverified 告警），还没到终态的请远端取消（见
   * #cancelOrphan），费用照常入账后释放预留；没有就释放预留；多于一轮分不出，释放预留，全部仍算账本外（调用方按
   * 自唤醒处理）。
   */
  async #unaccounted(agentId: string, runs: RemoteRunSummary[]): Promise<RemoteRunSummary[]> {
    const { ledger, logger } = this.#d;
    const unknown = () => runs.filter(r => !ledger.data.runs[r.runId]);
    const orphanOf = () => Object.values(ledger.data.tasks).find(t => t.orphanRun && t.agentId === agentId);
    if (!orphanOf()) return unknown();
    const settled = await ledger.exclusive(async () => {
      const task = orphanOf();
      if (!task) return undefined;
      const found = unknown();
      delete task.orphanRun;
      if (found.length === 1) {
        const runId = found[0].runId;
        ledger.data.runs[runId] = { agentId, taskId: task.id, cost: { state: 'pending' } };
        task.runId = runId;
        this.#alert({
          kind: 'claim-unverified',
          subject: runId,
          providerType: ledger.data.agents[agentId]?.providerType,
          message:
            `放弃跟踪的白纸任务 ${task.id} 开轮结果未知，代理 ${agentId} 上唯一一轮账本外的轮次 ${runId} 记到它名下；` +
            '核对不了它是本件开出的还是代理自己唤醒的，请在远端后台核对',
        });
      } else {
        release(ledger.data, task.id);
      }
      await ledger.save();
      return { taskId: task.id, found };
    });
    if (settled?.found.length === 1) {
      const [run] = settled.found;
      logger.info(`放弃跟踪的白纸任务 ${settled.taskId} 开轮结果未知，远端轮次 ${run.runId} 记到它名下`);
      if (!isTerminalRun(run.status)) await this.#cancelOrphan(settled.taskId, agentId, run.runId);
    } else if (settled?.found.length === 0) {
      logger.info(`放弃跟踪的白纸任务 ${settled.taskId} 开轮结果未知，远端没有开出这一轮，释放预留`);
    } else if (settled) {
      logger.warn(
        `放弃跟踪的白纸任务 ${settled.taskId} 开轮结果未知，代理 ${agentId} 上账本外的轮次不止一轮，释放预留`,
      );
    }
    return unknown();
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

  /** 停开并告警；cause 是提供者报错的原文，只进日志 */
  async #haltPaper(
    paperId: string,
    reason: NonNullable<PaperState['halted']>['reason'],
    detail: string,
    alert: Pick<AlertRecord, 'kind' | 'subject' | 'providerType'>,
    cause?: string,
  ): Promise<void> {
    const { ledger } = this.#d;
    await ledger.exclusive(async () => {
      this.#halt(paperId, reason, detail);
      this.#alert({ ...alert, message: detail });
      await ledger.save();
    });
    this.#d.logger.warn(`白纸 ${paperId} 停开：${detail}${cause ? `: ${cause}` : ''}`);
  }

  /**
   * 停开；已经停开的保留最早的原因。detail 经受理的拒绝理由（pausedReason）交给模型，也进诊断项与白纸页：
   * 只写宿主撰写的说明，不带提供者报错的原文
   */
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
    // owner 在这期间放弃跟踪了：任务已结束，失败原因与预留不再动
    const ended = await ledger.exclusive(async () => {
      if (!UNFINISHED_STATES.has(task.state)) return true;
      // 新建代理没建成：这个代理退役，远端若已建出来由清理立即删掉（首轮在白跑）
      const agent = task.start?.path === 'create' && task.agentId ? ledger.data.agents[task.agentId] : undefined;
      if (agent?.state === 'creating') {
        agent.state = 'retired';
        agent.deleteNow = true;
      }
      task.state = 'failed';
      task.error = reason;
      task.endedAt = this.#d.now();
      delete task.start;
      release(ledger.data, task.id);
      await ledger.save();
      return false;
    });
    if (ended) return 'next';
    this.#clearDeadline(task.id);
    this.#d.logger.warn(`白纸任务 ${task.id} 失败：${reason}`);
    await this.journal.record(task.id, undefined, { type: 'failed', reason });
    this.#d.ended();
    await this.#reap();
    return 'next';
  }
}
