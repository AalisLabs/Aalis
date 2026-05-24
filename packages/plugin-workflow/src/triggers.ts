// ============================================================
// triggers.ts — 触发源管理：cron / interval / once / event
//
// 通过 cron-engine 服务订阅 cron / @every，scheduler 与 workflow
// 共享一个整分钟 tick 与 setInterval；once 用 setTimeout；
// event 通过 ctx.on 订阅。所有"周期型"触发器现在都走 cron-engine，
// 不再在本文件里直接 new setInterval。
// ============================================================

import type { Context, Logger } from '@aalis/core';
import { useCronEngine } from '@aalis/plugin-cron-engine-api';
import type { WorkflowDef } from '@aalis/plugin-workflow-api';

// ─── 触发管理器 ───

type FireFn = (workflowId: string, source: string, payload?: Record<string, unknown>) => void;

export class TriggerManager {
  private ctx: Context;
  private logger: Logger;
  private fire: FireFn;

  private cronDisposers = new Map<string, () => void>();
  private onceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventDisposers = new Map<string, () => void>();

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
      case 'cron': {
        try {
          const dispose = useCronEngine(this.ctx).subscribe(t.expr, () => {
            this.fire(def.id, `cron:${t.expr}`);
          });
          this.cronDisposers.set(def.id, dispose);
        } catch (err) {
          this.logger.warn(`workflow ${def.id} cron 订阅失败: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case 'interval': {
        // 改为委托 cron-engine 的 @every Ns 表达式，避免与 scheduler 维护两份 setInterval 实现。
        const sec = Math.max(1, Math.floor(t.seconds));
        const expr = `@every ${sec}s`;
        try {
          const dispose = useCronEngine(this.ctx).subscribe(expr, () => {
            this.fire(def.id, `interval:${sec}s`);
          });
          this.cronDisposers.set(def.id, dispose);
        } catch (err) {
          this.logger.warn(`workflow ${def.id} interval 订阅失败: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case 'once': {
        const targetMs = Date.parse(t.runAt);
        if (!Number.isFinite(targetMs)) {
          this.logger.warn(`workflow ${def.id} once.runAt 无法解析: ${t.runAt}`);
          break;
        }
        const delay = targetMs - Date.now();
        if (delay <= 0) {
          setImmediate(() => this.fire(def.id, `once:${t.runAt}`));
        } else {
          const timer = setTimeout(() => {
            this.onceTimers.delete(def.id);
            this.fire(def.id, `once:${t.runAt}`);
          }, delay);
          this.onceTimers.set(def.id, timer);
        }
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
    const cd = this.cronDisposers.get(workflowId);
    if (cd) {
      cd();
      this.cronDisposers.delete(workflowId);
    }
    const ot = this.onceTimers.get(workflowId);
    if (ot) {
      clearTimeout(ot);
      this.onceTimers.delete(workflowId);
    }
    const d = this.eventDisposers.get(workflowId);
    if (d) {
      d();
      this.eventDisposers.delete(workflowId);
    }
  }

  /** 关闭全部 */
  dispose(): void {
    for (const d of this.cronDisposers.values()) d();
    this.cronDisposers.clear();
    for (const ot of this.onceTimers.values()) clearTimeout(ot);
    this.onceTimers.clear();
    for (const d of this.eventDisposers.values()) d();
    this.eventDisposers.clear();
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
