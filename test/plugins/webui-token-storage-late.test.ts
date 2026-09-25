import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// persist 模式的 token 跟随 storage 读回：storage 是 optional、不参与激活拓扑，同一批登记时
// webui-server 可以先于 storage-local 激活。曾经只在 apply 里读一次：那一刻没有 storage，
// 内存里是新随机 token，持久化的那份被晾在一边——旧 cookie 与 `?token=<持久化>` 一律 401，
// access.txt 写成新 token；没有 token 文件时也永远建不起来，persist 退化成 ephemeral。
// 真 storage-local 多根（workspace 在前、data 在后），token 落在 data 根。
// ════════════════════════════════════════════════════════════

const PERSISTED = 'zz-persisted-token-placeholder';
const COOKIE = 'aalis_webui_token';

describe('webui-server token：storage 晚于本插件上线', () => {
  let base: string;
  let app: App;
  let port: number;

  const tokenFile = () => join(base, 'data', 'webui', 'token');
  const accessFile = () => join(base, 'data', 'webui', 'access.txt');
  const seedToken = () => {
    mkdirSync(join(base, 'data', 'webui'), { recursive: true });
    writeFileSync(tokenFile(), PERSISTED);
  };
  const accessToken = (): string | undefined => {
    if (!existsSync(accessFile())) return undefined;
    return /^Token: (.+)$/m.exec(readFileSync(accessFile(), 'utf-8'))?.[1];
  };

  const storageLocal = () => ({
    definition: storageLocalPlugin,
    config: {
      roots: ['workspace', 'data'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name,
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    },
  });
  const webui = () => ({
    definition: webuiServerPlugin,
    config: { port, host: '127.0.0.1', autoOpen: false },
  });

  /** `?token=` 一键登录的状态码：302 = token 被认，401 = 不认 */
  const loginStatus = async (token: string): Promise<number> =>
    (await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })).status;
  /** 带 cookie 访问任意受保护 API：认证通过时落到 /api 的 404，不通过是 401 */
  const cookieStatus = async (token: string): Promise<number> =>
    (await fetch(`http://127.0.0.1:${port}/api/zz-probe`, { headers: { Cookie: `${COOKIE}=${token}` } })).status;

  async function waitUntil(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 150; i++) {
      try {
        if (await cond()) return;
      } catch {
        /* 服务尚未监听 */
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`等待超时: ${what}`);
  }

  /** 服务在监听、且 listen 回调写出了 access.txt */
  const listening = () => waitUntil(async () => accessToken() !== undefined, 'WebUI 监听并写出 access.txt');

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-webui-token-'));
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
    port = await freePort();
    app = new App({ name: 'T', logLevel: 'error' });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('同批登记、webui 在前，已有持久化 token：沿用它，旧 cookie 与一键登录照常可用', async () => {
    seedToken();
    await app.pluginAll([webui(), storageLocal()]);
    await app.start();
    await listening();

    expect(await loginStatus(PERSISTED)).toBe(302);
    expect(await cookieStatus(PERSISTED)).not.toBe(401);
    expect(accessToken()).toBe(PERSISTED);
    expect(readFileSync(tokenFile(), 'utf-8')).toBe(PERSISTED);
  });

  it('同批登记、webui 在前，没有 token 文件：建起持久化文件，与 access.txt 一致', async () => {
    await app.pluginAll([webui(), storageLocal()]);
    await app.start();
    await listening();

    expect(existsSync(tokenFile()), 'persist 不得退化成 ephemeral').toBe(true);
    const persisted = readFileSync(tokenFile(), 'utf-8');
    expect(accessToken()).toBe(persisted);
    expect(await loginStatus(persisted)).toBe(302);
  });

  it.each([
    ['已有持久化 token', true],
    ['没有 token 文件', false],
  ])('storage 在前（%s）：行为不变', async (_label, seeded) => {
    if (seeded) seedToken();
    await app.pluginAll([storageLocal(), webui()]);
    await app.start();
    await listening();

    const persisted = readFileSync(tokenFile(), 'utf-8');
    if (seeded) expect(persisted).toBe(PERSISTED);
    expect(accessToken()).toBe(persisted);
    expect(await loginStatus(persisted)).toBe(302);
  });

  it('storage 在监听之后才上线：读回持久化 token 并重写 access.txt', async () => {
    seedToken();
    await app.pluginAll([webui()]);
    await app.start();
    await waitUntil(async () => (await loginStatus('zz-wrong')) === 401, 'WebUI 开始监听');
    expect(await loginStatus(PERSISTED), 'storage 未上线时持久化 token 读不到').toBe(401);

    await app.pluginAll([storageLocal()]);
    await waitUntil(async () => (await loginStatus(PERSISTED)) === 302, '读回持久化 token');
    await waitUntil(() => accessToken() === PERSISTED, 'access.txt 重写为持久化 token');
    expect(readFileSync(tokenFile(), 'utf-8')).toBe(PERSISTED);
  });

  it('storage 在启动前上线、读回尚未落定：监听等读回完成，access.txt 从第一次写起就是持久化 token', async () => {
    // 假 storage 卡住 token 的读取：app:ready 若不等读回，listen 会先用临时 token 写 access.txt、打开浏览器
    let releaseRead = () => {};
    const readGate = new Promise<void>(r => {
      releaseRead = r;
    });
    const accessWrites: string[] = [];
    const fake = {
      listRoots: () => [{ name: 'data', label: 'Data', kind: 'data', readable: true, writable: true }],
      async readFile(uri: string) {
        if (uri !== 'data:/webui/token') throw new Error(`ENOENT: ${uri}`);
        await readGate;
        return PERSISTED;
      },
      async writeFile(uri: string, data: string) {
        if (uri === 'data:/webui/access.txt') accessWrites.push(data);
      },
    } as unknown as StorageService;

    // 与 storage-local 同样经插件激活上线，排在 webui 之后
    const fakeStorage = definePlugin({
      name: 'zz-fake-storage',
      provides: [storage],
      uses: { provide },
      apply(caps) {
        caps.provide(storage, fake);
      },
    });
    await app.pluginAll([webui(), { definition: fakeStorage, config: {} }]);
    const started = app.start();
    setTimeout(releaseRead, 100);
    await started;
    await waitUntil(() => accessWrites.length > 0, 'listen 写出 access.txt');

    expect(accessWrites.every(w => w.includes(`Token: ${PERSISTED}`))).toBe(true);
    expect(await loginStatus(PERSISTED)).toBe(302);
  });
});
