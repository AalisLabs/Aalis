import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoundStorage, storage as storageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// storage-local 的公开根 public：插件内置、只映射 <家目录>/stage/public，不受用户 roots 影响。
// 发布服务把审核通过的作品写在这里，作品站从这里读出来部署。
//   - 与生产同形的显式 roots 下有这个根（roots 为空的情形见 storage-internal-roots.test.ts）；
//   - `..` 逃逸被拒，写入的真实路径前缀是 stage/public/，够不到 stage 下的兄弟文件
//     （包括同在 stage 下的白纸根目录）；
//   - 用户 roots 里同名 public 的项被跳过（不建它的目录）并告警，内置根生效。
// 根路径按 host-paths 提供的家目录解析，这里把家目录指到临时目录，不在仓库里落目录。
// ════════════════════════════════════════════════════════════

/** 与生产配置同形：显式列出 workspace 外加一个自定义根，路径都相对家目录（插件自己的数据在内置根里，不写进 roots） */
const PRODUCTION_SHAPED_ROOTS = [
  {
    name: 'workspace',
    path: 'workspace',
    kind: 'workspace',
    browsable: true,
    readable: true,
    writable: true,
    deletable: true,
  },
  { name: 'project', path: '.', kind: 'custom', browsable: false, readable: true, writable: false, deletable: false },
];

/** 占位作品编号（10 位 [a-z2-7]） */
const WORK_ID = 'abcde23456';

function recordingLogger(sink: Array<{ level: string; message: string }>): Logger {
  const at = (level: string) => (message: string) => void sink.push({ level, message });
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

describe('storage-local 公开根 public', () => {
  let base: string;
  let realBase: string;
  let app: App;
  let logs: Array<{ level: string; message: string }>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'works-public-root-'));
    realBase = realpathSync(base);
    logs = [];
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
    provideHostPaths(app, base);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  async function activate(roots: unknown[]): Promise<BoundStorage> {
    await app.plugin(storageLocal, { roots });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    return app.bind({ storage: storageService }).storage.use;
  }

  it('与生产同形的显式 roots：public 根存在，public:/<编号>/files/index.html 落在 <家目录>/stage/public 下', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);

    const pub = storage.listRoots().find(r => r.name === 'public');
    expect(pub).toMatchObject({
      label: '公开作品',
      kind: 'public',
      browsable: false,
      readable: true,
      writable: true,
      deletable: true,
    });

    const uri = `public:/${WORK_ID}/files/index.html`;
    await storage.writeFile(uri, '<p>hi</p>');
    expect(readFileSync(join(base, 'stage', 'public', WORK_ID, 'files', 'index.html'), 'utf-8')).toBe('<p>hi</p>');
    expect(String(await storage.readFile(uri, 'utf-8'))).toBe('<p>hi</p>');

    await storage.delete(uri);
    expect(existsSync(join(base, 'stage', 'public', WORK_ID, 'files', 'index.html'))).toBe(false);
  });

  it('安全：.. 逃逸读写都被拒，写入落在 stage/public/ 下，够不到 stage 的兄弟文件与白纸根', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);
    mkdirSync(join(base, 'stage'), { recursive: true });
    writeFileSync(join(base, 'stage', 'secret.txt'), 'sibling');
    await storage.writeFile('paper:/t-1/out.png', 'artifact');

    await expect(storage.writeFile('public:/../x', 'x')).rejects.toThrow();
    await expect(storage.writeFile('public:/a/../../x', 'x')).rejects.toThrow();
    await expect(storage.readFile('public:/../secret.txt')).rejects.toThrow();
    await expect(storage.readFile('public:/../paper/t-1/out.png')).rejects.toThrow();
    expect(existsSync(join(base, 'stage', 'x')), '逃逸写入不得落在 stage 下').toBe(false);
    expect(existsSync(join(base, 'x'))).toBe(false);

    // 根只映射 stage/public：stage 下的兄弟文件与白纸根按根内路径也读不到
    await expect(storage.readFile('public:/secret.txt')).rejects.toThrow();
    await expect(storage.readFile('public:/paper/t-1/out.png')).rejects.toThrow();

    await storage.writeFile('public:/ok.txt', 'ok');
    const real = await storage.resolveLocalPath('public:/ok.txt');
    expect(real.startsWith(`${join(realBase, 'stage', 'public')}/`), `实际落点 ${real}`).toBe(true);
  });

  it('用户 roots 里有同名 public：跳过用户项（不建它的目录）并告警，内置根生效', async () => {
    const storage = await activate([
      ...PRODUCTION_SHAPED_ROOTS,
      { name: 'public', path: 'user-public', kind: 'custom', readable: true, writable: true, deletable: true },
    ]);

    const pubs = storage.listRoots().filter(r => r.name === 'public');
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.kind).toBe('public');

    await storage.writeFile('public:/a.txt', 'a');
    expect(readFileSync(join(base, 'stage', 'public', 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(base, 'user-public')), '被跳过的用户根不该建目录').toBe(false);
    expect(logs.some(l => l.level === 'warn' && l.message.includes('public'))).toBe(true);
  });
});
