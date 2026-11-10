import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecResult } from '../../packages/api-process/src/index.js';

/** 一次运行的结局：装完，或在下载、解压途中被中止（SIGTERM） */
export type FakeCliOutcome = 'ok' | 'interrupt-download' | 'interrupt-extract';

export interface FakeChromeCliOptions {
  /** 没给 PUPPETEER_CACHE_DIR 时的缓存根（puppeteer 配置里的） */
  cacheDir: string;
  platform: string;
  buildId: string;
  /** 可执行文件在安装目录里的相对路径 */
  exe: string;
  /** 版本配成的别名：装完把它记进 <缓存根>/chrome/.metadata */
  alias?: string;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * puppeteer 命令行 `browsers install chrome` 的替身，按 @puppeteer/browsers 2.13.0 的安装流程在缓存根里摆放文件，不联网：
 * - 缓存根取子进程环境里的 PUPPETEER_CACHE_DIR，没有时取配置的；
 * - 安装目录 <缓存根>/chrome/<平台>-<版本> 已在时，可执行文件在就算装好，不在就报「目录在而可执行文件不在」；
 * - 压缩包下到 <缓存根>/chrome/<版本>-chrome.zip，已有就直接解它；解压先建安装目录，压缩包不完整时解压失败并删掉压缩包；
 * - 装完删掉压缩包，按 --format（只认 {{path}}）交回可执行文件的路径；配了别名时把别名记进 .metadata；
 * - 被中止时（SIGTERM 不跑 finally）不删压缩包，停在那一步：下载途中留下半截的压缩包，解压途中留下已解出可执行文件、
 *   别的还缺的安装目录。
 * outcomes 依次给出各次运行的结局，用完了都按装完；runs 记下每次运行的参数与环境
 */
export function fakeChromeCli(opts: FakeChromeCliOptions) {
  const outcomes: FakeCliOutcome[] = [];
  const runs: Array<{ args: readonly string[]; env: Record<string, string | undefined> }> = [];
  const killed: ExecResult = { code: null, signal: 'SIGTERM', stdout: '', stderr: '' };
  const fail = (stderr: string): ExecResult => ({ code: 1, signal: null, stdout: '', stderr });

  async function run(args: readonly string[], env: Record<string, string | undefined> = {}): Promise<ExecResult> {
    runs.push({ args, env });
    const outcome = outcomes.shift() ?? 'ok';
    const root = join(env.PUPPETEER_CACHE_DIR ?? opts.cacheDir, 'chrome');
    const archive = join(root, `${opts.buildId}-chrome.zip`);
    const installDir = join(root, `${opts.platform}-${opts.buildId}`);
    const exe = join(installDir, opts.exe);
    const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : `chrome@${opts.buildId} {{path}}`;
    const done = (): ExecResult => ({
      code: 0,
      signal: null,
      stdout: `${format.replace('{{path}}', exe)}\n`,
      stderr: '',
    });

    if (await exists(installDir)) {
      if (await exists(exe)) return done();
      return fail(`Error: The browser folder (${installDir}) exists but the executable (${exe}) is missing`);
    }
    await mkdir(root, { recursive: true });
    if (!(await exists(archive))) {
      if (outcome === 'interrupt-download') {
        await writeFile(archive, 'zz-half');
        return killed;
      }
      await writeFile(archive, 'zz-whole');
    }
    await mkdir(installDir, { recursive: true });
    if ((await readFile(archive, 'utf8')) !== 'zz-whole') {
      await unlink(archive);
      return fail('Error: end of central directory record signature not found');
    }
    await mkdir(dirname(exe), { recursive: true });
    await writeFile(exe, 'zz-chrome');
    if (outcome === 'interrupt-extract') return killed;
    await writeFile(join(installDir, 'zz-resources.pak'), 'zz');
    await unlink(archive);
    if (opts.alias) {
      await writeFile(join(root, '.metadata'), JSON.stringify({ aliases: { [opts.alias]: opts.buildId } }, null, 2));
    }
    return done();
  }

  return { outcomes, runs, run, installDir: join(opts.cacheDir, 'chrome', `${opts.platform}-${opts.buildId}`) };
}
