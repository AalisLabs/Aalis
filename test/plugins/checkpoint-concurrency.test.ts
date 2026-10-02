import { describe, expect, it } from 'vitest';
import { blobOf, makeCheckpointService as makeService } from '../fixtures/checkpoint-disk.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// checkpoint 的活跃回合按 turnId 记：同一会话可以同时有几轮在跑（真人消息与宿主通知各走一条 lane），
// 一次写入只记进它所在的那一轮（按写入时的异步上下文认），回合外的写入不记进任何一轮。
// 回滚某一轮时，另有回合也改过同一个文件就如实列出：回滚把文件恢复成这一轮第一次改动前的内容，
// 那些回合在这之后的改动会一并被撤掉。
// ════════════════════════════════════════════════════════════

describe('checkpoint 并发回合按写入时所在的回合归属', () => {
  it('同一会话并发两轮改同一个文件：各记各的，备份是各自写入前的内容', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');
    const t1Wrote = deferred();
    const t2Wrote = deferred();

    await Promise.all([
      svc.runTurn('t1', 's', async () => {
        await storage.writeFile('ws:/a.txt', 'by-t1');
        t1Wrote.resolve();
        await t2Wrote.promise;
        await storage.writeFile('ws:/c.txt', 'c');
      }),
      svc.runTurn('t2', 's', async () => {
        await t1Wrote.promise;
        await storage.writeFile('ws:/a.txt', 'by-t2');
        await storage.writeFile('ws:/b.txt', 'b');
        t2Wrote.resolve();
      }),
    ]);

    const m1 = await svc.getManifest('s', 't1');
    const m2 = await svc.getManifest('s', 't2');
    expect(m1?.files.map(f => [f.uri, f.action])).toEqual([
      ['ws:/a.txt', 'write'],
      ['ws:/c.txt', 'write-new'],
    ]);
    expect(m2?.files.map(f => [f.uri, f.action])).toEqual([
      ['ws:/a.txt', 'write'],
      ['ws:/b.txt', 'write-new'],
    ]);
    expect(blobOf(disk, 's', 't1', 'ws:/a.txt')).toBe('orig');
    expect(blobOf(disk, 's', 't2', 'ws:/a.txt')).toBe('by-t1');
  });

  it('回合外的写入不记进此刻在跑的回合', async () => {
    const { svc, storage } = makeService();
    const entered = deferred();
    const proceed = deferred();
    const turn = svc.runTurn('t1', 's', async () => {
      entered.resolve();
      await proceed.promise;
      await storage.writeFile('ws:/mine.txt', 'x');
    });
    await entered.promise;
    await storage.writeFile('ws:/outside.txt', 'y');
    proceed.resolve();
    await turn;

    expect((await svc.getManifest('s', 't1'))?.files.map(f => f.uri)).toEqual(['ws:/mine.txt']);
  });

  it('回合已结束、仍带着它的上下文晚到的写入不记账', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/late.txt', 'orig'); // 覆盖已有文件：记账的话会多出一份备份
    const late = deferred();
    let lateWrite: Promise<void> | undefined;
    await svc.runTurn('t1', 's', async () => {
      await storage.writeFile('ws:/a.txt', 'a');
      lateWrite = late.promise.then(() => storage.writeFile('ws:/late.txt', 'late'));
    });
    const committed = disk.get('ws:/checkpoints/s/t1/manifest.json');
    late.resolve();
    await lateWrite;

    expect(disk.get('ws:/checkpoints/s/t1/manifest.json')).toBe(committed);
    expect((await svc.getManifest('s', 't1'))?.files.map(f => f.uri)).toEqual(['ws:/a.txt']);
    expect([...disk.keys()].filter(k => k.startsWith('ws:/checkpoints/s/t1/blobs/'))).toEqual([]);
  });

  it('回合以调用方给的 turnId 落盘；回合抛错也照样结束并提交', async () => {
    const { svc, storage } = makeService();
    await expect(
      svc.runTurn('turn-x', 's', async () => {
        await storage.writeFile('ws:/x.txt', 'x');
        throw new Error('回合出错');
      }),
    ).rejects.toThrow('回合出错');
    expect((await svc.listTurns('s')).map(t => t.turnId)).toEqual(['turn-x']);
  });

  it('提交失败只告警：回合本身的结果照常交回', async () => {
    const { svc, storage, warns } = makeService();
    const write = storage.writeFile;
    storage.writeFile = async (uri, data) => {
      if (uri.endsWith('/manifest.json')) throw new Error('磁盘已满');
      await write(uri, data);
    };
    const reply = svc.runTurn('t1', 's', async () => {
      await storage.writeFile('ws:/a.txt', 'a');
      return 'reply';
    });
    await expect(reply).resolves.toBe('reply');
    expect(warns.some(w => w.includes('磁盘已满'))).toBe(true);
  });
});

