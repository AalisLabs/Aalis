// ============================================================
// triggers.ts — 触发源管理：cron / interval / event
//
// scheduler 仍持有 cron 调度的"配置入口" + UI；
// workflow 内部独立持有自己的 cron/interval/event 监听，
// 只与"workflow 定义里的 trigger 字段"配对。
// ============================================================

import type { Context, Logger } from '@aalis/core';
import type { WorkflowDef } from '@aalis/plugin-workflow-api';

// ─── Cron 解析（与 scheduler 同款实现，避免跨包耦合） ───

function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (step > 0) for (let i = min; i <= max; i += step) result.add(i);
    } else if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      for (let i = a; i <= b; i++) result.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n)) result.add(n);
    }
  }
  return result;
}

function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  return (
    parseCronField(minute, 0, 59).has(date.getMinutes()) &&
    parseCronField(hour, 0, 23).has(date.getHours()) &&
    parseCronField(day, 1, 31).has(date.getDate()) &&
    parseCronField(month, 1, 12).has(date.getMonth() + 1) &&
    parseCronField(weekday, 0, 6).has(date.getDay())
  );
}

// ─── 触发管理器 ───

type FireFn = (workflowId: string, source: string, payload?: Record<string, unknown>) => void;

export class TriggerManager {
  private ctx: Context;
  private logger: Logger;
  private fire: FireFn;

  private cronInterval: ReturnType<typeof setInterval> | null = null;
  private intervalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private eventDisposers = new Map<string, () => void>();
  /** workflowId -> trigger 描述（仅用于 cron 巡检） */
  private cronWorkflows = new Map<string, string>();

  constructor(ctx: Context, logger: Logger, fire: FireFn) {
    this.ctx = ctx;
    this.logger = logger;
    this.fire = fire;
  }

  /** 注册一个 workflow 的触发器；幂等，重复注册先 unregister */
  register(def: WorkflowDef): void {
    this.unregister(def.id);
    if (def.enabled === false) return;
    const t = def.trigger;
    switch (t.type) {
      case 'cron':
        this.cronWorkflows.set(def.id, t.expr);
        this.ensureCronLoop();
        break;
      case 'interval': {
        const sec = Math.max(1, Math.floor(t.seconds));
        const timer = setInterval(() => this.fire(def.id, `interval:${sec}s`), sec * 1000);
        this.intervalTimers.set(def.id, timer);
        break;
      }
      case 'event': {
        const evtName = t.event;
        const filter = t.filter ?? {};
        // biome-ignore lint/suspicious/noExplicitAny: 动态事件订阅，事件名不在编译期可知
        const dispose = this.ctx.on(evtName as any, (...args: unknown[]) => {
          if (!matchFilter(args[0], filter)) return;
          this.fire(def.id, `event:${evtName}`, { args });
        });
        this.eventDisposers.set(def.id, dispose);
        break;
      }
      case 'manual':
        // 不注册任何监听
        break;
    }
  }

  unregister(workflowId: string): void {
    this.cronWorkflows.delete(workflowId);
    const t = this.intervalTimers.get(workflowId);
    if (t) {
      clearInterval(t);
      this.intervalTimers.delete(workflowId);
    }
    const d = this.eventDisposers.get(workflowId);
    if (d) {
      d();
      this.eventDisposers.delete(workflowId);
    }
  }

  /** 关闭全部 */
  dispose(): void {
    if (this.cronInterval) clearInterval(this.cronInterval);
    this.cronInterval = null;
    for (const t of this.intervalTimers.values()) clearInterval(t);
    this.intervalTimers.clear();
    for (const d of this.eventDisposers.values()) d();
    this.eventDisposers.clear();
    this.cronWorkflows.clear();
  }

  // ─── cron 主循环：每分钟扫描一次 ───

  private ensureCronLoop(): void {
    if (this.cronInterval) return;
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
    setTimeout(() => {
      this.cronTick();
      this.cronInterval = setInterval(() => this.cronTick(), 60_000);
    }, msToNextMinute);
    this.logger.debug('workflow cron 主循环已启动');
  }

  private cronTick(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    for (const [wfId, expr] of this.cronWorkflows) {
      if (matchesCron(expr, now)) {
        this.fire(wfId, `cron:${expr}`);
      }
    }
  }
}

/**
 * 简单的 filter 匹配：filter 的每个 key 必须在 payload 顶层等值匹配。
 * payload 不是对象时，filter 必须为空才算通过。
 */
function matchFilter(payload: unknown, filter: Record<string, unknown>): boolean {
  const keys = Object.keys(filter);
  if (keys.length === 0) return true;
  if (!payload || typeof payload !== 'object') return false;
  const obj = payload as Record<string, unknown>;
  for (const k of keys) {
    if (obj[k] !== filter[k]) return false;
  }
  return true;
}
