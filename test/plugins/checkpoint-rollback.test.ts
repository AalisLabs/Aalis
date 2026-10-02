import { describe, expect, it } from 'vitest';
import type { TurnManifest } from '../../packages/plugin-checkpoint/src/service.js';
import {
  makeCheckpointService as makeService,
  CHECKPOINT_ROOT as ROOT,
  soleTurnId,
} from '../fixtures/checkpoint-disk.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// checkpoint 回滚：备份不得把自己也记成一条改动。
// （回归：storage 的写前快照钩子会把 checkpoint 自己写 blob 的动作递归送回 beforeMutate，
//  blob 此刻尚不存在 → 记成 write-new 且排在真实条目之前 → 回滚先删备份再读它 → ENOENT，
//  覆盖/删除类恢复必败且备份被毁；listTurns 也因此虚高并暴露内部路径。）
// ════════════════════════════════════════════════════════════

describe('checkpoint 回滚', () => {
  it('覆盖写：回滚恢复原文', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/a.txt', 'changed');
    });
    expect(disk.get('ws:/a.txt')).toBe('changed');

    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.restored).toEqual(['ws:/a.txt']);
    expect(disk.get('ws:/a.txt')).toBe('orig');
  });

  it('删除：回滚把文件写回来', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/b.txt', 'orig-b');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.delete('ws:/b.txt');
    });
    expect(disk.has('ws:/b.txt')).toBe(false);

    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(disk.get('ws:/b.txt')).toBe('orig-b');
  });

  it('write-new：回滚删除新建文件，且不误删 checkpoint 自己的 blob', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/a.txt', 'changed'); // 覆盖（有 blob）
      await storage.writeFile('ws:/new.txt', 'brand new'); // 新建
    });

    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.deleted).toEqual(['ws:/new.txt']);
    expect(disk.has('ws:/new.txt')).toBe(false);
    expect(disk.get('ws:/a.txt')).toBe('orig');
  });

  it('write-new 回滚删不掉：错误带非 ENOENT 的 code 时如实入 errors，文案含 not found 也不当成「已不在」', async () => {
    const { svc, disk, storage } = makeService();
    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/new.txt', 'brand new');
    });

    storage.delete = async (uri: string) => {
      throw Object.assign(new Error(`access denied: credentials not found for ${uri}`), { code: 'EACCES' });
    };
    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(false);
    expect(result.errors.map(e => e.uri)).toEqual(['ws:/new.txt']);
    expect(disk.get('ws:/new.txt')).toBe('brand new');
  });

  it('rename 移不回、回落删目标失败：错误带非 ENOENT 的 code 时如实入 errors，文案含 not found 也不当成「已不在」', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');
    // 回合内只做这一次移动：中间有写入的话 rename 条目不带 blob，走不到回落分支
    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.move('ws:/a.txt', 'ws:/b.txt');
    });

    storage.move = async () => {
      throw new Error('target occupied');
    };
    storage.delete = async (uri: string) => {
      throw Object.assign(new Error(`access denied: credentials not found for ${uri}`), { code: 'EACCES' });
    };
    const result = await svc.rollback('sessA', soleTurnId(disk, 'sessA'));
    expect(result.ok).toBe(false);
    expect(result.errors.map(e => e.uri)).toEqual(['ws:/b.txt']);
    expect(result.deleted).toEqual([]);
    expect(disk.get('ws:/a.txt')).toBe('orig');
  });

  it('manifest 只记用户文件：不含指向 checkpoint 根的自指条目', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/a.txt', 'changed');
    });

    const turnId = soleTurnId(disk, 'sessA');
    const manifest = await svc.getManifest('sessA', turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['ws:/a.txt']);

    const [summary] = await svc.listTurns('sessA');
    expect(summary?.fileCount).toBe(1);
    expect(summary?.filesPreview).toEqual(['ws:/a.txt']);
  });

  it('同名前缀的兄弟目录是用户文件：照常快照与回滚，不被当成 checkpoint 自己的根', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/checkpoints-old/a.txt', 'orig-sibling');
    disk.set('ws:/a.txt', 'orig');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/checkpoints-old/a.txt', 'changed');
      await storage.writeFile('ws:/a.txt', 'changed');
    });

    const turnId = soleTurnId(disk, 'sessA');
    const manifest = await svc.getManifest('sessA', turnId);
    expect(manifest?.files.map(f => f.uri).sort()).toEqual(['ws:/a.txt', 'ws:/checkpoints-old/a.txt']);

    const result = await svc.rollback('sessA', turnId);
    expect(result.ok).toBe(true);
    expect(disk.get('ws:/checkpoints-old/a.txt')).toBe('orig-sibling');
    expect(disk.get('ws:/a.txt')).toBe('orig');
  });
});

