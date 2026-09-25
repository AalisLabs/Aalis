import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type StorageService,
  type StorageWatchEvent,
  storage as storageService,
} from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// watch 文件 URI 分支：曾直接 fs.watch 文件本身——回调给的 filename 是文件自己的名字，
// 拼到相对路径后事件路径翻倍（notes/a.txt/a.txt）；且 watcher 绑定 inode，storage 的
// 原子写（临时文件 rename 覆盖）换掉 inode 后再无事件。现改为监听父目录按文件名过滤。
//
// 监听器归属：watch 建的 fs 监听器曾只由调用方的退订关闭，提供者重启 / 卸载后旧监听器仍在，
// 继续上报一个已不属于当前存储根的旧路径。现登记为提供者这次激活的清理项，随提供者一并关闭。
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

describe('storage-local watch', () => {
  let base: string;
  let app: App;
  let storage: StorageService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-watch-'));
    mkdirSync(join(base, 'data', 'notes'), { recursive: true });
    writeFileSync(join(base, 'data', 'notes', 'a.txt'), 'v0');
    app = new App({ name: 'T', logLevel: 'error' });
    await app.plugin(storageLocal, {
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
    // 停在 pending 会让「没有事件」看起来像被测行为出错，先把激活闸的结果钉死
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    storage = app.bind({ storage: storageService }).storage.require();
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('事件路径不翻倍；原子覆盖写换掉 inode 后仍有事件', async () => {
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

  it.each(['bounce', 'unload'] as const)('提供者关闭（%s）后旧监听器不再报事件', async action => {
    const events: StorageWatchEvent[] = [];
    const unwatch = storage.watch!('data:/notes', e => {
      events.push(e);
    });
    await sleep(100); // 等 watcher 就绪

    if (action === 'bounce') await app.plugins.bounce(storageLocal.name);
    else await app.plugins.unload(storageLocal.name);
    await app.plugins.idle();
    await sleep(100);
    // 关闭前 FSEvents 可能迟到投递的事件不算，只看关闭之后
    events.length = 0;

    writeFileSync(join(base, 'data', 'notes', 'after-close.txt'), 'x');
    await sleep(500);
    expect(events, '旧监听器在提供者关闭后仍在上报').toEqual([]);
    // 已被提供者关掉的监听，调用方再退订是空操作
    expect(() => unwatch()).not.toThrow();
  });
});
