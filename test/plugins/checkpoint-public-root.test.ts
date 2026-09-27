import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStorageGateway,
  type StorageService,
  storage as storageService,
} from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import checkpointPlugin, { checkpoint } from '../../packages/plugin-checkpoint/src/index.js';
import type { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// checkpoint 不给公开根 public 记账：发布服务在审核结束、owner 裁决或撤下时写删公开根，
// 这些时刻可能正好有某个会话（例如 owner 的 WebUI 会话）的回合在进行，记进那一轮的话，
// 回滚那一轮会把已发布的作品删掉、或把撤下的作品写回来。
// 同一回合里 workspace 的改动照常记账、照常回滚。
// ════════════════════════════════════════════════════════════

/** 占位作品编号（10 位 [a-z2-7]） */
const WORK_ID = 'abcde23456';
const OLD_WORK_ID = 'zyxwv76543';

describe('checkpoint × 公开根', () => {
  let base: string;
  let app: App;
  let storage: StorageService;
  let svc: CheckpointServiceImpl;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'works-cp-public-'));
    vi.spyOn(process, 'cwd').mockReturnValue(base);
    const ws = join(base, 'ws');
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
      ],
    });
    await app.plugins.register(checkpointPlugin, { rootDir: 'data:/checkpoints', scopes: ['*'], keepSessions: 0 });
    await app.plugins.idle();
    const host = app.bind({ storage: storageService, checkpoint });
    storage = createStorageGateway(host.storage);
    // beginTurn / endTurn 是实现类上的驱动面，不在对外服务契约里
    svc = host.checkpoint.require() as CheckpointServiceImpl;
  });

  afterEach(async () => {
    await app.stop();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('回合进行中写入、删除 public:/ 不记账，回滚不动公开根里的文件', async () => {
    const publicDir = join(base, 'data', 'stage', 'public');
    mkdirSync(join(publicDir, OLD_WORK_ID, 'files'), { recursive: true });
    writeFileSync(join(publicDir, OLD_WORK_ID, 'files', 'work.png'), 'prev');
    writeFileSync(join(base, 'ws', 'keep.txt'), 'orig');

    svc.beginTurn('s1');
    await storage.writeFile('ws:/keep.txt', 'changed');
    await storage.writeFile(`public:/${WORK_ID}/files/index.html`, 'published');
    await storage.writeFile(`public:/${WORK_ID}/thumb.png`, 'thumb');
    await storage.delete(`public:/${OLD_WORK_ID}/files/work.png`);
    await svc.endTurn('s1');

    const [turn] = await svc.listTurns('s1');
    const turnId = (turn as { turnId: string }).turnId;
    const manifest = await svc.getManifest('s1', turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['ws:/keep.txt']);

    const result = await svc.rollback('s1', turnId);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(base, 'ws', 'keep.txt'), 'utf-8')).toBe('orig');
    expect(readFileSync(join(publicDir, WORK_ID, 'files', 'index.html'), 'utf-8'), '回滚不得删掉已发布的作品').toBe(
      'published',
    );
    expect(readFileSync(join(publicDir, WORK_ID, 'thumb.png'), 'utf-8')).toBe('thumb');
    expect(existsSync(join(publicDir, OLD_WORK_ID, 'files', 'work.png')), '回滚不得把撤下时删掉的文件写回').toBe(false);
  });
});
