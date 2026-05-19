// ============================================================
// @aalis/plugin-cron-engine — 共享 cron 调度引擎
//
// 提供 'cron-engine' 服务：
//   - 多订阅者共享同一个整分钟 tick（避免每个插件各起 setInterval）
//   - 统一处理 cron / 别名 / @every interval 三种表达式
//   - 失败的 handler 仅记录日志、不影响其他订阅者
//
// 由 scheduler / workflow 等上层插件 inject.required 后调用 subscribe()。
// ============================================================

import type { Context } from '@aalis/core';
import {
  type CronEngine,
  matchesCron,
  normalizeCronExpr,
  type ValidateResult,
  validateCronExpr,
} from '@aalis/plugin-cron-engine-api';

export const name = '@aalis/plugin-cron-engine';
export const displayName = 'Cron 调度引擎';
export const subsystem = 'scheduler';
export const provides = ['cron-engine'];

interface CronSubscription {
  id: number;
  normalized: string; // 5 字段标准 cron
  handler: () => void | Promise<void>;
}

interface IntervalSubscription {
  id: number;
  timer: ReturnType<typeof setInterval>;
}

export function apply(ctx: Context): void {
  const logger = ctx.logger;
  const cronSubs = new Map<number, CronSubscription>();
  const intervalSubs = new Map<number, IntervalSubscription>();
  let nextId = 1;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let alignTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureCronLoop(): void {
    if (tickTimer || alignTimer) return;
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    alignTimer = setTimeout(() => {
      alignTimer = null;
      cronTick();
      tickTimer = setInterval(cronTick, 60_000);
    }, msToNextMinute);
    logger.debug('cron-engine 主循环已对齐启动');
  }

  function cronTick(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    for (const sub of cronSubs.values()) {
      if (matchesCron(sub.normalized, now)) {
        try {
          const r = sub.handler();
          if (r instanceof Promise) {
            r.catch(err => logger.error(`cron handler (id=${sub.id}, expr="${sub.normalized}") 异步异常:`, err));
          }
        } catch (err) {
          logger.error(`cron handler (id=${sub.id}, expr="${sub.normalized}") 同步异常:`, err);
        }
      }
    }
  }

  const service: CronEngine = {
    subscribe(expr, handler) {
      const v = validateCronExpr(expr);
      if (!v.ok) throw new Error(v.reason);
      const id = nextId++;
      if (v.kind === 'interval') {
        const ms = (v.intervalSeconds ?? 0) * 1000;
        const timer = setInterval(() => {
          try {
            const r = handler();
            if (r instanceof Promise) {
              r.catch(err => logger.error(`interval handler (id=${id}, expr="${expr}") 异步异常:`, err));
            }
          } catch (err) {
            logger.error(`interval handler (id=${id}, expr="${expr}") 同步异常:`, err);
          }
        }, ms);
        intervalSubs.set(id, { id, timer });
        return () => {
          const s = intervalSubs.get(id);
          if (!s) return;
          clearInterval(s.timer);
          intervalSubs.delete(id);
        };
      }
      // cron
      const normalized = normalizeCronExpr(expr);
      if (!normalized) throw new Error(`非法 cron 表达式: ${expr}`);
      cronSubs.set(id, { id, normalized, handler });
      ensureCronLoop();
      return () => {
        cronSubs.delete(id);
      };
    },

    validate(expr): ValidateResult {
      return validateCronExpr(expr);
    },

    nextFireTime(expr, from = new Date(), lookaheadMinutes = 366 * 24 * 60) {
      const v = validateCronExpr(expr);
      if (!v.ok) return null;
      if (v.kind === 'interval') {
        return from.getTime() + (v.intervalSeconds ?? 0) * 1000;
      }
      const start = new Date(from);
      start.setSeconds(0, 0);
      start.setMinutes(start.getMinutes() + 1); // 下一整分钟起
      for (let i = 0; i < lookaheadMinutes; i++) {
        const candidate = new Date(start.getTime() + i * 60_000);
        if (matchesCron(v.normalized, candidate)) return candidate.getTime();
      }
      return null;
    },
  };

  ctx.provide('cron-engine', service);

  ctx.onDispose(() => {
    if (tickTimer) clearInterval(tickTimer);
    if (alignTimer) clearTimeout(alignTimer);
    for (const s of intervalSubs.values()) clearInterval(s.timer);
    cronSubs.clear();
    intervalSubs.clear();
  });

  logger.info('cron-engine 已就绪');
}
