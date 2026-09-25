// ============================================================
// persistence.ts — 运行实例持久化（追加 + 滚动）+ once 触发记账
//
// 通过 @aalis/api-storage 写入 storage URI（默认 data:/workflow-runs.json）。
// 仍维持 write-on-end 整体重写策略；写入串行化避免覆盖。
// 文件形状：{ runs: [...], onceFired: { <workflowId>: <firedAt> } }。
// ============================================================

import { isStorageNotFound, type StorageService } from '@aalis/api-storage';
import type { WorkflowRun } from '@aalis/api-workflow';
import type { Logger } from '@aalis/core';

export class RunStore {
  private storage: StorageService;
  private fileUri: string;
  private maxRuns: number;
  private logger: Logger;
  private runs: WorkflowRun[] = [];
  /** once 触发记账：workflowId → 首次触发时刻（ms）。与运行历史同文件，重启后读回即不再触发 */
  private onceFired: Record<string, number> = {};
  private writeChain: Promise<void> = Promise.resolve();
  /**
   * init 读失败且不是「文件不存在」（storage 不在场、读错误、解析失败、结构不对）：写的是整份快照，
   * 此后一律拒写，否则第一次运行就用空的 once 记账覆盖文件，下次启动过期 once 全部重放。
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
      const data = JSON.parse(String(raw)) as { runs?: unknown; onceFired?: unknown } | null;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('顶层不是 JSON 对象');
      if (data.runs !== undefined && !Array.isArray(data.runs)) throw new Error('runs 不是数组');
      const fired = data.onceFired;
      if (fired !== undefined && (!fired || typeof fired !== 'object' || Array.isArray(fired))) {
        throw new Error('onceFired 不是对象');
      }
      if (data.runs) this.runs = data.runs as WorkflowRun[];
      for (const [id, at] of Object.entries((fired ?? {}) as Record<string, unknown>)) {
        if (typeof at === 'number') this.onceFired[id] = at;
      }
    } catch (err) {
      this.loadFailed = true;
      this.logger.warn(`解析运行历史失败，本次运行不再写入该文件: ${err}`);
    }
  }

  /** once 记账是否可信：init 读失败时记账为空，据它安排 once 会重放已触发过的一次性工作流 */
  onceLedgerReadable(): boolean {
    return !this.loadFailed;
  }

  /** 等到目前为止排队的写入全部落盘（dispose 时调用：否则 app.stop() 返回后还有写入在飞）。 */
  flushed(): Promise<void> {
    return this.writeChain;
  }

  private flush(): void {
    if (this.loadFailed) return; // init 时已 warn 过
    const payload = JSON.stringify({ runs: this.runs, onceFired: this.onceFired }, null, 2);
    this.writeChain = this.writeChain
      .then(() => this.storage.writeFile(this.fileUri, payload))
      .then(
        () => undefined,
        err => {
          this.logger.warn(`写入运行历史失败: ${err}`);
        },
      );
  }

  /** 加入一条新 run（push）；超过 maxRuns 则裁剪最旧的 */
  add(run: WorkflowRun): void {
    this.runs.push(run);
    if (this.runs.length > this.maxRuns) {
      this.runs = this.runs.slice(-this.maxRuns);
    }
    this.flush();
  }

  /** 替换已存在的 run（按 runId）；用于运行结束时整体更新状态 */
  update(run: WorkflowRun): void {
    const i = this.runs.findIndex(r => r.runId === run.runId);
    if (i >= 0) this.runs[i] = run;
    else this.runs.push(run);
    this.flush();
  }

  /** once 触发器的首次触发时刻；undefined = 从未触发过 */
  onceFiredAt(workflowId: string): number | undefined {
    return this.onceFired[workflowId];
  }

  /** 记下 once 已触发（幂等：已有记账不覆盖、不重复落盘） */
  markOnceFired(workflowId: string): void {
    if (this.onceFired[workflowId] !== undefined) return;
    this.onceFired[workflowId] = Date.now();
    this.flush();
  }

  /** 删除 workflow 时一并清账：同 id 重建视为新工作流，可再触发一次 */
  clearOnceFired(workflowId: string): void {
    if (this.onceFired[workflowId] === undefined) return;
    delete this.onceFired[workflowId];
    this.flush();
  }

  /**
   * 按现存定义集清账：不在 ids 里的 workflowId 记账一并删除。
   * removeWorkflow 之外还有一条路能让定义消失——直接删 defsDir 里的 yaml 文件，
   * 那条路不经服务、清不了账，同 id 重建就会被旧记账永久压住。
   * 启动扫描完定义后调一次，语义收敛为「定义不存在时记账随之清除」。
   */
  pruneOnceFired(ids: Set<string>): void {
    let changed = false;
    for (const id of Object.keys(this.onceFired)) {
      if (ids.has(id)) continue;
      delete this.onceFired[id];
      changed = true;
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