// ════════════════════════════════════════════════════════════
// 回滚动作本身不是任何回合的改动：WebUI 发起的回滚在任何回合之外执行，它的写回/删除经 storage 写前钩子
// 回到 beforeMutate 时，不得记进此刻在跑的别的回合——那边一回滚就把这次回滚再撤掉，且 listTurns 虚高。
// ════════════════════════════════════════════════════════════
describe('checkpoint 回滚动作不记进此刻在跑的回合', () => {
  /** B 回合开着，等 duringB 在回合之外跑完，再执行 afterInB（在 B 的回合里）后结束 */
  async function whileBRuns(
    svc: ReturnType<typeof makeService>['svc'],
    duringB: () => Promise<void>,
    afterInB: () => Promise<void> = async () => {},
  ): Promise<void> {
    const entered = deferred();
    const proceed = deferred();
    const turnB = svc.runTurn('turn-sessB', 'sessB', async () => {
      entered.resolve();
      await proceed.promise;
      await afterInB();
    });
    await entered.promise;
    await duringB();
    proceed.resolve();
    await turnB;
  }

  it('B 回合在跑时回滚 A：磁盘回到 A 回合前，B 无改动、不落 manifest', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/a.txt', 'changed');
      await storage.writeFile('ws:/new.txt', 'n');
    });
    const turnId = soleTurnId(disk, 'sessA');

    await whileBRuns(svc, async () => {
      const r = await svc.rollback('sessA', turnId);
      expect(r.ok).toBe(true);
      expect(disk.get('ws:/a.txt')).toBe('orig');
      expect(disk.has('ws:/new.txt')).toBe(false);
    });

    expect([...disk.keys()].filter(k => k.startsWith(`${ROOT}/sessB/`))).toEqual([]);
  });

  it('回滚结束后 B 回合的真实改动照常受保护', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');
    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/a.txt', 'changed');
    });
    const turnId = soleTurnId(disk, 'sessA');

    await whileBRuns(
      svc,
      async () => {
        await svc.rollback('sessA', turnId);
      },
      async () => {
        await storage.writeFile('ws:/a.txt', 'by-B');
      },
    );

    const manifestKey = [...disk.keys()].find(k => k.startsWith(`${ROOT}/sessB/`) && k.endsWith('manifest.json'));
    expect(manifestKey, 'B 自己的改动应有 manifest').toBeTruthy();
    const m = JSON.parse(disk.get(manifestKey as string) as string) as TurnManifest;
    expect(m.files.map(f => [f.uri, f.action])).toEqual([['ws:/a.txt', 'write']]);
    // 快照的是 B 改写前的 orig：若回滚的写回被记进 B（再被 B 自己的写按 URI 去重吞掉），blob 会是 changed
    const blobKey = (manifestKey as string).replace(/manifest\.json$/, `blobs/${m.files[0].blob}`);
    expect(disk.get(blobKey)).toBe('orig');
  });

  it('rename 条目：回滚的原路移回（toUri 侧）也不记进 B', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('ws:/a.txt', 'orig');
    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.move('ws:/a.txt', 'ws:/b.txt');
    });
    const turnId = soleTurnId(disk, 'sessA');

    await whileBRuns(svc, async () => {
      const r = await svc.rollback('sessA', turnId);
      expect(r.ok).toBe(true);
      expect(disk.get('ws:/a.txt')).toBe('orig');
      expect(disk.has('ws:/b.txt')).toBe(false);
    });
    expect([...disk.keys()].filter(k => k.startsWith(`${ROOT}/sessB/`))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// data / tmp / pluginData / logs 根不记账：data 是多会话/多平台共享的写入区（别的平台落盘的附件、
// 插件状态），曾被记进活跃回合——WebUI 一回滚就删掉 OneBot 刚落盘的图片、把状态文件写回旧版。
// 其余根（workspace、用户自建的 custom、根集合里没列出的）照常记账——宁可多记，不丢保护。
// ════════════════════════════════════════════════════════════
describe('checkpoint 不记 data / tmp 等共享根', () => {
  it('回合期间 data / tmp 根的写入不记账，回滚不碰它们；custom 与未列出的根照常记账', async () => {
    const { svc, disk, storage } = makeService();
    disk.set('data:/scheduler-jobs.json', '[]');
    disk.set('repo:/src.ts', 'orig');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/note.txt', 'n'); // 工作区改动照常记账
      await storage.writeFile('repo:/src.ts', 'agent-overwrote'); // 用户自建的 custom 根（如把整个仓库挂成根）
      await storage.writeFile('unlisted:/x.txt', 'x'); // 根集合里没列出的根：按记账处理
      await storage.writeFile('data:/images/onebot_1_group_2/0123456789abcdef.jpg', 'img'); // 别的平台落盘
      await storage.writeFile('data:/scheduler-jobs.json', '[{"name":"j"}]'); // 插件状态
      await storage.writeFile('tmp:/run-1/main.py', 'print(1)'); // 临时目录
      await storage.writeFile('plugs:/file-reader/s/x.txt', 'p'); // pluginData
      await storage.writeFile('lg:/app.log', 'l'); // logs
    });
    const turnId = soleTurnId(disk, 'sessA');

    const manifest = JSON.parse(disk.get(`${ROOT}/sessA/${turnId}/manifest.json`) as string) as TurnManifest;
    expect(manifest.files.map(f => f.uri)).toEqual(['ws:/note.txt', 'repo:/src.ts', 'unlisted:/x.txt']);

    const r = await svc.rollback('sessA', turnId);
    expect(r.ok).toBe(true);
    expect(disk.has('ws:/note.txt')).toBe(false);
    expect(disk.get('repo:/src.ts'), 'custom 根的改写应能回滚').toBe('orig');
    expect(disk.has('unlisted:/x.txt')).toBe(false);
    expect(disk.get('data:/images/onebot_1_group_2/0123456789abcdef.jpg'), 'data 根文件不得被回滚删除').toBe('img');
    expect(disk.get('data:/scheduler-jobs.json'), '插件状态文件不得被回滚改回').toBe('[{"name":"j"}]');
    expect(disk.get('tmp:/run-1/main.py')).toBe('print(1)');
    expect(disk.get('plugs:/file-reader/s/x.txt')).toBe('p');
    expect(disk.get('lg:/app.log')).toBe('l');
  });
});

