// ============================================================
// persistence.ts — 运行实例持久化（追加 + 滚动）
//
// 写入 data/workflow-runs.json 为数组，包含最近 N 条运行。
// 只在每次 run 完成 / 失败时整体重写（write-on-end），频次低，简单可靠。
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Logger } from '@aalis/core';
import type { WorkflowRun } from '@aalis/plugin-workflow-api';

export class RunStore {
  private file: string;
  private maxRuns: number;
  private logger: Logger;
  private runs: WorkflowRun[] = [];

  constructor(file: string, maxRuns: number, logger: Logger) {
    this.file = resolve(file);
    this.maxRuns = Math.max(10, maxRuns);
    this.logger = logger;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, 'utf-8'));
      if (Array.isArray(data)) this.runs = data as WorkflowRun[];
    } catch (err) {
      this.logger.warn(`加载运行历史失败: ${err}`);
    }
  }

  private flush(): void {
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.runs, null, 2), 'utf-8');
    } catch (err) {
      this.logger.warn(`写入运行历史失败: ${err}`);
    }
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
