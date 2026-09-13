import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageService, StorageWatchEvent } from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import * as storageLocalModule from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// watch 文件 URI 分支：曾直接 fs.watch 文件本身——回调给的 filename 是文件自己的名字，
// 拼到相对路径后事件路径翻倍（notes/a.txt/a.txt）；且 watcher 绑定 inode，storage 的
// 原子写（临时文件 rename 覆盖）换掉 inode 后再无事件。现改为监听父目录按文件名过滤。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
};

describe('storage-local watch 文件 URI', () => {
  let base: string;
  let app: App;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-watch-'));
    mkdirSync(join(base, 'data', 'notes'), { recursive: true });
    writeFileSync(join(base, 'data', 'notes', 'a.txt'), 'v0');
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.ctx.useModule(storageLocalModule as never, {
      roots: [
        {
          name: 'data',
          path: join(base, 'data'),
          label: 'data',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugins.idle();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('事件路径不翻倍；原子覆盖写换掉 inode 后仍有事件', async () => {
    const storage = app.ctx.getService<StorageService>('storage')!;
    const events: StorageWatchEvent[] = [];
    const unwatch = storage.watch!('data:/notes/a.txt', e => {
      events.push(e);
    });
    try {
      await sleep(100); // 等 watcher 就绪

      await storage.writeFile('data:/notes/a.txt', 'v1');
      expect(await waitUntil(() => events.length >= 1), '第一次覆盖写应有事件').toBe(true);
      for (const e of events) {
        expect(e.uri).toBe('data:/notes/a.txt');
        expect(e.path).toBe('notes/a.txt');
      }

      const seen = events.length;
      await sleep(150); // 越过去抖窗口
      await storage.writeFile('data:/notes/a.txt', 'v2');
      expect(await waitUntil(() => events.length > seen), '第二次原子覆盖后无事件：watcher 绑在旧 inode 上').toBe(true);
      expect(events.every(e => e.path === 'notes/a.txt')).toBe(true);
    } finally {
      unwatch();
    }
  });
});
