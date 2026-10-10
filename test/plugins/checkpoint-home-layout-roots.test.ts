import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { type StorageService, storage as storageService } from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import type { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// checkpoint × 按家目录布局派生的内置根：缓存区（cache）与 self 下的人设卡、技能、编排定义根（kind self）
// 都不记账：任何会话都能经工具写技能与人设，写入没有会话归属，记进正在进行的回合会被那一轮的回滚误撤。
// 工作根（workspace）照常记账。
// ════════════════════════════════════════════════════════════

describe('checkpoint × 家目录布局的内置根', () => {
  let base: string;
  let app: App;
  let storage: StorageService;
  let svc: CheckpointServiceImpl;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-cp-layout-'));
    mkdirSync(join(base, 'ws'), { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    provideHostPaths(app, base);
    await app.plugins.register(storageLocalPlugin, {
      roots: [
        { name: 'ws', path: join(base, 'ws'), kind: 'workspace', readable: true, writable: true, deletable: true },
      ],
    });
    await app.plugins.register(checkpointPlugin, { rootDir: 'data:/checkpoints', scopes: ['*'], keepSessions: 0 });
    await app.plugins.idle();
    const host = app.bind({ storage: storageService, checkpoint });
    storage = host.storage.use;
    svc = host.checkpoint.use as CheckpointServiceImpl;
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('写 cache:/、skills:/、personas:/ 不记账，回滚不动它们；同一轮写工作根的照常回滚', async () => {
    await svc.runTurn('turn-s1', 's1', async () => {
      await storage.writeFile('ws:/note.txt', 'w');
      await storage.writeFile('cache:/thumb.png', 'c');
      await storage.writeFile('skills:/demo/SKILL.md', 'skill');
      await storage.writeFile('personas:/main.yaml', 'name: x\n');
    });

    const [turn] = await svc.listTurns('s1');
    const turnId = (turn as { turnId: string }).turnId;
    const manifest = await svc.getManifest('s1', turnId);
    expect(manifest?.files.map(f => f.uri)).toEqual(['ws:/note.txt']);

    const rolled = await svc.rollback('s1', turnId);
    expect(rolled, JSON.stringify(rolled)).toMatchObject({ ok: true });
    await expect(storage.stat('ws:/note.txt')).rejects.toThrow();
    expect(await storage.readFile('skills:/demo/SKILL.md', 'utf-8')).toBe('skill');
    expect(await storage.readFile('cache:/thumb.png', 'utf-8')).toBe('c');
  });
});
