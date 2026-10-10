import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoundStorage, storage as storageService } from '../../packages/api-storage/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';

// ════════════════════════════════════════════════════════════
// storage-local 的白纸根 paper：插件内置、只映射 <家目录>/stage/paper，不受用户 roots 影响。
//   - 与生产同形的显式 roots 下有这个根（roots 为空的情形见 storage-internal-roots.test.ts）；
//   - `..` 逃逸被拒，写入的真实路径前缀是 stage/paper/，够不到 stage 下的兄弟文件；
//   - 用户 roots 里同名 paper 的项被跳过（不建它的目录）并告警，内置根生效。
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

  it('与生产同形的显式 roots：paper 根存在，paper:/x/y.txt 落在 <家目录>/stage/paper/x/y.txt', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);

    const paper = storage.listRoots().find(r => r.name === 'paper');
    expect(paper).toMatchObject({ kind: 'paper', browsable: false, readable: true, writable: true, deletable: true });

    await storage.writeFile('paper:/x/y.txt', 'hello');
    expect(readFileSync(join(base, 'stage', 'paper', 'x', 'y.txt'), 'utf-8')).toBe('hello');
    expect(String(await storage.readFile('paper:/x/y.txt', 'utf-8'))).toBe('hello');
  });

  it('安全：.. 逃逸读写都被拒，写入落在 stage/paper/ 下，够不到 stage 的兄弟文件', async () => {
    const storage = await activate(PRODUCTION_SHAPED_ROOTS);
    mkdirSync(join(base, 'stage'), { recursive: true });
    writeFileSync(join(base, 'stage', 'secret.txt'), 'sibling');

    await expect(storage.writeFile('paper:/../z', 'x')).rejects.toThrow();
    await expect(storage.writeFile('paper:/a/../../z', 'x')).rejects.toThrow();
    await expect(storage.readFile('paper:/../secret.txt')).rejects.toThrow();
    expect(existsSync(join(base, 'stage', 'z')), '逃逸写入不得落在 stage 下').toBe(false);
    expect(existsSync(join(base, 'z'))).toBe(false);

    // 根只映射 stage/paper：stage 下的兄弟文件按根内路径也读不到
    await expect(storage.readFile('paper:/secret.txt')).rejects.toThrow();

    await storage.writeFile('paper:/ok.txt', 'ok');
    const real = await storage.resolveLocalPath('paper:/ok.txt');
    expect(real.startsWith(`${join(realBase, 'stage', 'paper')}/`), `实际落点 ${real}`).toBe(true);
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
    expect(readFileSync(join(base, 'stage', 'paper', 'a.txt'), 'utf-8')).toBe('a');
    expect(existsSync(join(base, 'user-paper')), '被跳过的用户根不该建目录').toBe(false);
    expect(logs.some(l => l.level === 'warn' && l.message.includes('paper'))).toBe(true);
  });
});
