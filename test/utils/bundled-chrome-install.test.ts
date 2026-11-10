import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChromeInstallRun, installBundledChrome } from '../../packages/util-chromium/src/index.js';
import { fakeChromeCli } from '../fixtures/puppeteer-cli.js';

// ════════════════════════════════════════════════════════════
// 下载 puppeteer 自带的 Chrome：命令行装进缓存根下本次新建的临时目录（经 PUPPETEER_CACHE_DIR），装完整目录改名到
// <缓存根>/chrome/ 下的最终位置，临时目录随后删掉。
// - 下载或解压途中被打断：缓存里不留半截的压缩包与安装目录，再装一次照常装好。
// - 最终目录在而可执行文件不在（此前在原地被打断留下的）：换成这次装好的；可执行文件已在的（别的进程抢先装好）：留着它。
// - 版本配成别名：命令行记在临时目录 .metadata 里的别名并进缓存里那份，原有的保留。
// - 宿主中途崩溃留下的临时目录：只删本模块起名、创建早于安装时限加余量的；删不掉的留着，不挡这次安装。
// - 命令行交回的可执行文件不在临时目录里：报错，不动缓存。
// - Windows 上改名与装成之后删临时目录遇 EPERM、EACCES、EBUSY（杀毒软件短暂占住刚解出的文件）：有次数上限地重试；没装成的
//   只删一次；别的平台不重试。
// puppeteer 换成替身，缓存根是每条用例自己的临时目录；命令行是按 puppeteer 安装流程摆放文件的替身（fixtures/puppeteer-cli），
// 不联网、不下载。改名与删临时目录经 mock 的 node:fs/promises，可按次给出错误。
// ════════════════════════════════════════════════════════════

const state = vi.hoisted(() => ({
  cacheDir: '',
  /** 依次给改名的错误码，用完了照常改名 */
  renameErrors: [] as string[],
  renames: 0,
  /** 依次给删临时目录的错误码，用完了照常删 */
  rmErrors: [] as string[],
  rms: 0,
}));
vi.mock('../../packages/util-chromium/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js', () => ({
  default: {
    get configuration() {
      return { cacheDirectory: state.cacheDir };
    },
  },
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rename = async (from: string, to: string) => {
    state.renames++;
    const code = state.renameErrors.shift();
    if (code) throw Object.assign(new Error(`${code}: rename '${from}'`), { code });
    return actual.rename(from, to);
  };
  const rm: typeof actual.rm = async (path, options) => {
    if (String(path).includes('.aalis-chrome-install-')) {
      state.rms++;
      const code = state.rmErrors.shift();
      if (code) throw Object.assign(new Error(`${code}: rm '${path}'`), { code });
    }
    return actual.rm(path, options);
  };
  return { ...actual, rename, rm, default: { ...actual, rename, rm } };
});

const STAGING = '.aalis-chrome-install-';
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const restores: Array<() => void> = [];
beforeEach(async () => {
  state.cacheDir = await mkdtemp(join(tmpdir(), 'zz-chrome-cache-'));
  state.renameErrors.length = 0;
  state.renames = 0;
  state.rmErrors.length = 0;
  state.rms = 0;
});
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  vi.useRealTimers();
  await rm(state.cacheDir, { recursive: true, force: true });
});

function setup(alias?: string) {
  const cli = fakeChromeCli({
    cacheDir: state.cacheDir,
    platform: 'mac_arm',
    buildId: '1.2.3',
    exe: 'chrome-mac/zz-chrome',
    alias,
  });
  /** 与浏览器工具交的一样：执行完毕退出码不为 0 时抛错，交回 stdout */
  const run = async ({ args, env }: ChromeInstallRun) => {
    const result = await cli.run(args, env);
    if (result.code !== 0) throw new Error(result.stderr || `退出码 ${result.code}，信号 ${result.signal}`);
    return result.stdout;
  };
  return { cli, run, exe: join(cli.installDir, 'chrome-mac', 'zz-chrome') };
}

function onPlatform(platform: NodeJS.Platform): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  restores.push(() => Object.defineProperty(process, 'platform', original));
}

