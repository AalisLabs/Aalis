// ============================================================
// 完成通知与待交付提示
//
// - 完成通知：任务到终态（完成、失败、超时取消、被 owner 取消）后，向发起房间注入一条宿主通知
//   （IncomingMessage.hostNotice）。一件一条，source 为 paper:<白纸 id>:<任务 id>，各占 agent 的一条 lane，
//   互不中止；不做串行与积压合并。宿主撰写的行全在 content 里；远端说明截断后经 wrapUntrustedContent 放进
//   hostNotice.untrusted，只在通知那一轮出现、不归档，所以远端说明伪造不出宿主行，也进不了之后的历史。
//   经 paper_cancel 取消的任务不通知（工具结果已告知）。注入之前先把通知标识与时刻记进账本并落盘，每件至多
//   注入一次；app:started 之后才开始注入（网关与 agent 此时已就位），重启前已到终态而还没注入的在这时补注。
//   通知被禁言吞掉或那一轮失败时不重试，由待交付提示在之后的回合补上。
// - 待交付提示：agent:llm:before 上每次请求前先摘掉上一次的提示；房间里有已完成、成品还没发回、结束不到
//   pendingHintHours 的任务时，再插一条独立的 system 消息（最后一条是 user 时插在它前面，否则追加在末尾，
//   不碰 messages[0]）。工具循环的每一轮都重新判定，paper_send 之后下一次请求就不再提示。只列任务 id、
//   她起的任务名与成品的编号、类型、大小，不含远端说明，也不含远端给的文件名。
// ============================================================

import type { Hooks } from '@aalis/api-hooks';
import { wrapUntrustedContent } from '@aalis/api-tools';
import type { Events, Logger } from '@aalis/core';
import { type IncomingMessage, selfInitiatedActor } from '@aalis/schema-message';
import type { PaperConfig } from './config.js';
import { type LedgerStore, randomHex, type TaskRecord, UNFINISHED_STATES } from './ledger.js';

/** 通知里远端说明的长度 */
const NOTICE_NOTE_MAX = 800;
/** 通知里失败原因的长度：原因里可能带远端接口的报错原文 */
const ERROR_MAX = 200;
/** 待交付提示消息的 injector：每次请求前按它摘掉上一次的提示 */
const PENDING_INJECTOR = 'paper/pending';
const HOUR = 3_600_000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/** 字节数的可读写法：B、KB、MB */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function artifactList(task: TaskRecord): string {
  return task.artifacts.map(a => `${a.id}（${a.type}，${formatSize(a.sizeBytes)}）`).join('、');
}

function outcomeOf(task: TaskRecord): string {
  if (task.state === 'done') return '已完成';
  if (task.state === 'failed') {
    // 压成一行：原因里的换行不能在通知里另起一行冒充宿主行
    return `失败：${truncate((task.error ?? '原因不明').replace(/\s+/g, ' ').trim(), ERROR_MAX)}`;
  }
  if (task.cancelledVia === 'timeout') return '超过单轮时长上限，已取消';
  if (task.cancelledVia === 'webui') return '已被 owner 取消';
  return '已在远端被取消';
}

/** 完成通知的宿主正文：只有宿主撰写的行 */
function noticeContent(task: TaskRecord): string {
  const facts: string[] = [];
  if (task.startedAt !== undefined && task.endedAt !== undefined) {
    facts.push(`用时 ${formatDuration(task.endedAt - task.startedAt)}`);
  }
  if (task.costCents !== undefined) facts.push(`花费 ${task.costCents} 美分`);
  else if (task.runId) facts.push('费用还没入账');
  const lines = [`[白纸] 任务 ${task.id}「${task.name}」${outcomeOf(task)}。${facts.map(f => `${f}。`).join('')}`];
  lines.push(task.artifacts.length > 0 ? `成品：${artifactList(task)}` : '没有取回成品。');
  if (task.resultText) lines.push(`远端说明见 paper_status ${task.id}。`);
  if (task.artifacts.length > 0) lines.push('用 paper_send 按成品编号发回本群。');
  return lines.join('\n');
}

interface NoticeDeps {
  ledger: LedgerStore;
  events: Events;
  logger: Logger;
  now: () => number;
}

