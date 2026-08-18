// ============================================================
// ws-heartbeat.ts — WebSocket 服务端心跳（半开连接回收）
//
// 半开 TCP（客户端合盖睡眠、移动网中断——没有 FIN/RST）下 readyState 永远
// OPEN：清理只挂在 'close' 事件上永远等不到，日志广播继续往死连接写，
// 数据堆积在 socket 发送缓冲（external 内存慢涨）。
//
// 标准回收：周期性 ping，全周期无 pong 即 terminate（触发 'close'，走既有
// 清理链）。浏览器对 ping 是协议层自动回 pong，后台标签页也会回，不误杀；
// 只有真死的连接才会在 1~2 个周期内被踢。
//
// 独立小模块 + 依赖注入的最小 socket 面，同 auth/gate 的可单测形态。
// ============================================================

/** 心跳所需的最小 socket 面（ws.WebSocket 天然满足）。 */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: 'pong', cb: () => void): void;
}

interface WsHeartbeat<T extends HeartbeatSocket> {
  /** 连接建立时登记：挂 pong 监听并纳入巡检。 */
  track(ws: T): void;
  /** 连接关闭时移除（terminate 踢掉的经 'close' 清理链也会走到这里，幂等）。 */
  untrack(ws: T): void;
  /** 停止巡检定时器（插件 dispose 时调用）。 */
  dispose(): void;
}

/**
 * 创建心跳巡检。每 `intervalMs` 一轮：上一轮 ping 后没回 pong 的连接判死
 * terminate；活着的标记待验并 ping。宽限期 = 1~2 个周期（取决于入轮相位）。
 */
export function createWsHeartbeat<T extends HeartbeatSocket>(
  opts: {
    intervalMs?: number;
    /** 踢掉死连接时回调（记日志用）；terminate 本身已触发 'close' 清理链。 */
    onStale?: (ws: T) => void;
  } = {},
): WsHeartbeat<T> {
  const intervalMs = opts.intervalMs ?? 30_000;
  const tracked = new Set<T>();
  const alive = new WeakMap<T, boolean>();

  const timer = setInterval(() => {
    for (const ws of tracked) {
      if (alive.get(ws) === false) {
        // 整整一个周期没回 pong：半开死连接，踢掉（'close' 事件走既有清理）
        tracked.delete(ws);
        opts.onStale?.(ws);
        try {
          ws.terminate();
        } catch {
          /* 已死的 socket terminate 可能抛，无所谓 */
        }
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        /* 发不出去交给下一轮判死 */
      }
    }
  }, intervalMs);
  // 心跳不该拖住进程退出；正常路径由 dispose() 清
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    track(ws: T): void {
      alive.set(ws, true);
      tracked.add(ws);
      ws.on('pong', () => alive.set(ws, true));
    },
    untrack(ws: T): void {
      tracked.delete(ws);
    },
    dispose(): void {
      clearInterval(timer);
      tracked.clear();
    },
  };
}
