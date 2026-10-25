import { describe, expect, it } from 'vitest';
import { settlePendingActions } from '../../packages/plugin-adapter-onebot/src/index.js';

// ════════════════════════════════════════════════════════════
// 在飞 action 结清契约——ws 断开与插件拆卸两条清理路共用同一实现。
//
// 事故背景：onDispose 只 clearTimeout、不 reject
// 也不清 map，bounce 瞬间在飞的 get_forward_msg/get_msg 的 promise 永久悬空、
// 该消息静默丢失。契约：任何清理路径都必须 reject 唤醒等待方并清掉记录。
// 在飞的 action 已经发给实现端，拒绝写明结果未知、可能已经执行，不当作没发出。
// ════════════════════════════════════════════════════════════

type Pending = { action: string; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

function makePending(): { map: Map<string, Pending>; awaiting: Promise<string>[] } {
  const map = new Map<string, Pending>();
  const awaiting: Promise<string>[] = [];
  for (let i = 0; i < 3; i++) {
    let reject!: (err: Error) => void;
    // 等待方形态：promise 只在 reject 时落定，超时器兜底（测试中不会走到）
    awaiting.push(new Promise<never>((_r, rej) => (reject = rej)).catch((e: Error) => e.message));
    map.set(`echo-${i}`, { action: `zz_action_${i}`, reject, timer: setTimeout(() => {}, 60_000) });
  }
  return { map, awaiting };
}

describe('settlePendingActions（在飞 action 结清）', () => {
  it('全部在飞 promise 被 reject 唤醒（不悬空），写明结果未知；map 清空，返回结清条数', async () => {
    const { map, awaiting } = makePending();
    const n = settlePendingActions(map, '适配器已停止');
    expect(n).toBe(3);
    expect(map.size).toBe(0);
    // 悬空即超时：这里能等到结果本身就是「不悬空」的证明
    const messages = await Promise.all(awaiting);
    expect(messages.map(m => m.includes('适配器已停止') && m.includes('结果未知'))).toEqual([true, true, true]);
    expect(messages[0]).toContain('zz_action_0');
  });

  it('空记录：零条结清、不抛错', () => {
    expect(settlePendingActions(new Map(), '连接已关闭')).toBe(0);
  });
});
