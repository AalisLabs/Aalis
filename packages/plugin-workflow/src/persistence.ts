// ============================================================
// persistence.ts — 运行实例持久化（追加 + 滚动）
//
// 通过 @aalis/plugin-storage-api 写入 storage URI（默认 data:/workflow-runs.json）。
// 仍维持 write-on-end 整体重写策略；写入串行化避免覆盖。
// ============================================================

import type { Logger } from '@aalis/core';
import type { StorageService } from '@aalis/plugin-storage-api';
import type { WorkflowRun } from '@aalis/plugin-workflow-api';

export class RunStore {
  private storage: StorageService;
  private fileUri: string;
  private maxRuns: number;
  private logger: Logger;
  private runs: WorkflowRun[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storage: StorageService, fileUri: string, maxRuns: number, logger: Logger) {
    this.storage = storage;
    this.fileUri = fileUri;
    this.maxRuns = Math.max(10, maxRuns);
    this.logger = logger;
  }

  /** 初始化时从存储加载历史；ENOENT 等情况视为空。 */
  async init(): Promise<void> {
    try {
      const raw = await this.storage.readFile(this.fileUri, 'utf-8');
      const data = JSON.parse(String(raw));
      if (Array.isArray(data)) this.runs = data as WorkflowRun[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ENOENT|not found|不存在/i.test(msg)) {
        this.logger.warn(`加载运行历史失败: ${err}`);
      }
    }
  }

  private flush(): void {
    const payload = JSON.stringify(this.runs, null, 2);
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
