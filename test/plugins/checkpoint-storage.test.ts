import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Hooks, hooks as hooksCap } from '../../packages/api-hooks/src/index.js';
import {
  createStorageGateway,
  type StorageService,
  storage as storageService,
} from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import checkpointPlugin, { checkpoint } from '../../packages/plugin-checkpoint/src/index.js';
import { CheckpointServiceImpl, resolveConfig } from '../../packages/plugin-checkpoint/src/service.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// checkpoint × storage-local 真 fs 集成：回滚承诺必须与磁盘实况一致。
// 回归三处「报回滚完成、磁盘却没回去」：
//   1) 目录递归删除完全不进 manifest（fileCount=0 却照样渲染回滚按钮）
//   2) move/rename 回滚只写回源端、从不删目标 → 回滚后文件变两份
//   3) 不记账的根（tmp / data 等）的写入被记账 → tmp 在回合结束前已被 cleanup 删掉 → 回滚必 ENOENT；
//      data 是别的平台/插件也在写的共享区 → 回滚会误删别人的文件
// 另守：回滚逆序撤销（LIFO，「移走后又改写目标」才能一并回退）、回落删目标只豁免 ENOENT
// （重复回滚仍 ok:true，权限失败则入 errors）、写目录在快照前就被拒（否则幽灵 write-new 让回滚删掉整棵目录）、
// 以及 execUsed 判据（exec_background / run_* 也算「命令副作用不可回滚」）。
// ════════════════════════════════════════════════════════════