describe('下载自带的 Chrome', () => {
  it('装进缓存根下新建的临时目录，装完改名到最终位置，缓存根下只剩浏览器目录', async () => {
    const { cli, run, exe } = setup();
    await installBundledChrome(run);
    expect(await exists(exe)).toBe(true);
    expect(await exists(join(cli.installDir, 'zz-resources.pak'))).toBe(true);
    expect(await readdir(state.cacheDir)).toEqual(['chrome']);
    const { args, env } = cli.runs[0];
    expect(args.slice(1)).toEqual(['browsers', 'install', 'chrome', '--format', '{{path}}']);
    expect(env.PUPPETEER_CACHE_DIR?.startsWith(join(state.cacheDir, STAGING))).toBe(true);
    expect(env.PATH).toBe(process.env.PATH);
  });

  it.each([
    'interrupt-download',
    'interrupt-extract',
  ] as const)('%s：缓存里不留半截的压缩包与安装目录，再装一次照常装好', async outcome => {
    const { cli, run, exe } = setup();
    cli.outcomes.push(outcome);
    await expect(installBundledChrome(run)).rejects.toThrow();
    expect(await readdir(state.cacheDir)).toEqual([]);
    await installBundledChrome(run);
    expect(await exists(exe)).toBe(true);
    expect(await exists(join(cli.installDir, 'zz-resources.pak'))).toBe(true);
  });

  it('最终目录在而可执行文件不在（此前在原地被打断留下的）：换成这次装好的', async () => {
    const { cli, run, exe } = setup();
    await mkdir(cli.installDir, { recursive: true });
    await writeFile(join(cli.installDir, 'zz-stale'), '');
    await installBundledChrome(run);
    expect(await exists(exe)).toBe(true);
    expect(await exists(join(cli.installDir, 'zz-stale'))).toBe(false);
  });

  it('可执行文件已在（别的进程在这期间装好了）：留着它，这次装的随临时目录删掉', async () => {
    const { cli, run, exe } = setup();
    const raced = async (install: ChromeInstallRun) => {
      const out = await run(install);
      await mkdir(join(cli.installDir, 'chrome-mac'), { recursive: true });
      await writeFile(exe, 'zz-other');
      return out;
    };
    await installBundledChrome(raced);
    expect(await readFile(exe, 'utf8')).toBe('zz-other');
    expect(await readdir(state.cacheDir)).toEqual(['chrome']);
  });

  it('版本配成别名：别名并进缓存里的 .metadata，原有的别名与别的字段保留', async () => {
    const { run } = setup('stable');
    const metadata = join(state.cacheDir, 'chrome', '.metadata');
    await mkdir(join(state.cacheDir, 'chrome'), { recursive: true });
    await writeFile(metadata, JSON.stringify({ aliases: { beta: '0.9' }, executablePaths: { zz: 'zz' } }));
    await installBundledChrome(run);
    expect(JSON.parse(await readFile(metadata, 'utf8'))).toEqual({
      aliases: { beta: '0.9', stable: '1.2.3' },
      executablePaths: { zz: 'zz' },
    });
  });

  it('宿主中途崩溃留下的临时目录：只删本模块起名、创建早于时限加余量的，别的不动', async () => {
    const { run } = setup();
    const now = Date.now();
    const old = `${STAGING}${now - 400_000}-zzold`;
    const fresh = `${STAGING}${now - 1_000}-zzfresh`;
    const other = `.zz-other-${now - 400_000}-zz`;
    for (const name of [old, fresh, other]) await mkdir(join(state.cacheDir, name, 'chrome'), { recursive: true });
    await installBundledChrome(run);
    expect((await readdir(state.cacheDir)).sort()).toEqual([fresh, other, 'chrome'].sort());
  });

  it('过期的临时目录删不掉（崩溃宿主留下的命令行还占着）：留着它，照常装好', async () => {
    const { run, exe } = setup();
    const old = `${STAGING}${Date.now() - 400_000}-zzold`;
    await mkdir(join(state.cacheDir, old, 'chrome'), { recursive: true });
    state.rmErrors.push('EBUSY');
    await installBundledChrome(run);
    expect(await exists(exe)).toBe(true);
    expect((await readdir(state.cacheDir)).sort()).toEqual([old, 'chrome'].sort());
  });

  it('命令行交回的可执行文件不在临时目录里：报错，缓存不动', async () => {
    await expect(installBundledChrome(async () => '/zz-elsewhere/chrome-mac/zz-chrome\n')).rejects.toThrow(
      '/zz-elsewhere/chrome-mac/zz-chrome',
    );
    expect(await readdir(state.cacheDir)).toEqual([]);
  });

  it('Windows 上改名遇 EPERM、EBUSY：隔一会儿重试，改成了照常装好', async () => {
    onPlatform('win32');
    const { run, exe } = setup();
    state.renameErrors.push('EPERM', 'EBUSY');
    await installBundledChrome(run);
    expect(state.renames).toBe(3);
    expect(await exists(exe)).toBe(true);
  });

  it('Windows 上改名一直报 EPERM：重试有上限，到了就报错，临时目录删掉', async () => {
    onPlatform('win32');
    const { run } = setup();
    state.renameErrors.push(...Array(100).fill('EPERM'));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let settled = false;
    const pending = installBundledChrome(run).finally(() => {
      settled = true;
    });
    pending.catch(() => {});
    while (!settled) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise(resolve => setImmediate(resolve));
    }
    await expect(pending).rejects.toThrow('EPERM');
    expect(state.renames).toBe(20);
    expect(await readdir(state.cacheDir)).toEqual(['chrome']);
  });

  it('Windows 上删临时目录遇 EBUSY：隔一会儿重试，删掉了照常装好', async () => {
    onPlatform('win32');
    const { run, exe } = setup();
    state.rmErrors.push('EBUSY');
    await installBundledChrome(run);
    expect(state.rms).toBe(2);
    expect(await exists(exe)).toBe(true);
    expect(await readdir(state.cacheDir)).toEqual(['chrome']);
  });

  it('Windows 上没装成（命令行失败、被中止）时删临时目录遇 EBUSY：只删一次，报原来的错误，不拖着重试', async () => {
    onPlatform('win32');
    state.rmErrors.push(...Array(100).fill('EBUSY'));
    const failing = async () => {
      throw new Error('下载 Chrome 失败: zz');
    };
    await expect(installBundledChrome(failing)).rejects.toThrow('下载 Chrome 失败: zz');
    expect(state.rms).toBe(1);
  });

  it('别的平台上改名报 EPERM：不重试，直接报错', async () => {
    onPlatform('linux');
    const { run } = setup();
    state.renameErrors.push('EPERM');
    await expect(installBundledChrome(run)).rejects.toThrow('EPERM');
    expect(state.renames).toBe(1);
  });
});
