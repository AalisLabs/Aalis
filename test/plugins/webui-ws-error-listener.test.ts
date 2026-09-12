import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createWsHeartbeat, type HeartbeatSocket } from '../../packages/plugin-webui-server/src/ws-heartbeat.js';

// ════════════════════════════════════════════════════════════
// 每条 WS 连接必须有 'error' 监听者（真 EventEmitter，不 mock 事件语义）。
//
// 缺陷背景：EventEmitter 对无监听者的 'error' 是**抛出**。ws 的帧校验失败
// （畸形帧 / 坏 UTF-8）走的正是 emit('error')——没人听就抛成
// uncaughtException，runtime 收到即 process.exit(1)：一条畸形帧打死整进程
// （连带 onebot 适配器、定时任务）。webui-server 每条连接都过 heartbeat.track，
// 故兜底监听挂在 track 里，凡登记过的连接天然免疫。
//
// 用 EventEmitter 而不是真 ws：`ws` 是 plugin-webui-server 自己的依赖，仓库根
// 解析不到（knip 判未列依赖、test/ 类型检查报 TS2307）。而要守的不变量只在
// EventEmitter 的 'error' 语义上——ws 的帧校验错误正是经它 emit 出来的。
// ════════════════════════════════════════════════════════════

/** 最小连接替身：'error' 语义来自真 EventEmitter，ping/terminate 只为满足接口（本例不巡检）。 */
class FakeWs extends EventEmitter implements HeartbeatSocket {
  ping(): void {
    /* 本例心跳周期给足，不会被调用 */
  }
  terminate(): void {
    /* 同上 */
  }
}

describe('webui WS 连接的 error 兜底', () => {
  it('track 过的连接 emit(error) 不抛，错误走 onError 回调', () => {
    const seen: Error[] = [];
    // 心跳周期给足，本例只验 track 挂的 error 监听，不让巡检插手
    const heartbeat = createWsHeartbeat<FakeWs>({
      intervalMs: 60_000,
      onError: (_ws, err) => seen.push(err),
    });
    const ws = new FakeWs();
    heartbeat.track(ws);

    const err = new Error('Invalid UTF-8 sequence');
    expect(() => ws.emit('error', err), '有监听者时 emit(error) 不得抛出').not.toThrow();
    expect(seen, '连接错误必须被兜底监听接住').toEqual([err]);

    heartbeat.dispose();
  });

  it('未 track 的连接 emit(error) 直接抛——反证免疫确实来自 track', () => {
    const bare = new FakeWs();
    expect(() => bare.emit('error', new Error('boom')), '无监听者的 error 就是抛出').toThrow('boom');
  });
});
