import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type StorageService, storage as storageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// storage-local 的内部路由根按家目录布局派生（host-paths），不受用户 roots 影响：
// 附件句柄里的 data 根映射到 state/，self 下人设卡、技能、编排定义各一个根，白纸与公开作品在 stage/ 下。
// 用户 roots 里同名的旧条目（升级前持久化的 data、tmp、pluginData、logs）被跳过并告警。
// ════════════════════════════════════════════════════════════

describe('storage-local 内部路由根', () => {
  let home: string;
  let app: App;
  let storage: StorageService;
  let warns: string[];

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-internal-roots-')));
    warns = [];
    const logger = {
      debug() {},
      info() {},
      warn: (m: string) => void warns.push(m),
      error() {},
      child: () => logger,
    } as unknown as Logger;
    app = new App({ name: 'T', logLevel: 'debug', logger });
    provideHostPaths(app, home);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });

  async function start(roots: unknown[]) {
    await app.plugin(storageLocal, { roots });
    await app.plugins.idle();
    storage = app.bind({ storage: storageService }).storage.use;
  }

  it('各内部根映射到家目录布局里的对应目录', async () => {
    await start([]);
    const expected: Record<string, string> = {
      data: 'state',
      pluginData: 'state/plugins',
      tmp: 'tmp',
      cache: 'cache',
      logs: 'logs',
      personas: 'self/personas',
      skills: 'self/skills',
      workflows: 'self/workflows',
      paper: 'stage/paper',
      public: 'stage/public',
      workspace: 'workspace',
    };
    for (const [name, rel] of Object.entries(expected)) {
      expect(await storage.resolveLocalPath?.(`${name}:/`), name).toBe(join(home, rel));
    }
    expect(
      storage
        .listRoots()
        .map(r => r.name)
        .sort(),
    ).toEqual(Object.keys(expected).sort());
  });

  it('内部根的 kind：self 下三个根为 self，其余各自的 kind', async () => {
    await start([]);
    const kinds = Object.fromEntries(storage.listRoots().map(r => [r.name, r.kind]));
    expect(kinds).toMatchObject({
      data: 'data',
      pluginData: 'pluginData',
      tmp: 'tmp',
      cache: 'cache',
      logs: 'logs',
      personas: 'self',
      skills: 'self',
      workflows: 'self',
      paper: 'paper',
      public: 'public',
    });
  });

  it('用户 roots 里与内部根同名的旧条目被跳过并告警，内部根照常指向家目录布局', async () => {
    await start([
      { name: 'workspace', path: 'workspace', readable: true, writable: true },
      { name: 'data', path: 'data', readable: true, writable: true },
      { name: 'tmp', path: 'workspace/.tmp', readable: true, writable: true },
    ]);
    expect(await storage.resolveLocalPath?.('data:/')).toBe(join(home, 'state'));
    expect(await storage.resolveLocalPath?.('tmp:/')).toBe(join(home, 'tmp'));
    expect(warns.filter(w => w.includes('与插件内部根同名')).length).toBe(2);
    // 告警写明配置的路径与内部根实际指向的位置：以前把 data 指到别处的，知道数据该搬到哪
    expect(warns.find(w => w.startsWith('roots 跳过 data'))).toContain(`配置的 path：data`);
    expect(warns.find(w => w.startsWith('roots 跳过 data'))).toContain(`data:/ 指向 ${join(home, 'state')}`);
  });
});
