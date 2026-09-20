import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { webuiClient } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';

// ════════════════════════════════════════════════════════════
// 切换前端偏好的处理器要做三件事：改服务偏好、写配置、重挂静态目录。前两件与第三件同属
// 内存态，必须在等落盘之前一起生效。若重挂排在 await save 之后，保存拒绝时会留下
// 「服务解析已选 B、HTTP 静态目录仍挂 A」的不一致，且处理器退出后无人修复。
// 本文件真起 webui-server，用拒绝的 configProvider 钉住「重挂不依赖落盘成功」。
// ════════════════════════════════════════════════════════════

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(r => probe.close(() => r()));
  return port;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function silentLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

function makeFakeStorage(): StorageService {
  const roots: StorageRootInfo[] = [
    { name: 'data', label: 'Data', kind: 'data', browsable: false, readable: true, writable: true, deletable: true },
  ] as unknown as StorageRootInfo[];
  return {
    listRoots: () => roots,
    async writeFile() {},
    async readFile(uri: string) {
      throw new Error(`ENOENT: ${uri}`);
    },
    async resolveLocalPath() {
      return '/tmp/aalis-test-root/webui/access.txt';
    },
    async list() {
      return { entries: [] };
    },
    async stat() {
      throw new Error('未实现');
    },
    async delete() {
      throw new Error('未实现');
    },
    async mkdir() {},
  } as unknown as StorageService;
}

function clientDir(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aalis-webui-client-'));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${marker}</title>`);
  return dir;
}

/**
 * 最小前端提供者：偏好按登记者的逻辑身份点名，所以两份前端必须来自两次不同身份的激活，
 * 插件名即那个身份（HTTP 里的 contextId）。
 */
function clientProvider(name: string, dir: string) {
  return definePlugin({
    name,
    provides: [webuiClient],
    uses: { provide },
    apply({ provide }) {
      provide(webuiClient, { getClientDir: () => dir });
    },
  });
}

describe('webui-server 前端偏好切换：重挂不依赖落盘成功', () => {
  const apps: App[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const a of apps.splice(0)) {
      try {
        await a.stop();
      } catch {
        /* 停不掉也要继续 */
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('保存拒绝：POST/DELETE prefer 都以错误返回，但静态目录已同步跟上', async () => {
    const dirA = clientDir('CLIENT-A');
    const dirB = clientDir('CLIENT-B');
    dirs.push(dirA, dirB);
    const port = await freePort();
    const token = 'test-fixed-token-placeholder';
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: {} },
      logger: silentLogger(),
      configProvider: {
        save: async () => {
          throw new Error('disk full');
        },
      },
    });
    apps.push(app);
    const host = app.bind({ provide, webuiClient });
    host.provide(storage, makeFakeStorage());
    // 先注册者默认胜出：A 是启动时挂载的前端，B 是切换目标。逐个 await，登记顺序才确定。
    await app.plugin(clientProvider('clientA', dirA));
    await app.plugin(clientProvider('clientB', dirB));
    await app.plugins.idle();
    for (const id of ['clientA', 'clientB']) {
      // 装载过激活闸：探针没激活时前端根本没登记，后面的断言会退化成「两边都是 A」
      if (app.plugins.getPlugin(id)?.state !== 'active') throw new Error(`前端探针 ${id} 未激活`);
    }
    await app.plugins.register(webuiServer, {
      port,
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'fixed',
      fixedToken: token,
    });
    await app.plugins.idle();
    await app.start();

    const base = `http://127.0.0.1:${port}`;
    const headers = { Cookie: `aalis_webui_token=${token}` };
    const home = async () => (await fetch(`${base}/`, { headers })).text();
    let first = '';
    for (let i = 0; i < 100 && !first.includes('CLIENT-A'); i++) {
      try {
        first = await home();
      } catch {
        await sleep(20);
      }
    }
    expect(first, '前置：启动后挂的是先注册的 A').toContain('CLIENT-A');

    const res = await fetch(`${base}/api/services/webui-client/prefer`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ contextId: 'clientB' }),
    });
    expect(res.ok, '落盘失败必须以错误响应传出，不能报 200').toBe(false);
    expect(host.webuiClient.current?.getClientDir(), '服务解析已选 B').toBe(dirB);
    expect(await home(), '偏好已指向 B，静态目录必须同步切到 B').toContain('CLIENT-B');

    // 清除偏好走同一条不变量：解析回落到 A，静态目录也必须同步回落，哪怕落盘仍然拒绝
    const del = await fetch(`${base}/api/services/webui-client/prefer`, { method: 'DELETE', headers });
    expect(del.ok, '清除偏好同样在落盘失败时以错误响应传出').toBe(false);
    expect(await home(), '偏好已清除，静态目录必须一起退回 A').toContain('CLIENT-A');
  });
});
