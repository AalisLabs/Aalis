// ============================================================
// persistence.ts — 运行实例持久化（追加 + 滚动）+ once 触发记录 + 定义者记录
//
// 通过 @aalis/api-storage 写入 storage URI（默认 data:/workflow-runs.json）。
// 仍维持 write-on-end 整体重写策略；写入串行化避免覆盖。
// 文件形状：{ runs: [...], onceFired: { <workflowId>: <firedAt> },
//           definers: { <workflowId>: { platform, userId, sha256 } } }。
// ============================================================

import type { UserIdentity } from '@aalis/api-authority';
import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { WorkflowRun } from '@aalis/api-workflow';
import type { Logger } from '@aalis/core';
import { t } from './texts.js';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class RunStore {
  private storage: StorageService;
  private fileUri: string;
  private maxRuns: number;
  private logger: Logger;
  private runs: WorkflowRun[] = [];
  /** once 触发记录：workflowId → 首次触发时刻（ms）。与运行历史同文件，重启后读回即不再触发 */
  private onceFired: Record<string, number> = {};
  /**
   * 定义者记录：workflowId → 定义者与写进定义文件的那份文本的哈希。不放进定义文件：工作区能被别的工具写，写在文件里的
   * 定义者伪造得出来。与运行历史同文件，读不出时没有定义者
   */
  private definers: Record<string, UserIdentity & { sha256: string }> = {};
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * init 读失败且不是「文件不存在」（读错误、解析失败、结构不对）：写的是整份快照，
   * 此后一律拒写，否则第一次运行就用空的 once 记录覆盖文件，下次启动过期 once 全部重放。
   */
  private loadFailed = false;

  constructor(storage: StorageService, fileUri: string, maxRuns: number, logger: Logger) {
    this.storage = storage;
    this.fileUri = fileUri;
    this.maxRuns = Math.max(10, maxRuns);
    this.logger = logger;
  }

  /** 初始化时从存储加载历史；文件不存在视为空，其它失败本次运行拒写。 */
  async init(): Promise<void> {
    let raw: string | Buffer;
    try {
      raw = await this.storage.readFile(this.fileUri, 'utf-8');
    } catch (err) {
      if (isStorageNotFound(err)) return;
      this.loadFailed = true;
      this.logger.warn(`读取运行历史失败，本次运行不再写入该文件: ${err}`);
      return;
    }
    // 解析与结构校验单独一段：解析报错的文案（会带上短文件原文）不能进「不存在」判据
    try {
      const data: unknown = JSON.parse(String(raw));
      if (!isObject(data)) throw new Error('顶层不是 JSON 对象');
      if (data.runs !== undefined && !Array.isArray(data.runs)) throw new Error('runs 不是数组');
      const { onceFired = {}, definers = {} } = data;
      if (!isObject(onceFired)) throw new Error('onceFired 不是对象');
      if (!isObject(definers)) throw new Error('definers 不是对象');
      if (data.runs) this.runs = data.runs as WorkflowRun[];
      // 还在「运行中」的是进程没有正常退出时留下的（停机会中止在跑的、等它们收尾）：收口成已取消，与停机打断的同一状态；
      // 不知道停在何时，不写结束时刻。节点与引擎取消时同样收：在跑的记失败、等着的记跳过
      for (const run of this.runs) {
        if (run.status !== 'running') continue;
        run.status = 'cancelled';
        run.error = t('interruptedByExit');
        for (const node of run.nodes) {
          if (node.status === 'pending') node.status = 'skipped';
          if (node.status !== 'running') continue;
          node.status = 'failed';
          node.error = t('interruptedByExit');
        }
      }
      for (const [id, at] of Object.entries(onceFired)) {
        if (typeof at === 'number') this.onceFired[id] = at;
      }
      for (const [id, entry] of Object.entries(definers)) {
        if (isObject(entry) && filled(entry.platform) && filled(entry.userId) && filled(entry.sha256)) {
          this.definers[id] = { platform: entry.platform, userId: entry.userId, sha256: entry.sha256 };
        }
      }
    } catch (err) {
      this.loadFailed = true;
      this.logger.warn(`解析运行历史失败，本次运行不再写入该文件: ${err}`);
    }
  }

  /** once 记录是否可信：init 读失败时记录为空，据它安排 once 会重放已触发过的一次性工作流 */
  onceLedgerReadable(): boolean {
    return !this.loadFailed;
  }

  /** 等到目前为止排队的写入全部落盘（dispose 时调用：否则 app.stop() 返回后还有写入在飞）。 */
  flushed(): Promise<void> {
    return this.writeChain;
  }

  private flush(): void {
    if (this.loadFailed) return; // init 时已 warn 过
    const payload = JSON.stringify({ runs: this.runs, onceFired: this.onceFired, definers: this.definers }, null, 2);
    this.writeChain = this.writeChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => undefined,
        err => {
          this.logger.warn(`写入运行历史失败: ${err}`);
        },
      );
  }

  /** 加入一条新 run（push）；超过 maxRuns 则裁剪最旧的已结束的：在跑的留着，收尾时照常更新，工作流页上也还取消得了 */
  add(run: WorkflowRun): void {
    this.runs.push(run);
    let excess = this.runs.length - this.maxRuns;
    if (excess > 0) this.runs = this.runs.filter(r => r.status === 'running' || excess-- <= 0);
    this.flush();
  }

  /** 替换已存在的 run（按 runId），运行结束时整体更新状态：在跑的不会被裁，收尾时总找得到 */
  update(run: WorkflowRun): void {
    const i = this.runs.findIndex(r => r.runId === run.runId);
    if (i >= 0) this.runs[i] = run;
    this.flush();
  }

  /** once 触发器的首次触发时刻；undefined = 从未触发过 */
  onceFiredAt(workflowId: string): number | undefined {
    return this.onceFired[workflowId];
  }

  /** 记下 once 已触发（幂等：已有记录不覆盖、不重复落盘） */
  markOnceFired(workflowId: string): void {
    if (this.onceFired[workflowId] !== undefined) return;
    this.onceFired[workflowId] = Date.now();
    this.flush();
  }

  /** 定义文件这份文本的定义者：记录里的哈希对得上才有，手写的、被改过的与没有记录的都没有 */
  definerOf(workflowId: string, sha256: string): UserIdentity | undefined {
    const entry = this.definers[workflowId];
    return entry?.sha256 === sha256 ? { platform: entry.platform, userId: entry.userId } : undefined;
  }

  /** 记下写进定义文件的这份文本的定义者；匿名定义的清掉这一条，不留覆盖之前的定义者 */
  recordDefiner(workflowId: string, definer: UserIdentity | undefined, sha256: string): void {
    if (!definer && !this.definers[workflowId]) return;
    if (definer) this.definers[workflowId] = { platform: definer.platform, userId: definer.userId, sha256 };
    else delete this.definers[workflowId];
    this.flush();
  }

  /** 删除 workflow 时一并清掉记录：同 id 重建视为新工作流，可再触发一次 once，也没有原来的定义者 */
  forget(workflowId: string): void {
    if (this.onceFired[workflowId] === undefined && this.definers[workflowId] === undefined) return;
    delete this.onceFired[workflowId];
    delete this.definers[workflowId];
    this.flush();
  }

  /**
   * 按现存定义集清掉记录：不在 ids 里的 workflowId 的 once 记录与定义者一并删除。
   * removeWorkflow 之外还有一条路能让定义消失——直接删 defsDir 里的 yaml 文件，
   * 那条路不经服务、清不掉记录，同 id 重建就会被旧记录永久压住，写回同样的文本还会认回原来的定义者。
   * 启动扫描完定义后调一次，语义收敛为「定义不存在时记录随之清除」。
   */
  prune(ids: Set<string>): void {
    let changed = false;
    for (const ledger of [this.onceFired, this.definers]) {
      for (const id of Object.keys(ledger)) {
        if (ids.has(id)) continue;
        delete ledger[id];
        changed = true;
      }
    }
    if (changed) this.flush();
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.find(r => r.runId === runId);
  }

  list(limit?: number, workflowId?: string): WorkflowRun[] {
    let arr = workflowId ? this.runs.filter(r => r.workflowId === workflowId) : this.runs;
    arr = [...arr].sort((a, b) => b.startedAt - a.startedAt);
    if (limit && limit > 0) arr = arr.slice(0, limit);
    return arr;
  }
}
