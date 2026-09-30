import { afterEach, describe, expect, it } from 'vitest';
import { type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';

// 每个 App 首次监听成功都应打开，不能把「token 已持久化」误当成「本次已经开过浏览器」。
// 同一 App 的普通 bounce 不重复打开；ephemeral 换 token 后仍要重新登录。
// process 用计数替身、storage 用内存表，同一张表跨两次启动模拟磁盘 token。

const ACCESS = 'data:/webui/access.txt';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`等待超时: ${what}`);
}

/** 启动一次、再 bounce 一次，返回两个时点累计打开浏览器的次数 */
async function opensOverStartAndBounce(
  tokenMode: string,
  disk: Map<string, string>,
  autoOpen = true,
): Promise<number[]> {
  let opened = 0;
  let listened = 0;
  const fakeProcess = {
    spawn() {
      opened++;
      return { wait: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }), unref() {} };
    },
  } as unknown as ProcessService;
  const fakeStorage = {
    listRoots: () => [
      { name: 'data', label: 'Data', kind: 'data', browsable: false, readable: true, writable: true, deletable: true },
    ],
    async readFile(uri: string) {
      const value = disk.get(uri);
      if (value === undefined) throw new Error(`ENOENT: ${uri}`);
      return value;
    },
    async writeFile(uri: string, value: string) {
      disk.set(uri, value);
      if (uri === ACCESS) listened++; // listen 回调写 access.txt：据此知道这次监听已走完（打开浏览器在同一回调里）
    },
    async resolveLocalPath() {
      return '/tmp/zz-webui-auto-open/access.txt';
    },
  } as unknown as StorageService;

  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  apps.push(app);
  const host = app.bind({ provide });
  host.provide(processService, fakeProcess);
  host.provide(storage, fakeStorage);
  await app.plugin(webuiServer, {
    port: 0,
    host: '127.0.0.1',
    autoOpen,
    tokenMode,
    fixedToken: tokenMode === 'fixed' ? 'zz-fixed-token-placeholder' : '',
  });
  await app.plugins.idle();
  await app.start();
  await until(() => listened === 1, '首次监听');
  const afterStart = opened;
  expect(await app.plugins.bounce(webuiServer.name)).toBe(true);
  await app.plugins.idle();
  await until(() => listened === 2, 'bounce 后重新监听');
  return [afterStart, opened];
}

describe('webui-server autoOpen：每次应用启动打开，同 token 热重载不重复', () => {
  it('persist：首次启动和再次启动各打开一次，bounce 读回同一 token 不再打开', async () => {
    const disk = new Map<string, string>();
    expect(await opensOverStartAndBounce('persist', disk)).toEqual([1, 1]);
    expect(await opensOverStartAndBounce('persist', disk), '再次启动').toEqual([1, 1]);
  });

  it('ephemeral：每次激活都换 token、旧页面失效，每次都打开', async () => {
    expect(await opensOverStartAndBounce('ephemeral', new Map())).toEqual([1, 2]);
  });

  it('fixed：启动打开一次，bounce 不重复打开', async () => {
    expect(await opensOverStartAndBounce('fixed', new Map())).toEqual([1, 1]);
  });

  it.each(['persist', 'ephemeral', 'fixed'])('%s：autoOpen=false 始终不打开', async tokenMode => {
    expect(await opensOverStartAndBounce(tokenMode, new Map(), false)).toEqual([0, 0]);
  });
});