describe('回滚时如实提示别的回合也改过的文件', () => {
  it('并发的两轮改过同一个文件：回滚任一轮都列出另一轮；只有自己改过的文件不列', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');
    const t1Wrote = deferred();
    const t2Wrote = deferred();
    await Promise.all([
      svc.runTurn('t1', 's', async () => {
        await storage.writeFile('ws:/a.txt', 'by-t1');
        await storage.writeFile('ws:/only-t1.txt', '1');
        t1Wrote.resolve();
        await t2Wrote.promise;
      }),
      svc.runTurn('t2', 's', async () => {
        await t1Wrote.promise;
        await storage.writeFile('ws:/a.txt', 'by-t2');
        t2Wrote.resolve();
      }),
    ]);

    const r1 = await svc.rollback('s', 't1');
    expect(r1.ok).toBe(true);
    expect(r1.alsoChangedBy).toEqual([{ uri: 'ws:/a.txt', turnIds: ['t2'] }]);
    expect(disk.get('ws:/a.txt'), '回滚照常执行').toBe('orig');

    const r2 = await svc.rollback('s', 't2');
    expect(r2.alsoChangedBy).toEqual([{ uri: 'ws:/a.txt', turnIds: ['t1'] }]);
  });

  it('本轮开始前就结束的回合不算；之后的回合、还在跑的回合都算；移动的目标端也算', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');
    disk.set('ws:/m.txt', 'm');
    await svc.runTurn('t0', 's', async () => {
      await storage.writeFile('ws:/a.txt', 'by-t0');
    });
    await new Promise(r => setTimeout(r, 5)); // t0 的结束时刻严格早于 t1 的开始
    await svc.runTurn('t1', 's', async () => {
      await storage.writeFile('ws:/a.txt', 'by-t1');
      await storage.writeFile('ws:/d.txt', 'd');
      await storage.move('ws:/m.txt', 'ws:/moved.txt');
    });
    await svc.runTurn('t2', 's', async () => {
      await storage.writeFile('ws:/a.txt', 'by-t2');
      await storage.writeFile('ws:/moved.txt', 'changed-after-move');
    });
    const entered = deferred();
    const proceed = deferred();
    const t3 = svc.runTurn('t3', 's', async () => {
      await storage.writeFile('ws:/d.txt', 'by-t3');
      entered.resolve();
      await proceed.promise;
    });
    await entered.promise;
    // 别的会话改同一个文件不在提示范围内
    await svc.runTurn('other', 's-other', async () => {
      await storage.writeFile('ws:/a.txt', 'by-other');
    });

    const r = await svc.rollback('s', 't1');
    expect(r.alsoChangedBy).toEqual([
      { uri: 'ws:/a.txt', turnIds: ['t2'] },
      { uri: 'ws:/d.txt', turnIds: ['t3'] },
      { uri: 'ws:/moved.txt', turnIds: ['t2'] },
    ]);
    proceed.resolve();
    await t3;
  });

  it('没有别的回合碰过：提示为空', async () => {
    const { svc, storage } = makeService();
    await svc.runTurn('t1', 's', async () => {
      await storage.writeFile('ws:/a.txt', 'a');
    });
    expect((await svc.rollback('s', 't1')).alsoChangedBy).toEqual([]);
  });
});