describe('checkpoint × storage (真 fs)', () => {
  let base: string;
  let ws: string;
  let app: App;
  let storage: StorageService;
  let hooks: Hooks;
  let svc: CheckpointServiceImpl;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-cp-'));
    ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugins.register(storageLocalPlugin, {
      roots: [
        { name: 'ws', path: ws, kind: 'workspace', browsable: true, readable: true, writable: true, deletable: true },
        {
          name: 'data',
          path: join(base, 'data'),
          kind: 'data',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
        {
          name: 'tmp',
          path: join(base, 'tmp'),
          kind: 'tmp',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugins.register(checkpointPlugin, {
      rootDir: 'data:/checkpoints',
      scopes: ['*'],
      keepSessions: 0,
    });
    await app.plugins.idle();
    const host = app.bind({ storage: storageService, checkpoint, hooks: hooksCap });
    storage = createStorageGateway(host.storage);
    hooks = host.hooks;
    // beginTurn / endTurn 是实现类上的驱动面，不在对外服务契约里
    svc = host.checkpoint.require() as CheckpointServiceImpl;
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  /** 跑一个回合：begin → body → end，返回该会话唯一的 turnId */
  async function runTurn(sessionId: string, body: () => Promise<void>): Promise<string> {
    svc.beginTurn(sessionId);
    await body();
    await svc.endTurn(sessionId);
    const turns = await svc.listTurns(sessionId);
    expect(turns).toHaveLength(1);
    return (turns[0] as { turnId: string }).turnId;
  }

  it('目录递归删除：记一条不可回滚的改动，回滚如实报失败', async () => {
    mkdirSync(join(ws, 'dir', 'sub'), { recursive: true });
    writeFileSync(join(ws, 'dir', 'sub', 'f.txt'), 'deep');

    const turnId = await runTurn('s1', async () => {
      await storage.delete('ws:/dir');
    });
    expect(existsSync(join(ws, 'dir'))).toBe(false);

    const manifest = await svc.getManifest('s1', turnId);
    expect(manifest?.files).toHaveLength(1);
    expect(manifest?.files[0]).toMatchObject({ uri: 'ws:/dir', action: 'delete' });
    expect(manifest?.files[0]?.skipped).toBeTruthy(); // 目录没快照 → 必须显式标注

    const [summary] = await svc.listTurns('s1');
    expect(summary?.fileCount).toBe(1); // 不再是 0：UI 能看到本回合动了文件
    const result = await svc.rollback('s1', turnId);
    expect(result.ok).toBe(false); // 不假装成功
    expect(result.errors.map(e => e.uri)).toEqual(['ws:/dir']);
  });

  it('move 回滚：源端复原且目标被清掉，不留重复文件', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello');

    const turnId = await runTurn('s2', async () => {
      await storage.move('ws:/a.txt', 'ws:/sub/b.txt');
    });
    expect(existsSync(join(ws, 'sub', 'b.txt'))).toBe(true);
    expect(existsSync(join(ws, 'a.txt'))).toBe(false);

    const result = await svc.rollback('s2', turnId);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('hello');
    expect(existsSync(join(ws, 'sub', 'b.txt'))).toBe(false); // 关键：目标不能留着
  });

  it('rename 回滚：改名复原且新名字消失', async () => {
    writeFileSync(join(ws, 'old.txt'), 'body');

    const turnId = await runTurn('s3', async () => {
      await storage.rename('ws:/old.txt', 'new.txt');
    });
    expect(existsSync(join(ws, 'new.txt'))).toBe(true);

    const result = await svc.rollback('s3', turnId);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'old.txt'), 'utf-8')).toBe('body');
    expect(existsSync(join(ws, 'new.txt'))).toBe(false);
  });

  it('目录 move 回滚：整棵树移回原处', async () => {
    mkdirSync(join(ws, 'tree'), { recursive: true });
    writeFileSync(join(ws, 'tree', 'x.txt'), 'inside');

    const turnId = await runTurn('s4', async () => {
      await storage.move('ws:/tree', 'ws:/archive/tree');
    });
    expect(existsSync(join(ws, 'archive', 'tree', 'x.txt'))).toBe(true);

    const result = await svc.rollback('s4', turnId);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'tree', 'x.txt'), 'utf-8')).toBe('inside');
    expect(existsSync(join(ws, 'archive', 'tree'))).toBe(false);
  });

  it('move 后又改写目标：逆序回滚让源端复原且目标消失', async () => {
    writeFileSync(join(ws, 'a.txt'), 'orig');

    const turnId = await runTurn('s6', async () => {
      await storage.move('ws:/a.txt', 'ws:/b.txt');
      await storage.writeFile('ws:/b.txt', 'changed'); // 同回合内再改目标
    });
    expect(readFileSync(join(ws, 'b.txt'), 'utf-8')).toBe('changed');

    const result = await svc.rollback('s6', turnId);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'a.txt'), 'utf-8')).toBe('orig');
    expect(existsSync(join(ws, 'b.txt'))).toBe(false); // 正序回滚会把 b.txt 的快照又写回来
  });

  it('本回合新建后又移走：回滚两端都不留文件', async () => {
    const turnId = await runTurn('s10', async () => {
      await storage.writeFile('ws:/n.txt', 'new'); // write-new
      await storage.move('ws:/n.txt', 'ws:/dst/n.txt'); // 同回合内再移走同一 uri
    });
    expect(existsSync(join(ws, 'dst', 'n.txt'))).toBe(true);

    const manifest = await svc.getManifest('s10', turnId);
    expect(manifest?.files.map(f => f.action)).toEqual(['write-new', 'rename']); // 移动条目不得被 uri 去重吞掉

    const result = await svc.rollback('s10', turnId);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(existsSync(join(ws, 'dst', 'n.txt'))).toBe(false); // 目标端不能留
    expect(existsSync(join(ws, 'n.txt'))).toBe(false); // 源端也不能冒出来
  });

  it('本回合新建后又删掉：delete 条目被按 URI 去重吞掉，回滚仍 ok:true', async () => {
    const turnId = await runTurn('s12', async () => {
      await storage.writeFile('ws:/gone.txt', 'new'); // write-new
      await storage.delete('ws:/gone.txt'); // 同回合再删掉同一 uri（去重后不记 delete）
    });
    expect(existsSync(join(ws, 'gone.txt'))).toBe(false);

    const manifest = await svc.getManifest('s12', turnId);
    expect(manifest?.files.map(f => f.action)).toEqual(['write-new']);

    const result = await svc.rollback('s12', turnId);
    expect(result.errors).toEqual([]); // 目标已不在 = 期望状态已达成，不算失败
    expect(result.ok).toBe(true);
    expect(existsSync(join(ws, 'gone.txt'))).toBe(false);
  });

  it('本回合覆盖写后又移走：回滚源端复原原文、目标不留', async () => {
    writeFileSync(join(ws, 'o.txt'), 'orig');

    const turnId = await runTurn('s11', async () => {
      await storage.writeFile('ws:/o.txt', 'changed');
      await storage.move('ws:/o.txt', 'ws:/dst/o.txt');
    });
    expect(readFileSync(join(ws, 'dst', 'o.txt'), 'utf-8')).toBe('changed');

    const manifest = await svc.getManifest('s11', turnId);
    expect(manifest?.files.map(f => f.action)).toEqual(['write', 'rename']);
    expect(manifest?.files[1]?.blob).toBeUndefined(); // 补记的移动条目不重复备份内容

    const result = await svc.rollback('s11', turnId);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'o.txt'), 'utf-8')).toBe('orig'); // 先移回源端，再由 write 条目写回原文
    expect(existsSync(join(ws, 'dst', 'o.txt'))).toBe(false);
  });

  it('改名/移动连点两次回滚：第二次仍 ok:true（目标已不在不算失败）', async () => {
    writeFileSync(join(ws, 'c.txt'), 'body-c');

    const turnId = await runTurn('s7', async () => {
      await storage.move('ws:/c.txt', 'ws:/moved/c.txt');
    });

    const first = await svc.rollback('s7', turnId);
    expect(first.ok).toBe(true);

    const second = await svc.rollback('s7', turnId);
    expect(second.errors).toEqual([]);
    expect(second.ok).toBe(true);
    expect(readFileSync(join(ws, 'c.txt'), 'utf-8')).toBe('body-c');
    expect(existsSync(join(ws, 'moved', 'c.txt'))).toBe(false);
  });

  it('回落删目标因权限失败：如实入 errors 且 ok:false', async () => {
    writeFileSync(join(ws, 'p.txt'), 'body-p');

    const turnId = await runTurn('s9', async () => {
      await storage.move('ws:/p.txt', 'ws:/moved/p.txt');
    });

    // 故障 storage：move 抛错（强制走「写回源端 + 删目标」回落），删目标抛 EACCES——非 ENOENT，不该被豁免。
    // 另起一个读同一 checkpoint 目录的服务实例，经构造参数注入它
    const faulty: StorageService = {
      ...storage,
      move: async () => {
        throw new Error('EEXIST: target already exists');
      },
      delete: async uri => {
        const err = new Error(`EACCES: permission denied, unlink '${uri}'`) as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      },
    };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const faultySvc = new CheckpointServiceImpl(
      resolveConfig({ rootDir: 'data:/checkpoints', scopes: ['*'], keepSessions: 0 }),
      logger as never,
      faulty,
    );

    const result = await faultySvc.rollback('s9', turnId);
    expect(result.restored).toEqual(['ws:/p.txt']); // 源端已复原
    expect(result.deleted).toEqual([]); // 没谎报删掉
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.uri).toBe('ws:/moved/p.txt');
    expect(result.errors[0]?.reason).toContain('EACCES');
    expect(result.ok).toBe(false);
    expect(readFileSync(join(ws, 'p.txt'), 'utf-8')).toBe('body-p');
  });

  it('写目录：直接报错且不入账，回滚不会删掉整棵目录', async () => {
    mkdirSync(join(ws, 'd'), { recursive: true });
    writeFileSync(join(ws, 'd', 'inside.txt'), 'keep');

    const turnId = await runTurn('s8', async () => {
      await expect(storage.writeFile('ws:/d', 'x')).rejects.toThrow(/不能覆盖目录/);
      await storage.writeFile('ws:/other.txt', 'new'); // 有改动才落盘 manifest
    });

    const manifest = await svc.getManifest('s8', turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['ws:/other.txt']); // 目录不得留下幽灵 write-new

    const result = await svc.rollback('s8', turnId);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'd', 'inside.txt'), 'utf-8')).toBe('keep');
  });

  it('不记账的根（tmp / data）：写入与清理都不记账，回滚不被 ENOENT 带崩、也不碰 data 根', async () => {
    writeFileSync(join(ws, 'keep.txt'), 'orig');

    const turnId = await runTurn('s5', async () => {
      await storage.writeFile('ws:/keep.txt', 'changed');
      await storage.writeFile('tmp:/run-1/main.py', 'print(1)'); // code-runner 临时目录
      await storage.delete('tmp:/run-1'); // 回合结束前 cleanup 已删
      await storage.writeFile('data:/state.json', 'v2'); // 插件状态 / 别的平台落盘
    });

    const manifest = await svc.getManifest('s5', turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['ws:/keep.txt']); // 内部 tmp / data 路径不外泄

    const result = await svc.rollback('s5', turnId);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(ws, 'keep.txt'), 'utf-8')).toBe('orig');
    expect(String(await storage.readFile('data:/state.json', 'utf-8')), 'data 根文件不得被回滚改回').toBe('v2');
  });

  it('execUsed：exec_background / run_python 也算命令副作用', async () => {
    for (const [sessionId, toolName] of [
      ['e1', 'exec'],
      ['e2', 'exec_background'],
      ['e3', 'run_python'],
      ['e4', 'file_write'],
    ] as const) {
      const turnId = await runTurn(sessionId, async () => {
        await hooks.run('agent:tool:before', {
          name: toolName,
          args: {},
          toolCallContext: { sessionId },
        } as never);
        await storage.writeFile(`ws:/${sessionId}.txt`, 'x'); // 有改动才落盘 manifest
      });
      const [summary] = await svc.listTurns(sessionId);
      expect(summary?.turnId).toBe(turnId);
      expect(summary?.execUsed ?? false).toBe(toolName !== 'file_write');
    }
  });
});

