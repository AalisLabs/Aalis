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
// checkpoint 不给白纸根 paper 记账：白纸的成品由枢纽在任意会话的回合进行中写入，
// 记进那个回合的话，回滚那一轮会把与这轮无关的成品删掉。
// 同一回合里 workspace 的改动照常记账、照常回滚。
// ════════════════════════════════════════════════════════════

describe('checkpoint × 白纸根', () => {
  let base: string;
  let app: App;
  let storage: StorageService;
  let svc: CheckpointServiceImpl;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-cp-paper-'));
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

  it('回合进行中写入、删除 paper:/ 不记账，回滚不动白纸文件', async () => {
    const paperDir = join(base, 'data', 'stage', 'paper');
    mkdirSync(join(paperDir, 'old'), { recursive: true });
    writeFileSync(join(paperDir, 'old', 'prev.png'), 'prev');
    writeFileSync(join(base, 'ws', 'keep.txt'), 'orig');

    svc.beginTurn('s1');
    await storage.writeFile('ws:/keep.txt', 'changed');
    await storage.writeFile('paper:/task-1/out.png', 'artifact');
    await storage.delete('paper:/old/prev.png');
    await svc.endTurn('s1');

    const [turn] = await svc.listTurns('s1');
    const manifest = await svc.getManifest('s1', (turn as { turnId: string }).turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['ws:/keep.txt']);

    const result = await svc.rollback('s1', (turn as { turnId: string }).turnId);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(base, 'ws', 'keep.txt'), 'utf-8')).toBe('orig');
    expect(readFileSync(join(paperDir, 'task-1', 'out.png'), 'utf-8'), '回滚不得删掉白纸成品').toBe('artifact');
    expect(existsSync(join(paperDir, 'old', 'prev.png')), '回滚不得把白纸里删掉的文件写回').toBe(false);
  });
});
