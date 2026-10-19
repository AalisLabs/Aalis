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
import type { Events, Logger, ServiceSelection } from '@aalis/core';

// event 触发器不订阅的事件：负载带会话内容。编排按定义者的身份运行，事件参数作为运行变量插值进 tool 节点的参数、agent 节点
// 的指令与 send-message 的正文，内容里不可信的部分就以定义者的身份下达；转发到任意 sessionId，又是跨会话窃听与外泄的通道。
// 第一方声明的每个事件在这里或 test/architecture/event-trigger-sources.test.ts 的可作触发源表里表态。
export const BLOCKED_EVENT_TRIGGERS: ReadonlySet<string> = new Set([
  // 消息与回复
  'inbound:message',
  'inbound:message:archived',
  'assistant:message:archived',
  'outbound:message',
  'outbound:delivered',
  'outbound:stream',
  // 工具调用的参数、结果与输出
  'tool:execute',
  'tool:output',
  'background:changed',
  // 审批的命令、改动与参数
  'approval:created',
  'approval:settled',
  // 附件的识别结果
  'media:processed',
  // 待办的内容
  'todo:updated',
  // 会话档案：名称（群名、昵称）、标题、子任务的指令与结果
  'session:created',
  'session:updated',
  'session:completed',
  // 编排：trigger:fired 的负载（定时任务的内容等），运行的变量与节点输出
  'trigger:fired',
  'workflow:run:start',
  'workflow:run:done',
  'workflow:run:error',
  'workflow:node:done',
]);

/** setTimeout 的 delay 上限（32 位有符号毫秒，约 24.8 天）；超过即溢出成立即触发 */
const MAX_ONCE_TIMEOUT_MS = 2 ** 31 - 1;

// ─── 触发管理器 ───

type FireFn = (workflowId: string, source: string, payload?: Record<string, unknown>) => void;

/**
 * once 触发记录（由 RunStore 实现，落在运行历史同一份持久化里）。
 *
 * once 的语义：**一生只触发一次**——触发即记下 firedAt，此后重启进程、重新注册、
 * 重复 workflow_define 都不再触发；只有删除该 workflow 才清掉记录（同 id 重建算新工作流）。
 * 记录读不出时（onceLedgerReadable 为 false）无从判断是否触发过，本次运行不安排任何 once。
 */
interface OnceLedger {
  onceLedgerReadable(): boolean;
  onceFiredAt(workflowId: string): number | undefined;
  markOnceFired(workflowId: string): void;
}

/** 触发器登记用到的能力：cron / interval 经 cron-engine 订阅，event 触发器订阅事件总线。 */
export interface TriggerCaps {
  cronEngine: ServiceSelection<CronEngine>;
  events: Events;
  logger: Logger;
}

export class TriggerManager {
  private cronEngine: ServiceSelection<CronEngine>;
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
          const dispose = this.cronEngine.use.subscribe(t.expr, () => {
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
          const dispose = this.cronEngine.use.subscribe(expr, () => {
            this.fire(def.id, `interval:${sec}s`);
          });
          this.cronDisposers.set(def.id, dispose);
        } catch (err) {
          this.logger.warn(`workflow ${def.id} interval 订阅失败: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
      case 'once': {
        // 记录读不出时「从未触发过」无从判断：宁可这次不触发，也不重放已触发过的一次性工作流
        if (!this.once.onceLedgerReadable()) {
          this.logger.warn(
            `workflow ${def.id} 的 once 记录读取失败，本次运行不安排触发（避免重放已触发过的一次性工作流）；修复 runsFile 后重启，或用 workflow_run 手动执行`,
          );
          break;
        }
        // 已有 firedAt 记录 = 这个 once 用过了，注册时直接跳过（重启/重注册都不重跑）。
        // 这道闸只是省掉一个空转 timer，正确性由 fireOnce 的记录兜。
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
        // 先记录再触发；已有记录的不再触发
        const fireOnce = () => {
          if (this.once.onceFiredAt(def.id) !== undefined) return;
          this.once.markOnceFired(def.id);
          this.fire(def.id, `once:${t.runAt}`);
        };
        // runAt 已过的排 0ms，下一轮定时器就补触发（负数延迟会引来运行时告警）；与远期的同记在 onceTimers，
        // unregister / dispose 一并撤掉。
        // 远期 runAt 分段重排：setTimeout 的 delay 超过 2^31-1ms（约 24.8 天）会溢出成立即触发，把"一个月后跑"变成
        // "现在就跑"。每段最多排到上限，段末若离 runAt 还有 1s 以上就续排下一段、不记录，直到真正到点才 fireOnce。
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
        arm(Math.max(0, Math.min(targetMs - Date.now(), MAX_ONCE_TIMEOUT_MS)));
        break;
      }
      case 'event': {
        const evtName = t.event;
        if (BLOCKED_EVENT_TRIGGERS.has(evtName)) {
          this.logger.warn(
            `workflow "${def.id}" 的 event 触发器订阅的 "${evtName}" 负载带会话内容，不能当触发源，已拒绝注册`,
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
