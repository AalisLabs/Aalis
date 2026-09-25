// ============================================================
// @aalis/plugin-cron-engine — 共享 cron 调度引擎
//
// 提供 'cron-engine' 服务：
//   - 多订阅者共享同一个整分钟 tick（避免每个插件各起 setInterval）
//   - 统一处理 cron / 别名 / @every interval 三种表达式
//   - 失败的 handler 仅记录日志、不影响其他订阅者
//
// tick 语义（漂移与休眠）：每轮按「下一个整分钟边界」重排一次 setTimeout，
// 不用 setInterval（其误差会累积，攒够一分钟就整分钟丢触发）。每轮记下已跑过的
// 整分钟 lastTickMinute，下一轮把 (lastTickMinute, 当前整分钟] 之间的每个整分钟
// 各求值一遍，所以定时器晚到（事件循环阻塞、机器休眠唤醒）不丢分钟。
// 落后超过 MAX_CATCHUP_MINUTES 分钟时只回补最近这几分钟，其余分钟明确跳过并 warn 一次
// ——合盖一夜醒来不该把几百分钟的任务一次性全轰出去。
//
// 由 scheduler / workflow 等上层插件在 uses 里声明 cronEngine 后调用 subscribe()。
// ============================================================

import { type CronEngine, type CronSubscribeOptions, cronEngine, type ValidateResult } from '@aalis/api-cron-engine';
import { type BoundOf, definePlugin, lifecycle, logger, provide } from '@aalis/core';
import { matchesCron, validateCronExpr } from '@aalis/util-cron';

interface CronSubscription {
  id: number;
  normalized: string; // 5 字段标准 cron
  handler: () => void | Promise<void>;
  /** 可选 IANA 时区；未设 = 进程本地 */
  timeZone?: string;
}

interface IntervalSubscription {
  id: number;
  timer: ReturnType<typeof setInterval>;
}

const MINUTE_MS = 60_000;
/** 单轮最多回补的整分钟数；超出的分钟明确跳过（并 warn），不做无上限追赶 */
const MAX_CATCHUP_MINUTES = 5;
/** epoch 毫秒向下取整到整分钟（epoch 原点即整分钟，直接取模） */
function floorToMinute(ms: number): number {
  return ms - (ms % MINUTE_MS);
}

const uses = { provide, logger, lifecycle };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-cron-engine',
  displayName: 'Cron 调度引擎',
  subsystem: 'scheduler',
  provides: [cronEngine],
  uses,
  apply(caps) {
    startEngine(caps);
  },
});

function startEngine({ provide, logger, lifecycle }: Caps): void {
  const cronSubs = new Map<number, CronSubscription>();
  const intervalSubs = new Map<number, IntervalSubscription>();
  let nextId = 1;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已求值过的最后一个整分钟（epoch ms）；0 = 主循环还没跑过任何一分钟 */
  let lastTickMinute = 0;

  function ensureCronLoop(): void {
    if (tickTimer) return;
    scheduleNextTick();
    logger.debug('cron-engine 主循环已对齐启动');
  }

  /** 把下一轮 tick 排到下一个整分钟边界（多 20ms 余量，避免边界前一毫秒醒来空转一轮） */
  function scheduleNextTick(): void {
    // 关闭一开始就不再排：清理段清掉的定时器不会被后续一轮重新排出来
    if (lifecycle.closed) return;
    if (tickTimer) return;
    const now = Date.now();
    tickTimer = setTimeout(cronTick, floorToMinute(now) + MINUTE_MS - now + 20);
  }

  function cronTick(): void {
    tickTimer = null;
    const current = floorToMinute(Date.now());
    // 首轮不回补进程启动之前的分钟：只求值当前这一分钟
    if (lastTickMinute === 0) lastTickMinute = current - MINUTE_MS;
    // 墙钟被向后拨（NTP 校正 / 手动改表）：lastTickMinute 会停在未来，
    // 不重锚就会一直静默不触发，直到墙钟追回来
    if (current < lastTickMinute) {
      logger.warn('检测到墙钟回拨，按当前时刻重锚，回拨跨过的分钟不补跑');
      lastTickMinute = current - MINUTE_MS;
    }
    if (current > lastTickMinute) {
      const pending = (current - lastTickMinute) / MINUTE_MS;
      if (pending > MAX_CATCHUP_MINUTES) {
        logger.warn(
          `cron-engine 落后 ${pending} 分钟（事件循环阻塞或机器休眠），只回补最近 ${MAX_CATCHUP_MINUTES} 分钟，跳过 ${pending - MAX_CATCHUP_MINUTES} 分钟`,
        );
        lastTickMinute = current - MAX_CATCHUP_MINUTES * MINUTE_MS;
      }
      for (let m = lastTickMinute + MINUTE_MS; m <= current; m += MINUTE_MS) runMinute(new Date(m));
      lastTickMinute = current;
    }
    scheduleNextTick();
  }

  /** 对某个整分钟求值一遍所有 cron 订阅 */
  function runMinute(minute: Date): void {
    for (const sub of cronSubs.values()) {
      if (matchesCron(sub.normalized, minute, sub.timeZone)) {
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
    subscribe(expr, handler, options?: CronSubscribeOptions) {
      const v = validateCronExpr(expr);
      if (!v.ok) throw new Error(v.reason);
      // 卸载后仍被握着的陈旧服务引用：cron 与 interval 两条通道一律不再建定时器
      // （interval 分支建出的 setInterval 没有任何东西会再清它，会越过卸载一直活着）
      if (lifecycle.closed) {
        logger.warn('cron-engine 已卸载，忽略迟到的 subscribe');
        return () => {};
      }
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
      const normalized = v.normalized;
      const tz = options?.timeZone?.trim() || undefined;
      // 提前验证 tz 可用，薄弱文本验证会静默接受乱填、到了分钟才报
      if (tz) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
        } catch {
          throw new Error(`非法时区: ${tz}`);
        }
      }
      cronSubs.set(id, { id, normalized, handler, timeZone: tz });
      ensureCronLoop();
      return () => {
        cronSubs.delete(id);
      };
    },

    validate(expr): ValidateResult {
      return validateCronExpr(expr);
    },

    nextFireTime(expr, from = new Date(), lookaheadMinutes = 366 * 24 * 60, options?: CronSubscribeOptions) {
      const v = validateCronExpr(expr);
      if (!v.ok) return null;
      if (v.kind === 'interval') {
        return from.getTime() + (v.intervalSeconds ?? 0) * 1000;
      }
      const tz = options?.timeZone?.trim() || undefined;
      const start = new Date(from);
      start.setSeconds(0, 0);
      start.setMinutes(start.getMinutes() + 1); // 下一整分钟起
      for (let i = 0; i < lookaheadMinutes; i++) {
        const candidate = new Date(start.getTime() + i * 60_000);
        if (matchesCron(v.normalized, candidate, tz)) return candidate.getTime();
      }
      return null;
    },
  };

  provide(cronEngine, service);

  lifecycle.onDispose(() => {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;
    for (const s of intervalSubs.values()) clearInterval(s.timer);
    cronSubs.clear();
    intervalSubs.clear();
  });

  logger.info('cron-engine 已就绪');
}
