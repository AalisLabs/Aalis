// ============================================================
// 账本：白纸、代理、任务、轮次、每日花费、预留与告警，落在 pluginData:/paper/ledger.json
//
// 经 storage 整份原子写（写临时文件再改名）；会改变远端状态的步骤之前先落盘。
// 文件不存在时从空账本起步；存在但读不出或解析不了时失败关闭：远端任务一律不开，原文件不覆盖，
// 等 owner 处理。从空账本起步会让当天的花费与预留清零、所有在用的代理变成「账本外」。
// ============================================================

import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';

const LEDGER_URI = 'pluginData:/paper/ledger.json';

export interface PaperState {
  /** 当前绑定的代理 agentId */
  binding?: string;
  halted?: {
    reason: 'unknown-run' | 'cost-missing' | 'cancel-failed' | 'storage-full' | 'provider';
    detail: string;
    at: number;
  };
  lastClearedAt: number;
  rotateNext?: boolean;
  /** 下一次建代理不带旧工程包（自唤醒事件后置位，建好后清除） */
  noBundleNext?: boolean;
}

export interface AgentRecord {
  providerType: string;
  paperId: string;
  name: string;
  state: 'creating' | 'active' | 'archived' | 'retired' | 'deleted';
  createdAt: number;
  costCents: number;
  lastContextTokens?: number;
  lastRunEndedAt?: number;
}

export type TaskState = 'queued' | 'starting' | 'running' | 'collecting' | 'done' | 'failed' | 'cancelled';

export interface TaskRecord {
  /** t-<8 位十六进制> */
  id: string;
  /** n:<名> 或 r:<房间会话 id 的 sha256 前 12 位> */
  paperId: string;
  /** 发起任务的房间会话 id */
  room: string;
  platform: string;
  /** 发起者的有效授权身份 */
  initiator: { platform: string; userId: string };
  /** 她起的任务名（净化后） */
  name: string;
  /** 宿主回显并发出的原文 */
  text: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  agentId?: string;
  runId?: string;
  lastEventId?: string;
  /** 开轮中：state 为 starting 时必有。path 区分新建代理（可按同 id 重试）与已绑定代理（startRun 不幂等，要先认领） */
  start?: { path: 'create' | 'run'; requestedAt: number };
  /** 这一轮实际入账的费用（美分） */
  costCents?: number;
  /** 远端说明，截断到 2000 字；只经 wrapUntrustedContent 出现在当轮通知与 paper_status 里 */
  resultText?: string;
  /** rel 是远端给的相对路径，只供 WebUI 显示；落盘文件名由宿主生成 */
  artifacts: Array<{
    /** a-<8 位十六进制> */
    id: string;
    rel: string;
    type: 'png' | 'jpeg' | 'gif' | 'webp' | 'mp4' | 'html' | 'other';
    sizeBytes: number;
  }>;
  bundle?: { sizeBytes: number };
  error?: string;
  cancelledVia?: 'tool' | 'webui' | 'timeout';
  notified: boolean;
  delivered: boolean;
}

export interface DaySpend {
  global: number;
  rooms: Record<string, number>;
  users: Record<string, { cents: number; tasks: number }>;
}

export interface ReserveRecord {
  cents: number;
  day: string;
  room: string;
  user: string;
}

export interface AlertRecord {
  id: string;
  at: number;
  kind:
    | 'unknown-run'
    | 'unknown-agent'
    | 'cost-missing'
    | 'provider'
    | 'delete-failed'
    | 'cancel-failed'
    | 'storage-full';
  /** agentId 等 */
  subject?: string;
  /** 远端代理插件实例 id */
  providerType?: string;
  message: string;
  acknowledged: boolean;
}

export interface PaperLedger {
  version: 1;
  papers: Record<string /* paperId */, PaperState>;
  /** Aalis 建过、还没确认删除的全部代理 */
  agents: Record<string /* agentId */, AgentRecord>;
  tasks: Record<string /* taskId */, TaskRecord>;
  /** 保留到对应代理确认删除为止，不随任务记录清理：长寿代理的旧轮次不能在对账时变成「账本外」 */
  runs: Record<
    string /* runId */,
    { agentId: string; taskId?: string; cost: { state: 'pending' | 'booked' | 'missing'; cents?: number } }
  >;
  spend: Record<string /* 本地日期 YYYY-MM-DD */, DaySpend>;
  reserves: Record<string /* taskId */, ReserveRecord>;
  alerts: AlertRecord[];
}

/** 还没结束的任务状态：排队、开轮、运行、取回成品 */
export const UNFINISHED_STATES: ReadonlySet<TaskState> = new Set(['queued', 'starting', 'running', 'collecting']);

function emptyLedger(): PaperLedger {
  return { version: 1, papers: {}, agents: {}, tasks: {}, runs: {}, spend: {}, reserves: {}, alerts: [] };
}

const TABLES = ['papers', 'agents', 'tasks', 'runs', 'spend', 'reserves'] as const;

function isTable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结构对得上才认：版本是 1、各表都在且形状对。记录内部的字段不逐条校验 */
function isLedger(value: unknown): value is PaperLedger {
  if (!isTable(value)) return false;
  const ledger = value as Record<string, unknown>;
  return ledger.version === 1 && TABLES.every(key => isTable(ledger[key])) && Array.isArray(ledger.alerts);
}

export class LedgerStore {
  data: PaperLedger = emptyLedger();
  /** 账本文件存在但读不出或解析不了（原因）：远端任务一律不开，原文件不覆盖 */
  failure?: string;
  #writing: Promise<void> = Promise.resolve();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: StorageService,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = (await this.storage.readFile(LEDGER_URI, 'utf-8')) as string;
    } catch (err) {
      if (isStorageNotFound(err)) {
        this.logger.debug('白纸账本不存在，从空账本起步');
        return;
      }
      this.fail(`读取失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.fail(`解析失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!isLedger(parsed)) {
      this.fail('结构不对（版本不是 1，或缺少必需的表）');
      return;
    }
    this.data = parsed;
  }

  private fail(reason: string): void {
    this.failure = `白纸账本 ${LEDGER_URI} ${reason}`;
    this.logger.error(`${this.failure}；远端任务一律不开，原文件不覆盖，请人工修复或移走后重启`);
  }

  /** 整份落盘。写按调用顺序排队，每次写出的都是写那一刻的全量；这一次失败则拒绝 */
  save(): Promise<void> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    const run = this.#writing.then(() => this.storage.writeFile(LEDGER_URI, JSON.stringify(this.data, null, 2)));
    this.#writing = run.catch(() => {});
    return run;
  }

  /** 等在途的写完成 */
  flush(): Promise<void> {
    return this.#writing;
  }

  /** 独占执行「读账本、判定、改账本、落盘」这一段，免得并发的受理与取消各自判定后一起越过上限 */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }
}
