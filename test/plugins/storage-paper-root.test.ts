import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageGateway, storage as storageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';

// ════════════════════════════════════════════════════════════
// storage-local 的白纸根 paper：插件内置、只映射 <cwd>/data/stage/paper，不受用户 roots 影响。
//   - 与生产同形的显式 roots、以及 roots 为空回落默认根，两种配置下都有这个根；
//   - `..` 逃逸被拒，写入的真实路径前缀是 data/stage/paper/，够不到 data/stage 下的兄弟文件；
//   - 用户 roots 里同名 paper 的项被跳过（不建它的目录）并告警，内置根生效。
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

describe('storage-local 白纸根 paper', () => {
  let base: string;
  let realBase: string;
  let app: App;
  let logs: Array<{ level: string; message: string }>;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-paper-root-'));
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

  it('与生产同形的显式 roots：paper 根存在，paper:/x/y.txt 落在 <cwd>/data/stage/paper/x/y.txt', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);

    const paper = storage.listRoots().find(r => r.name === 'paper');
    expect(paper).toMatchObject({ kind: 'paper', browsable: false, readable: true, writable: true, deletable: true });

    await storage.writeFile('paper:/x/y.txt', 'hello');
    expect(readFileSync(join(base, 'data', 'stage', 'paper', 'x', 'y.txt'), 'utf-8')).toBe('hello');
    expect(String(await storage.readFile('paper:/x/y.txt', 'utf-8'))).toBe('hello');
  });

  it('安全：.. 逃逸读写都被拒，写入落在 data/stage/paper/ 下，够不到 data/stage 的兄弟文件', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);
    mkdirSync(join(base, 'data', 'stage'), { recursive: true });
    writeFileSync(join(base, 'data', 'stage', 'secret.txt'), 'sibling');

    await expect(storage.writeFile('paper:/../z', 'x')).rejects.toThrow();
    await expect(storage.writeFile('paper:/a/../../z', 'x')).rejects.toThrow();
    await expect(storage.readFile('paper:/../secret.txt')).rejects.toThrow();
    expect(existsSync(join(base, 'data', 'stage', 'z')), '逃逸写入不得落在 data/stage 下').toBe(false);
    expect(existsSync(join(base, 'data', 'z'))).toBe(false);

    // 根只映射 data/stage/paper：data/stage 下的兄弟文件按根内路径也读不到
    await expect(storage.readFile('paper:/secret.txt')).rejects.toThrow();

    await storage.writeFile('paper:/ok.txt', 'ok');
    const real = await storage.resolveLocalPath('paper:/ok.txt');
    expect(real.startsWith(`${join(realBase, 'data', 'stage', 'paper')}/`), `实际落点 ${real}`).toBe(true);
  });

  it('用户 roots 里有同名 paper：跳过用户项（不建它的目录）并告警，内置根生效', async () => {
    const storage = await activate([
      ...PRODUCTION_SHAPED_ROOTS,
      { name: 'paper', path: 'user-paper', kind: 'custom', readable: true, writable: true, deletable: true },
    ]);

    const papers = storage.listRoots().filter(r => r.name === 'paper');
    expect(papers).toHaveLength(1);
    expect(papers[0]?.kind).toBe('paper');

    await storage.writeFile('paper:/a.txt', 'a');
    expect(readFileSync(join(base, 'data', 'stage', 'paper', 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(base, 'user-paper')), '被跳过的用户根不该建目录').toBe(false);
    expect(logs.some(l => l.level === 'warn' && l.message.includes('paper'))).toBe(true);
  });

  it('roots 为空回落默认根时 paper 根同样可用', async () => {
    const storage = await activate([]);

    expect(storage.listRoots().map(r => r.name)).toEqual(
      expect.arrayContaining(['workspace', 'data', 'tmp', 'pluginData', 'logs', 'paper']),
    );
    await storage.writeFile('paper:/d.txt', 'd');
    expect(readFileSync(join(base, 'data', 'stage', 'paper', 'd.txt'), 'utf-8')).toBe('d');
  });
});