export class PaperNotices {
  readonly #d: NoticeDeps;
  #open = false;
  #closed = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: NoticeDeps) {
    this.#d = deps;
  }

  /** app:started：网关与 agent 已就位，开始注入，并补注重启前已到终态而还没注入的 */
  open(): void {
    this.#open = true;
    this.flush();
  }

  /** 有任务到了终态：还没注入通知的各注入一条。依次执行，同一件不会注入两次 */
  flush(): void {
    if (!this.#open || this.#closed) return;
    this.#chain = this.#chain
      .then(() => this.#sweep())
      .catch(err => this.#d.logger.error(`白纸完成通知出错: ${describe(err)}`));
  }

  /** 收尾：不再注入，等在途的注入结束 */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#chain;
  }

  async #sweep(): Promise<void> {
    const { ledger, logger } = this.#d;
    const due = await ledger.exclusive(async () => {
      if (ledger.failure) return [];
      const tasks = Object.values(ledger.data.tasks)
        .filter(t => !UNFINISHED_STATES.has(t.state) && !t.notice && t.cancelledVia !== 'tool')
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
      if (tasks.length === 0) return [];
      const at = this.#d.now();
      for (const task of tasks) task.notice = { id: `n-${randomHex(4)}`, at };
      try {
        await ledger.save();
      } catch (err) {
        for (const task of tasks) delete task.notice;
        logger.error(`白纸账本写入失败，完成通知暂不注入: ${describe(err)}`);
        return [];
      }
      return tasks;
    });
    for (const task of due) await this.#inject(task);
  }

  async #inject(task: TaskRecord): Promise<void> {
    const { logger } = this.#d;
    const id = task.notice?.id ?? '';
    const untrusted = task.resultText
      ? wrapUntrustedContent(truncate(task.resultText, NOTICE_NOTE_MAX), `远端代理对任务 ${task.id} 的说明`)
      : undefined;
    const message: IncomingMessage = {
      content: noticeContent(task),
      sessionId: task.room,
      platform: task.platform,
      source: `paper:${task.paperId}:${task.id}`,
      actor: selfInitiatedActor(task.platform),
      hostNotice: { kind: 'paper-task', id, ...(untrusted ? { untrusted } : {}) },
    };
    try {
      await this.#d.events.emit('inbound:message', message);
      logger.info(`白纸任务 ${task.id} 的完成通知 ${id} 已注入房间 ${task.room}`);
    } catch (err) {
      logger.warn(`白纸任务 ${task.id} 的完成通知注入失败，不重试（待交付提示会在之后的回合补上）: ${describe(err)}`);
    }
  }
}

/** 房间里待交付的任务：已完成、成品还没发回也没被清空、结束时刻不早于 since */
function pendingHint(ledger: LedgerStore, room: string, since: number): string | undefined {
  const tasks = Object.values(ledger.data.tasks)
    .filter(
      t =>
        t.room === room &&
        t.state === 'done' &&
        !t.delivered &&
        !t.artifactsCleared &&
        t.artifacts.length > 0 &&
        (t.endedAt ?? 0) >= since,
    )
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  if (tasks.length === 0) return undefined;
  return [
    '[白纸] 以下任务的成品还没发回本群，需要时用 paper_send 按成品编号发：',
    ...tasks.map(t => `- 任务 ${t.id}「${t.name}」：${artifactList(t)}`),
  ].join('\n');
}

export function registerPendingHint(deps: {
  hooks: Hooks;
  ledger: LedgerStore;
  cfg: PaperConfig;
  now: () => number;
}): void {
  deps.hooks.middleware('agent:llm:before', async (data, next) => {
    const { messages } = data;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].metadata?.injector === PENDING_INJECTOR) messages.splice(i, 1);
    }
    const since = deps.now() - deps.cfg.pendingHintHours * HOUR;
    const hint = data.sessionId ? pendingHint(deps.ledger, data.sessionId, since) : undefined;
    if (hint) {
      const insertAt = messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
      messages.splice(insertAt, 0, { role: 'system', content: hint, metadata: { injector: PENDING_INJECTOR } });
    }
    await next();
  });
}