// ════════════════════════════════════════════════════════════
// 「读不出来」不等于「文件不存在」。
//
// storage-local 的 loadOriginal 曾用裸 catch 把两者压成同一个 null，beforeMutate 拿到
// null 后按 write 记成 write-new（本回合新建），而 rollback 的 write-new 分支是无条件
// storage.delete——于是一个回合开始前就存在、且没有任何备份的用户文件，在回滚时被直接
// 删掉，且 rollback 仍返回 ok:true。可达场景：只写权限(0200)、fd 打满(EMFILE)、
// 超过单次 readFile 上限。
// ════════════════════════════════════════════════════════════

describe('checkpoint：原文件读取失败不得当成「本回合新建」', () => {
  it('覆盖一个读不出来的既有文件 → 记 skipped，回滚不删它', async () => {
    const { svc, disk, storage, unreadable } = makeService();
    disk.set('ws:/secret.txt', '回合开始前就存在的用户数据');
    unreadable.add('ws:/secret.txt');

    await svc.runTurn('turn-sessA', 'sessA', async () => {
      await storage.writeFile('ws:/secret.txt', 'agent 覆盖后的内容');
    });

    const turnId = soleTurnId(disk, 'sessA');
    const manifest = await svc.getManifest('sessA', turnId);
    const entry = manifest?.files.find(f => f.uri === 'ws:/secret.txt');
    expect(entry, '这条改动必须被记下来').toBeDefined();
    expect(entry?.action, '读取失败被记成 write-new 的话，回滚会把它删掉').not.toBe('write-new');
    expect(entry?.skipped, '应如实标为未快照、不可回滚').toBeTruthy();

    const result = await svc.rollback('sessA', turnId);
    expect(disk.has('ws:/secret.txt'), '用户文件绝不能因回滚而消失').toBe(true);
    expect(
      result.errors.some(e => e.uri === 'ws:/secret.txt'),
      '应如实报告这条无法回滚',
    ).toBe(true);
  });

  it('真·新建的文件仍记 write-new，回滚照常删除', async () => {
    const { svc, disk, storage } = makeService();

    await svc.runTurn('turn-sessB', 'sessB', async () => {
      await storage.writeFile('ws:/brand-new.txt', '本回合新建');
    });

    const turnId = soleTurnId(disk, 'sessB');
    const manifest = await svc.getManifest('sessB', turnId);
    expect(manifest?.files.find(f => f.uri === 'ws:/brand-new.txt')?.action).toBe('write-new');

    await svc.rollback('sessB', turnId);
    expect(disk.has('ws:/brand-new.txt'), '新建文件回滚就该删掉').toBe(false);
  });
});
