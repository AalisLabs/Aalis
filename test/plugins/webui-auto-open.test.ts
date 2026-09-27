import { afterEach, describe, expect, it } from 'vitest';
import { type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';

// autoOpen 只在访问 token 是本次新生成时打开浏览器。沿用已有 token（persist 读回、fixed）时浏览器里的 cookie 仍有效，
// 再开一页只是重复；而 app:ready 是粘性事件，插件每次 bounce（改它的配置、配置文件热重载）重新订阅都会再收到一次，
// 不按 token 判断就每重载一次多开一个标签页。这里替换 process 服务记下每次打开，storage 用内存表代替磁盘，
// 同一张表跨两次启动即模拟 token 文件留在盘上。

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
async function opensOverStartAndBounce(tokenMode: string, disk: Map<string, string>): Promise<number[]> {
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
    autoOpen: true,
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

describe('webui-server autoOpen：只在 token 新生成时打开浏览器', () => {
  it('persist：首次启动生成并写入 token 时打开一次，bounce 与再次启动读回同一 token，不再打开', async () => {
    const disk = new Map<string, string>();
    expect(await opensOverStartAndBounce('persist', disk)).toEqual([1, 1]);
    expect(await opensOverStartAndBounce('persist', disk), '再次启动').toEqual([0, 0]);
  });

  it('ephemeral：每次激活都换 token、旧页面失效，每次都打开', async () => {
    expect(await opensOverStartAndBounce('ephemeral', new Map())).toEqual([1, 2]);
  });

  it('fixed：token 来自配置，不打开', async () => {
    expect(await opensOverStartAndBounce('fixed', new Map())).toEqual([0, 0]);
  });
});
