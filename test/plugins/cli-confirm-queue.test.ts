import { describe, expect, it } from 'vitest';
import { ConfirmQueue } from '../../packages/plugin-cli/src/confirm-queue.js';

// CLI 终端确认排队：同一轮并行的多个需确认工具各自拿到自己的结算，先到先问；停止时全部按取消结算。
// 单槽位的旧实现会让先到者永不结算，agent 的 Promise.all 整轮挂死。

describe('ConfirmQueue', () => {
  it('按到达顺序逐个问、按序结算', async () => {
    const q = new ConfirmQueue();
    const a = q.ask('A');
    const b = q.ask('B');
    expect(q.size).toBe(2);
    expect(q.current).toBe('A');
    expect(q.answer(true)).toBe(true);
    expect(q.current).toBe('B');
    expect(q.answer(false)).toBe(true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
    expect(q.size).toBe(0);
    expect(q.current).toBeUndefined();
  });

  it('没有待确认时 answer 返回 false，不抛', () => {
    expect(new ConfirmQueue().answer(true)).toBe(false);
  });

  it('settleAll 把全部在飞确认按取消结算，之后队列为空', async () => {
    const q = new ConfirmQueue();
    const ps = [q.ask('A'), q.ask('B'), q.ask('C')];
    q.settleAll(false);
    await expect(Promise.all(ps)).resolves.toEqual([false, false, false]);
    expect(q.size).toBe(0);
  });
});
