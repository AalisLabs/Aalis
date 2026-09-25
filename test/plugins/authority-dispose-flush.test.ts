import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type App, provide } from '../../packages/core/src/index.js';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { mkConfig, silentLogger } from '../fixtures/authority.js';

// users.json 落盘：save() 只把写挂到 saveChain 上就同步返回。拆卸路径必须 await flushed()，
// 否则 CLI 子命令退出与 bounce 会丢掉封禁/等级。plugin-authority 在 lifecycle.onDispose 里
// 先 save() 再 await flushed()，停机才能等到在飞写入。

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
    const m = new AuthorityManager(mkConfig({ owners: [] }), silentLogger(), slowStorage(done));

    m.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5); // 封禁：安全语义，丢不得
    m.save();

    expect(done.written, '前置：save() 是同步返回的，此刻写还没落').toBe(false);

    await m.flushed();
    expect(done.written, 'flushed() 必须等到写完——拆卸路径靠它，不能返回一个空 promise').toBe(true);
  });

  it('没有待写内容时 flushed() 也能正常返回', async () => {
    const done = { written: false };
    const m = new AuthorityManager(mkConfig({ owners: [] }), silentLogger(), slowStorage(done));
    await expect(m.flushed()).resolves.toBeUndefined();
  });

  // saveChain 每一环都用 .then(ok, err) 收尾：一次写失败（磁盘满、权限）不能让链停在 rejected，
  // 否则拆卸路径 await flushed() 会抛，此后本进程的封禁与等级改动也都不再落盘。
  it('一次写失败不卡住落盘链：flushed() 不抛，下一次 save 照常写出最新快照', async () => {
    const payloads: string[] = [];
    const flaky = {
      async readFile() {
        throw new Error('不存在');
      },
      async writeFile(_uri: string, data: string) {
        payloads.push(data);
        if (payloads.length === 1) throw new Error('ENOSPC');
      },
    } as unknown as StorageService;
    const m = new AuthorityManager(mkConfig({ owners: [] }), silentLogger(), flaky);
    await m.init();
    const alice = { platform: 'onebot', userId: 'alice' };

    m.setUserLevel(alice, 3);
    m.save();
    await expect(m.flushed(), '写失败被链吸收，拆卸路径 await 它不抛').resolves.toBeUndefined();

    m.setUserLevel(alice, -5);
    m.save();
    await m.flushed();
    expect(payloads, '第一次写失败后链仍能续上').toHaveLength(2);
    expect(JSON.parse(payloads[1] ?? '{}').users['onebot:alice'].level).toBe(-5);
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
