import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type App, type Logger, provide } from '../../packages/core/src/index.js';
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
    await m.init(); // 首次读取落定之前 save 不写盘

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

  // 写链回调里的上报本身也会失败：拒绝值转不成字符串（null 原型对象），或宿主经 AppOptions.logger 注入的
  // logger 抛错。链一旦停在 rejected，flushed() 抛、此后的写不再发出，load 收尾那次无人等待的保存还会成为未处理的拒绝。
  it('写失败的拒绝值转不成字符串：照样记 error、置失败标记，flushed() 不抛', async () => {
    const errors: unknown[][] = [];
    const logger = {
      child: () => logger,
      debug() {},
      info() {},
      warn() {},
      error: (...args: unknown[]) => errors.push(args),
    } as unknown as Logger;
    const storage = {
      async readFile() {
        throw new Error('不存在');
      },
      async writeFile() {
        throw Object.create(null);
      },
    } as unknown as StorageService;
    const m = new AuthorityManager(mkConfig({ owners: [] }), logger, storage);
    await m.init();

    m.setUserLevel({ platform: 'onebot', userId: 'alice' }, -5);
    m.save();
    await expect(m.flushed(), '失败回调拼接拒绝值时抛错，链停在拒绝').resolves.toBeUndefined();
    expect(m.lastSaveFailed).toBe(true);
    expect(errors, '写失败没有记下 error').toHaveLength(1);
  });

  it('宿主注入的 logger 抛错：写成功与写失败的上报都不让链停在拒绝', async () => {
    const payloads: string[] = [];
    let failing = false;
    const storage = {
      async readFile() {
        throw new Error('不存在');
      },
      async writeFile(_uri: string, data: string) {
        if (failing) throw new Error('ENOSPC');
        payloads.push(data);
      },
    } as unknown as StorageService;
    // 只让等级表那一层的日志抛：manager 自己的 debug 照常。首次读取落定之前 save 不写盘，
    // 读取时的日志照常，读完才开始抛
    let sinkBroken = false;
    const sink = (): void => {
      if (sinkBroken) throw new Error('sink 挂了');
    };
    const storeLogger = { child: () => storeLogger, debug: sink, info: sink, warn: sink, error: sink };
    const logger = { child: () => storeLogger, debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const m = new AuthorityManager(mkConfig({ owners: [] }), logger, storage);
    await m.init();
    sinkBroken = true;
    const alice = { platform: 'onebot', userId: 'alice' };

    m.setUserLevel(alice, 3);
    m.save();
    await expect(m.flushed(), '写成功的上报抛错，链停在拒绝').resolves.toBeUndefined();

    failing = true;
    m.setUserLevel(alice, -5);
    m.save();
    await expect(m.flushed(), '写失败的上报抛错，链停在拒绝').resolves.toBeUndefined();
    expect(m.lastSaveFailed).toBe(true);

    failing = false;
    m.setUserLevel(alice, -6);
    m.save();
    await m.flushed();
    expect(JSON.parse(payloads.at(-1) ?? '{}').users['onebot:alice'].level, '链停在拒绝后不再真正写盘').toBe(-6);
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
