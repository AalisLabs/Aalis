// ============================================================
// triggers.ts — 触发源管理：cron / interval / once / event
//
// 通过 cron-engine 服务订阅 cron / @every，scheduler 与 workflow
// 共享一个整分钟 tick 与 setInterval；once 用 setTimeout；
// event 经事件总线订阅。所有"周期型"触发器现在都走 cron-engine，
// 不再在本文件里直接 new setInterval。
// ============================================================

import type { CronEngine } from '@aalis/api-cron-engine';
import type { WorkflowDef } from '@aalis/api-workflow';
import type { Events, Logger, ServiceRef } from '@aalis/core';

// event 触发器禁止订阅的内部事件：这些承载会话原文/出站内容，若被 workflow 的 send-message
// 节点转发到任意 sessionId，会构成跨会话内容窃听/外泄通道。只允许订阅编排/信号类事件。
const BLOCKED_EVENT_TRIGGERS = new Set<string>(['inbound:message', 'outbound:message', 'inbound:command']);

/** setTimeout 的 delay 上限（32 位有符号毫秒，约 24.8 天）；超过即溢出成立即触发 */
const MAX_ONCE_TIMEOUT_MS = 2 ** 31 - 1;

// ─── 触发管理器 ───

type FireFn = (workflowId: string, source: string, payload?: Record<string, unknown>) => void;

/**
 * once 触发记账（由 RunStore 实现，落在运行历史同一份持久化里）。
 *
 * once 的语义：**一生只触发一次**——触发即记下 firedAt，此后重启进程、重新注册、
 * 重复 workflow_define 都不再触发；只有删除该 workflow 才清账（同 id 重建算新工作流）。
 * 记账读不出时（onceLedgerReadable 为 false）无从判断是否触发过，本次运行不安排任何 once。
 */
interface OnceLedger {
  onceLedgerReadable(): boolean;
  onceFiredAt(workflowId: string): number | undefined;
  markOnceFired(workflowId: string): void;
}

/** 触发器登记用到的能力：cron / interval 经 cron-engine 订阅，event 触发器订阅事件总线。 */
export interface TriggerCaps {
  cronEngine: ServiceRef<CronEngine>;
  events: Events;
  logger: Logger;
}

export class TriggerManager {
  private cronEngine: ServiceRef<CronEngine>;
  private events: Events;
  private logger: Logger;
  private fire: FireFn;
  private once: OnceLedger;

  private cronDisposers = new Map<string, () => void>();
  private onceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventDisposers = new Map<string, () => void>();

  constructor(caps: TriggerCaps, fire: FireFn, once: OnceLedger) {
    this.cronEngine = caps.cronEngine;
    this.events = caps.events;
    this.logger = caps.logger;
    this.fire = fire;
    this.once = once;
  }

  /** 注册一个 workflow 的触发器；幂等，重复注册先 unregister */
  register(def: WorkflowDef): void {
    this.unregister(def.id);
    if (def.enabled === false) return;
    const t = def.trigger;
    switch (t.type) {
      case 'cron': {
        try {
          const dispose = this.cronEngine.require().subscribe(t.expr, () => {
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
          const dispose = this.cronEngine.require().subscribe(expr, () => {
            this.fire(def.id, `interval:${sec}s`);
          });
          this.cronDisposers.set(def.id, dispose);
        } catch (err) {
          this.logger.warn(`workflow ${def.id} interval 订阅失败: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case 'once': {
        // 记账读不出时「从未触发过」无从判断：宁可这次不触发，也不重放已触发过的一次性工作流
        if (!this.once.onceLedgerReadable()) {
          this.logger.warn(
            `workflow ${def.id} 的 once 记账读取失败，本次运行不安排触发（避免重放已触发过的一次性工作流）；修复 runsFile 后重启，或用 workflow_run 手动执行`,
          );
          break;
        }
        // 已有 firedAt 记账 = 这个 once 用过了，注册时直接跳过（重启/重注册都不重跑）。
        // 这道闸只是省掉一个空转 timer，正确性由 fireOnce 的记账兜。
        const firedAt = this.once.onceFiredAt(def.id);
        if (firedAt !== undefined) {
          this.logger.info(
            `workflow ${def.id} 的 once 触发器已于 ${new Date(firedAt).toISOString()} 触发过，本次注册跳过（once 一生只触发一次）`,
          );
          break;
        }
        const targetMs = Date.parse(t.runAt);
        if (!Number.isFinite(targetMs)) {
          this.logger.warn(`workflow ${def.id} once.runAt 无法解析: ${t.runAt}`);
          break;
        }
        // 记账后再触发：这道闸同时挡住同 tick 内重复注册各排一次 setImmediate 的重复触发
        const fireOnce = () => {
          if (this.once.onceFiredAt(def.id) !== undefined) return;
          this.once.markOnceFired(def.id);
          this.fire(def.id, `once:${t.runAt}`);
        };
        const delay = targetMs - Date.now();
        if (delay <= 0) {
          // runAt 已过且从未触发过：注册时立即补触发一次
          setImmediate(fireOnce);
        } else {
          // 远期 runAt 分段重排：setTimeout 的 delay 超过 2^31-1ms（约 24.8 天）会溢出成
          // 立即触发，把"一个月后跑"变成"现在就跑"。每段最多排到上限，段末若离 runAt 还有
          // 1s 以上就续排下一段、不记账，直到真正到点才 fireOnce。
          const arm = (wait: number) => {
            const timer = setTimeout(() => {
              const remain = targetMs - Date.now();
              if (remain > 1000) {
                arm(Math.min(remain, MAX_ONCE_TIMEOUT_MS));
                return;
              }
              this.onceTimers.delete(def.id);
              fireOnce();
            }, wait);
            this.onceTimers.set(def.id, timer);
          };
          arm(Math.min(delay, MAX_ONCE_TIMEOUT_MS));
        }
        break;
      }
      case 'event': {
        const evtName = t.event;
        if (BLOCKED_EVENT_TRIGGERS.has(evtName)) {
          this.logger.warn(
            `workflow "${def.id}" 的 event 触发器订阅了受限内部事件 "${evtName}"（承载会话内容，防跨会话外泄），已拒绝注册`,
          );
          break;
        }
        const filter = t.filter ?? {};
        // biome-ignore lint/suspicious/noExplicitAny: 动态事件订阅，事件名不在编译期可知
        const dispose = this.events.on(evtName as any, (...args: unknown[]) => {
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
