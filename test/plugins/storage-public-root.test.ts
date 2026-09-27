import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageGateway, storage as storageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// storage-local 的公开根 public：插件内置、只映射 <cwd>/data/stage/public，不受用户 roots 影响。
// 发布服务把审核通过的作品写在这里，作品站从这里读出来部署。
//   - 与生产同形的显式 roots、以及 roots 为空回落默认根，两种配置下都有这个根；
//   - `..` 逃逸被拒，写入的真实路径前缀是 data/stage/public/，够不到 data/stage 下的兄弟文件
//     （包括同在 data/stage 下的白纸根目录）；
//   - 用户 roots 里同名 public 的项被跳过（不建它的目录）并告警，内置根生效。
// 根路径按 process.cwd() 解析，这里把 cwd 指到临时目录，不在仓库里落目录。
// ════════════════════════════════════════════════════════════

/** 与生产配置同形：显式列出五个默认根外加一个自定义根，路径都相对 cwd */
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
  { name: 'data', path: 'data', kind: 'data', browsable: false, readable: true, writable: true, deletable: true },
  {
    name: 'tmp',
    path: 'workspace/.tmp',
    kind: 'tmp',
    browsable: false,
    readable: true,
    writable: true,
    deletable: true,
  },
  {
    name: 'pluginData',
    path: 'data/plugins',
    kind: 'pluginData',
    browsable: false,
    readable: true,
    writable: true,
    deletable: true,
  },
  { name: 'logs', path: 'data', kind: 'logs', browsable: false, readable: true, writable: false, deletable: false },
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
    vi.spyOn(process, 'cwd').mockReturnValue(base);
    logs = [];
    app = new App({ name: 'T', logLevel: 'debug', logger: recordingLogger(logs) });
  });

  afterEach(async () => {
    await app.stop();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  async function activate(roots: unknown[]): Promise<ReturnType<typeof createStorageGateway>> {
    await app.plugin(storageLocal, { roots });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(storageLocal.name)?.state, 'storage-local 未激活').toBe('active');
    return createStorageGateway(app.bind({ storage: storageService }).storage);
  }

  it('与生产同形的显式 roots：public 根存在，public:/<编号>/files/index.html 落在 <cwd>/data/stage/public 下', async () => {
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
    expect(readFileSync(join(base, 'data', 'stage', 'public', WORK_ID, 'files', 'index.html'), 'utf-8')).toBe(
      '<p>hi</p>',
    );
    expect(String(await storage.readFile(uri, 'utf-8'))).toBe('<p>hi</p>');

    await storage.delete(uri);
    expect(existsSync(join(base, 'data', 'stage', 'public', WORK_ID, 'files', 'index.html'))).toBe(false);
  });

  it('安全：.. 逃逸读写都被拒，写入落在 data/stage/public/ 下，够不到 data/stage 的兄弟文件与白纸根', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);
    mkdirSync(join(base, 'data', 'stage'), { recursive: true });
    writeFileSync(join(base, 'data', 'stage', 'secret.txt'), 'sibling');
    await storage.writeFile('paper:/t-1/out.png', 'artifact');

    await expect(storage.writeFile('public:/../x', 'x')).rejects.toThrow();
    await expect(storage.writeFile('public:/a/../../x', 'x')).rejects.toThrow();
    await expect(storage.readFile('public:/../secret.txt')).rejects.toThrow();
    await expect(storage.readFile('public:/../paper/t-1/out.png')).rejects.toThrow();
    expect(existsSync(join(base, 'data', 'stage', 'x')), '逃逸写入不得落在 data/stage 下').toBe(false);
    expect(existsSync(join(base, 'data', 'x'))).toBe(false);

    // 根只映射 data/stage/public：data/stage 下的兄弟文件与白纸根按根内路径也读不到
    await expect(storage.readFile('public:/secret.txt')).rejects.toThrow();
    await expect(storage.readFile('public:/paper/t-1/out.png')).rejects.toThrow();

    await storage.writeFile('public:/ok.txt', 'ok');
    const real = await storage.resolveLocalPath('public:/ok.txt');
    expect(real.startsWith(`${join(realBase, 'data', 'stage', 'public')}/`), `实际落点 ${real}`).toBe(true);
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
    expect(readFileSync(join(base, 'data', 'stage', 'public', 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(base, 'user-public')), '被跳过的用户根不该建目录').toBe(false);
    expect(logs.some(l => l.level === 'warn' && l.message.includes('public'))).toBe(true);
  });

  it('roots 为空回落默认根时 public 根同样可用，与白纸根并存', async () => {
    const storage = await activate([]);

    expect(storage.listRoots().map(r => r.name)).toEqual(
      expect.arrayContaining(['workspace', 'data', 'tmp', 'pluginData', 'logs', 'paper', 'public']),
    );
    await storage.writeFile('public:/d.txt', 'd');
    expect(readFileSync(join(base, 'data', 'stage', 'public', 'd.txt'), 'utf-8')).toBe('d');
  });
});
