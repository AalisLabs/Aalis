import { App, type LogEntry, LogHub } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CronEngine } from '../../packages/api-cron-engine/src/index.js';
import * as cronEngineModule from '../../packages/plugin-cron-engine/src/index.js';

// ════════════════════════════════════════════════════════════
// cron-engine 主循环：整分钟边界重排 + 回补
//
// 旧实现是「对齐一次 setTimeout + setInterval(60_000)」：interval 的误差会累积，
// 攒够一分钟就整分钟丢触发；tick 晚到（事件循环阻塞 / 机器休眠唤醒）时也只求值
// 当前这一分钟，中间的分钟静默消失（"每天 02:00 备份"那一分钟就这么没了）。
//
// 现语义：每轮按下一个整分钟边界重排 setTimeout；tick 时把
// (lastTickMinute, 当前整分钟] 之间每个整分钟各求值一遍；落后超过 5 分钟只回补
// 最近 5 分钟并 warn 一次说明跳过了多少分钟。
//
// 测法：真插件 + 真 setTimeout 队列（vitest 假定时器），墙上时钟单独用 Date.now
// spy 驱动——这样才能造出「定时器比墙上时钟晚到」这种漂移/休眠场景（假定时器的
// setSystemTime 会连带平移定时器，造不出偏差）。
// ════════════════════════════════════════════════════════════

/** 本地 2026-01-01 00:00:00.000，整分钟对齐 */
const T0 = new Date(2026, 0, 1, 0, 0, 0, 0).getTime();
const MIN = 60_000;

interface Harness {
  app: App;
  engine: CronEngine;
  /** 设定「墙上时钟」（tick 里 Date.now() 的返回值） */
  setWall(ms: number): void;
  /** 把墙上时钟设到 ms，然后触发当前排着的那一轮 tick */
  fireTickAt(ms: number): void;
  /** 把墙上时钟设到 ms，然后只推进虚拟定时器 delay 毫秒（用于验证重排的间隔） */
  advanceAt(ms: number, delay: number): void;
  warns: string[];
}

