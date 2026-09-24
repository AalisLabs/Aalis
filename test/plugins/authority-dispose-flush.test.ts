import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import type { HostConfig } from '../../packages/api-host-config/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';

// users.json 落盘：save() 只把写挂到 saveChain 上就同步返回。拆卸路径必须 await flushed()，
// 否则 CLI 子命令退出与 bounce 会丢掉封禁/等级。plugin-authority 在 lifecycle.onDispose 里
// 先 save() 再 await flushed()，停机才能等到在飞写入。

function mkConfig(): HostConfig {
  const store: Record<string, unknown> = { owners: [] };
  return {
    get: (k: string) => store[k],
    set: (k: string, v: unknown) => {
      store[k] = v;
    },
  } as unknown as HostConfig;
}
function mkLogger(): Logger {
  const l = { child: () => l, debug() {}, info() {}, warn() {}, error() {} };
  return l as unknown as Logger;
}

/** 慢写 storage：不等待就一定观察得到（否则可能碰巧写完） */
function slowStorage(done: { written: boolean }): StorageService {
  return {
    async writeFile() {
      await new Promise(r => setTimeout(r, 40));
      done.written = true;
    },
    async readFile() {
      throw new Error('不存在');
    },
  } as unknown as StorageService;
}

const DATA_ROOT: StorageRootInfo = {
  name: 'data',
  label: 'data',
  kind: 'data',
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
};

function pluginSlowStorage(done: { written: boolean; uri?: string }): StorageService {
  return {
    listRoots: () => [DATA_ROOT],
    async readFile() {
      throw new Error('不存在');
    },
    async writeFile(uri: string) {
      await new Promise(r => setTimeout(r, 40));
      done.written = true;
      done.uri = uri;
    },
  } as unknown as StorageService;
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

describe('authority 落盘必须可被拆卸路径等待', () => {
  it('flushed() 等到写真正完成；不等它则写还在飞', async () => {
    const done = { written: false };
    const m = new AuthorityManager(mkConfig(), mkLogger(), slowStorage(done));

    m.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5); // 封禁：安全语义，丢不得
    m.save();

    expect(done.written, '前置：save() 是同步返回的，此刻写还没落').toBe(false);

    await m.flushed();
    expect(done.written, 'flushed() 必须等到写完——拆卸路径靠它，不能返回一个空 promise').toBe(true);
  });

  it('没有待写内容时 flushed() 也能正常返回', async () => {
    const done = { written: false };
    const m = new AuthorityManager(mkConfig(), mkLogger(), slowStorage(done));
    await expect(m.flushed()).resolves.toBeUndefined();
  });

  it('装配真实 plugin-authority 后 app.stop 等到 onDispose 落盘', async () => {
    const done = { written: false } as { written: boolean; uri?: string };
    const { app } = hostedApp();
    apps.push(app);
    const host = app.bind({ provide, authority });
    host.provide(storage, pluginSlowStorage(done));
    await app.plugin(authorityPlugin, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin(authorityPlugin.name)?.state).toBe('active');

    const mgr = host.authority.current;
    if (!mgr) throw new Error('authority 未发布');
    mgr.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5);
    mgr.save();
    expect(done.written, 'save() 同步返回，此刻写还在飞').toBe(false);

    await app.stop();
    expect(done.written, '停机必须跑到插件 onDispose 的 flushed()，等到在飞写入').toBe(true);
    expect(done.uri).toBe('data:/users.json');
  });
});
