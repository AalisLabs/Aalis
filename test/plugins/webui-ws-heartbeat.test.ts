import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWsHeartbeat, type HeartbeatSocket } from '../../packages/plugin-webui-server/src/ws-heartbeat.js';

// ════════════════════════════════════════════════════════════
// WS 心跳：半开连接回收
//
// 缺陷背景：webui-server 的清理只挂在 'close' 事件——客户端合盖睡眠/移动网
// 中断（无 FIN/RST）时 readyState 永远 OPEN，日志广播持续往死连接的发送缓冲
// 堆数据（external 内存慢涨，对抗审计确认项）。心跳把「死了但没说」的连接
// 在 1~2 个周期内 terminate，接回既有 'close' 清理链。
// ════════════════════════════════════════════════════════════

interface FakeWs extends HeartbeatSocket {
  pings: number;
  terminated: boolean;
  /** 模拟协议层自动回 pong（浏览器行为）；半开死连接不调用它。 */
  emitPong(): void;
}

function makeWs(autoPong: boolean): FakeWs {
  let pongCb: (() => void) | undefined;
  const ws: FakeWs = {
    pings: 0,
    terminated: false,
    ping() {
      ws.pings++;
      if (autoPong) queueMicrotask(() => pongCb?.());
    },
    terminate() {
      ws.terminated = true;
    },
    on(_event, cb) {
      pongCb = cb;
    },
    emitPong() {
      pongCb?.();
    },
  };
  return ws;
}

const INTERVAL = 1000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createWsHeartbeat', () => {
  it('活连接（协议层自动回 pong）跨多个周期存活，不被误杀', async () => {
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL });
    const ws = makeWs(true);
    hb.track(ws);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(INTERVAL);
    }
    expect(ws.pings).toBe(5);
    expect(ws.terminated, '按时回 pong 的连接不得被踢').toBe(false);
    hb.dispose();
  });

  it('半开死连接（从不回 pong）：第一轮被 ping，第二轮被 terminate', async () => {
    const stale: FakeWs[] = [];
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL, onStale: ws => stale.push(ws) });
    const ws = makeWs(false);
    hb.track(ws);
    await vi.advanceTimersByTimeAsync(INTERVAL); // 第一轮：标记待验 + ping
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(INTERVAL); // 第二轮：无 pong → 踢
    expect(ws.terminated, '整周期无 pong 必须回收').toBe(true);
    expect(stale).toEqual([ws]);
    hb.dispose();
  });

  it('迟到但在周期内的 pong 也算活着（宽限期语义）', async () => {
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL });
    const ws = makeWs(false);
    hb.track(ws);
    await vi.advanceTimersByTimeAsync(INTERVAL); // ping 出去
    ws.emitPong(); // 手动在下一轮巡检前回 pong
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(ws.terminated).toBe(false);
    expect(ws.pings).toBe(2);
    hb.dispose();
  });

  it('冻结宽恕：事件循环长阻塞后的首轮不判死，健康连接不被误杀', async () => {
    // 今晚实景：拍堆快照冻结进程 2 分钟。若恰好卡在「ping 已发、pong 未被 poll 读入」
    // 的窗口，解冻后 timers 先于 poll 跑 → 全员 alive===false → 全部误杀。
    const stale: FakeWs[] = [];
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL, onStale: ws => stale.push(ws) });
    const ws = makeWs(false); // 模拟 pong 卡在内核缓冲：本轮拿不到
    hb.track(ws);
    await vi.advanceTimersByTimeAsync(INTERVAL); // 正常轮：标记 + ping
    expect(ws.terminated).toBe(false);

    // 真冻结的形态是「墙钟跳变 + 合并补发一次 tick」，而不是 N 次逐个触发：
    // 先跳系统时间（进程被挂起），再放行一次巡检。
    vi.setSystemTime(Date.now() + INTERVAL * 4);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(ws.terminated, '经历冻结的首轮必须宽恕，不得判死').toBe(false);
    expect(stale).toEqual([]);

    // 宽恕只给一轮：紧接着的正常轮仍会收掉真死连接
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(ws.terminated, '宽恕不是免死金牌，下一轮照常回收').toBe(true);
    hb.dispose();
  });

  it('untrack 后不再被 ping（close 清理链幂等）', async () => {
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL });
    const ws = makeWs(true);
    hb.track(ws);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    hb.untrack(ws);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(ws.pings).toBe(1);
    hb.dispose();
  });

  it('dispose 停表：不再有任何巡检动作', async () => {
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL });
    const ws = makeWs(false);
    hb.track(ws);
    hb.dispose();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(ws.pings).toBe(0);
    expect(ws.terminated).toBe(false);
  });

  it('ping 抛异常不打断整轮巡检（其它连接照常处理）', async () => {
    const hb = createWsHeartbeat<FakeWs>({ intervalMs: INTERVAL });
    const bad = makeWs(true);
    bad.ping = () => {
      throw new Error('EPIPE');
    };
    const good = makeWs(true);
    hb.track(bad);
    hb.track(good);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(good.pings, '坏连接不得连坐好连接').toBe(1);
    hb.dispose();
  });
});