// ════════════════════════════════════════════════════════════
// rootDir 只接受 storage URI：旧的相对路径写法（data/checkpoints）不再被归一，直接拒绝激活，
// 否则回合内每次写 blob 都抛「URI 不合法」，连带让那次存储写入失败。未设或留空仍用默认值。
// ════════════════════════════════════════════════════════════
describe('checkpoint rootDir 配置', () => {
  it('storage URI 原样采用；未设、留空或非字符串用默认值', () => {
    expect(resolveConfig({ rootDir: 'ws:/cp' }).rootUri).toBe('ws:/cp');
    expect(resolveConfig({ rootDir: '  data:/cp  ' }).rootUri).toBe('data:/cp');
    expect(resolveConfig({}).rootUri).toBe('data:/checkpoints');
    expect(resolveConfig({ rootDir: '   ' }).rootUri).toBe('data:/checkpoints');
    expect(resolveConfig({ rootDir: 42 }).rootUri).toBe('data:/checkpoints');
  });

  it.each([
    'data/checkpoints',
    'checkpoints',
    './data/checkpoints',
  ])('非 URI 写法（%s）报错，文案给出正确写法', input => {
    expect(() => resolveConfig({ rootDir: input })).toThrow(/rootDir=.*不是 storage URI.*data:\/checkpoints/);
  });
});