async function withEngine(startWall: number, fn: (h: Harness) => Promise<void> | void): Promise<void> {
  const hub = new LogHub();
  const warns: string[] = [];
  const off = hub.onEntry((e: LogEntry) => {
    if (e.level === 'warn') warns.push(e.message);
  });
  const app = new App({ config: { name: 'T', logLevel: 'warn', plugins: {} }, logHub: hub });
  await app.ctx.useModule(cronEngineModule as never, {});
  await app.start();
  let wall = startWall;
  // 只假定时器 API：Date 留给下面的 spy 单独控制（setInterval 也假，@every 通道才数得出定时器）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  const setWall = (ms: number) => {
    wall = ms;
  };
  try {
    await fn({
      app,
      engine: app.ctx.getService<CronEngine>('cron-engine') as CronEngine,
      setWall,
      fireTickAt(ms) {
        setWall(ms);
        vi.runOnlyPendingTimers();
      },
      advanceAt(ms, delay) {
        setWall(ms);
        vi.advanceTimersByTime(delay);
      },
      warns,
    });
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await app.stop().catch(() => {});
    off();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cron-engine 整分钟 tick', () => {
  it('tick 晚到不丢分钟：(上次, 当前] 每个整分钟各求值一遍', async () => {
    await withEngine(T0 + 5_000, async h => {
      let everyMinute = 0;
      let minute02 = 0;
      h.engine.subscribe('* * * * *', () => {
        everyMinute++;
      });
      h.engine.subscribe('2 * * * *', () => {
        minute02++;
      });
      // 第一轮按点到：只求值当前这一分钟（不回补启动之前）
      h.fireTickAt(T0 + MIN + 5);
      expect(everyMinute).toBe(1);
      expect(minute02).toBe(0);

      // 第二轮晚到：本该 00:02 醒，实际 00:03:00.700 才醒
      h.fireTickAt(T0 + 3 * MIN + 700);
      expect(minute02, '晚到的 tick 把 00:02 这一分钟整个跳过了').toBe(1);
      expect(everyMinute, '应补跑 00:02 与 00:03 两分钟').toBe(3);

      // 下一轮按「下一个整分钟边界」重排（此刻离 00:04 只剩 59.3s），不是固定 60s
      h.advanceAt(T0 + 4 * MIN + 20, MIN - 700 + 20);
      expect(everyMinute, '重排用了固定 60s，边界 00:04 被推迟').toBe(4);
    });
  });

  it('休眠 3 分钟：醒来回补 3 次，不报警', async () => {
    await withEngine(T0 + 1_000, async h => {
      let fired = 0;
      h.engine.subscribe('* * * * *', () => {
        fired++;
      });
      h.fireTickAt(T0 + MIN + 10);
      expect(fired).toBe(1);
      h.fireTickAt(T0 + 4 * MIN + 400);
      expect(fired, '休眠 3 分钟应回补 00:02/00:03/00:04 三次').toBe(4);
      expect(h.warns, '5 分钟以内的回补不该报警').toEqual([]);
    });
  });

  it('休眠 10 分钟：只回补最近 5 分钟，并 warn 一次说明跳过了几分钟', async () => {
    await withEngine(T0 + 1_000, async h => {
      let fired = 0;
      h.engine.subscribe('* * * * *', () => {
        fired++;
      });
      h.fireTickAt(T0 + MIN + 10);
      expect(fired).toBe(1);
      h.fireTickAt(T0 + 11 * MIN + 10);
      expect(fired, '落后 10 分钟应只回补 5 分钟').toBe(6);
      expect(h.warns).toHaveLength(1);
      expect(h.warns[0]).toMatch(/落后 10 分钟/);
      expect(h.warns[0], 'warn 得说清跳过了多少分钟').toMatch(/跳过 5 分钟/);
    });
  });

  it('墙钟回拨：按当前时刻重锚，回拨跨过的分钟不补跑，之后照常按分钟推进', async () => {
    await withEngine(T0 + 1_000, async h => {
      let fired = 0;
      h.engine.subscribe('* * * * *', () => {
        fired++;
      });
      // 正常跑到 00:05（首轮只求值当前分钟，第二轮回补 00:02~00:05）
      h.fireTickAt(T0 + MIN + 10);
      h.fireTickAt(T0 + 5 * MIN + 10);
      expect(fired).toBe(5);

      // 墙钟被拨回到 00:02（NTP 校正）：锚点停在未来 00:05，不重锚就会静默停摆
      h.fireTickAt(T0 + 2 * MIN + 10);
      expect(fired, '回拨这一轮只求值当前分钟 00:02，不补跑 00:03~00:05').toBe(6);
      expect(h.warns).toHaveLength(1);
      expect(h.warns[0]).toMatch(/墙钟回拨/);
      expect(h.warns[0], 'warn 得说清回拨跨过的分钟不补跑').toMatch(/不补跑/);

      // 重锚后照常一分钟一跳（锚点若仍停在 00:05，这一轮会静默不触发）
      h.fireTickAt(T0 + 3 * MIN + 10);
      expect(fired, '重锚后 00:03 应正常触发').toBe(7);
    });
  });

  it('dispose 后 subscribe 不复活主循环：陈旧服务引用不会留下越过卸载的定时器', async () => {
    await withEngine(T0 + 1_000, async h => {
      await h.app.stop();
      // 卸载后仍被握着的陈旧服务引用再 subscribe：不得把主循环起回来
      h.engine.subscribe('* * * * *', () => {});
      expect(vi.getTimerCount(), 'dispose 后 subscribe 把 tick 循环起了回来，定时器越过卸载活着').toBe(0);
    });
  });

  it('dispose 后 subscribe 的 @every 同样不建定时器：interval 没人再清它，会越过卸载一直活着', async () => {
    await withEngine(T0 + 1_000, async h => {
      await h.app.stop();
      // interval 通道不经 scheduleNextTick，闸只设在那里时这里照建 setInterval，
      // 而 onDispose 早已跑完，intervalSubs 里这个新 timer 永远不会被 clearInterval
      const off = h.engine.subscribe('@every 1s', () => {});
      expect(vi.getTimerCount(), 'dispose 后 @every subscribe 建出了永不被清的 setInterval').toBe(0);
      expect(() => off(), '退订句柄应是可安全调用的空操作').not.toThrow();
    });
  });
});
