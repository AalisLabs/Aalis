import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeCheckpointService, CHECKPOINT_ROOT as ROOT } from '../fixtures/checkpoint-disk.js';

// ════════════════════════════════════════════════════════════
// 每个会话只留最近 keepTurns 轮：每次提交回合后（GC 在提交后异步跑），这个会话超出的最旧回合连同它的备份一起删掉，
// 留下的回合照常回滚。
// ════════════════════════════════════════════════════════════

afterEach(() => {
  vi.useRealTimers();
});

describe('checkpoint 按会话保留的回合数', () => {
  it('上限 3、提交 5 轮：只剩最新 3 轮，更早两轮的清单与备份都删掉，回滚最新一轮照常', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { svc, disk, storage } = makeCheckpointService({ keepTurns: 3 });
    disk.set('ws:/a.txt', 'v0');
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(i * 1000);
      await svc.runTurn(`t${i}`, 's', async () => {
        await storage.writeFile('ws:/a.txt', `v${i}`);
      });
    }
    vi.useRealTimers(); // GC 异步执行完毕再看，等待用真时钟

    const prefix = `${ROOT}/s/`;
    const turnsOnDisk = () => [
      ...new Set([...disk.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0])),
    ];
    await vi.waitFor(() => expect(turnsOnDisk().sort()).toEqual(['t3', 't4', 't5']));
    expect((await svc.listTurns('s')).map(turn => turn.turnId)).toEqual(['t5', 't4', 't3']);

    const result = await svc.rollback('s', 't5');
    expect(result).toMatchObject({ ok: true, restored: ['ws:/a.txt'], errors: [] });
    expect(disk.get('ws:/a.txt')).toBe('v4');
  });

  it('同一会话的两次清理撞在一起：后删的那次回合已不在，不记告警', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { svc, disk, storage, warns } = makeCheckpointService({ keepTurns: 1 });
    // 别的清理先删掉了同一个回合：这次删时它已不在
    const remove = storage.delete;
    storage.delete = async (uri: string) => {
      await remove(uri);
      await remove(uri);
    };
    for (let i = 1; i <= 2; i++) {
      vi.setSystemTime(i * 1000);
      await svc.runTurn(`t${i}`, 's', async () => {
        await storage.writeFile('ws:/a.txt', `v${i}`);
      });
    }
    vi.useRealTimers();

    await vi.waitFor(() => expect(disk.has(`${ROOT}/s/t1/manifest.json`)).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 0)); // 清理剩下的都是微任务，等它们执行完毕
    expect(warns).toEqual([]);
  });
});
