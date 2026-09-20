import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageGateway, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// delete 的删根守卫——字面空路径与「解析回根」两条路都必须拒。
//
// 审计发现的旁路：`root:/sub/..` 经 resolve 得到根本身，isInside 对 rel===''
// 判内、normalizeRelPath 只剥前导斜杠不中和 `..`——原先只有字面空路径的守卫，
// 该路径会把整个根 rm -rf。data 根默认可删后，这一守卫的量级不一样了。
// ════════════════════════════════════════════════════════════

describe('storage.delete 删根守卫 (真 fs)', () => {
  let base: string;
  let ws: string;
  let app: App;
  let gateway: StorageService;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-delroot-'));
    ws = join(base, 'ws');
    mkdirSync(join(ws, 'sub'), { recursive: true });
    writeFileSync(join(ws, 'keep.txt'), 'survivor');
    app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    await app.plugin(storageLocal, {
      roots: [
        {
          name: 'ws',
          path: ws,
          label: 'ws',
          kind: 'workspace',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugins.idle();
    // 插件没激活的话网关会一路 404 根，测出来的「拒绝」就与守卫无关了
    const state = app.plugins.getPlugin(storageLocal.name)?.state;
    if (state !== 'active') throw new Error(`storage-local 未激活（state=${state}）`);
    gateway = createStorageGateway(app.bind({ storage }).storage);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('字面根 URI → 拒绝', async () => {
    await expect(gateway.delete('ws:/')).rejects.toThrow(/不能删除根目录/);
    expect(existsSync(join(ws, 'keep.txt'))).toBe(true);
  });

  it('解析回根的路径（sub/..）→ 拒绝，根内容原样幸存', async () => {
    await expect(gateway.delete('ws:/sub/..')).rejects.toThrow(/不能删除根目录|路径不合法/);
    expect(existsSync(join(ws, 'keep.txt'))).toBe(true);
    expect(existsSync(join(ws, 'sub'))).toBe(true);
  });

  it('正常子路径删除不受影响', async () => {
    writeFileSync(join(ws, 'sub', 'x.txt'), 'x');
    await gateway.delete('ws:/sub/x.txt');
    expect(existsSync(join(ws, 'sub', 'x.txt'))).toBe(false);
    expect(existsSync(join(ws, 'keep.txt'))).toBe(true);
  });
});
