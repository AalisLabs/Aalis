import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, type Logger, services } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// storage-local 只登记一个 storage 提供者，根在它内部路由，全部根就绪之后才登记：依赖方一激活就看得到每一个根，
// 服务偏好里只有这一家。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const INTERNAL = ['data', 'pluginData', 'tmp', 'cache', 'logs', 'personas', 'skills', 'workflows', 'paper', 'public'];

describe('storage-local 整体登记一个提供者', () => {
  let home: string;
  let app: App;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-single-storage-')));
    app = new App({ name: 'T', logLevel: 'error', logger: silent });
    provideHostPaths(app, home);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('依赖方激活时就看得到每一个根；服务里只有这一家', async () => {
    let seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'zz-storage-dependant',
        uses: { storage },
        apply(caps) {
          seen = caps.storage.use.listRoots().map(root => root.name);
        },
      }),
    );
    await app.plugin(storageLocal, { roots: [] });
    await app.plugins.idle();
    expect(app.plugins.getPlugin('zz-storage-dependant')?.state).toBe('active');
    expect(seen.sort()).toEqual([...INTERNAL, 'workspace'].sort());
    expect(app.bind({ services }).services.use.inspect(storage)).toHaveLength(1);
  });

  it('根名不认识：报「未知存储根」并列出已有的根', async () => {
    await app.plugin(storageLocal, { roots: [] });
    await app.plugins.idle();
    const local = app.bind({ storage }).storage.use;
    expect(() => local.stat('nope:/a')).toThrow(/^未知存储根: nope（已注册根: .*workspace.*）$/);
  });
});
