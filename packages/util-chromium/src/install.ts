// ============================================================
// install.ts — 下载 puppeteer 自带的 Chrome，装完整才出现在缓存里
//
// puppeteer 的命令行把压缩包下到缓存，再直接解到最终目录（<缓存根>/<浏览器>/<平台>-<版本>），以「目录在、可执行文件也在」
// 判定已装；被中止（SIGTERM、SIGKILL）时不删半截的压缩包。下载或解压途中被打断（超时、停用、停机）后，下次安装先解那份
// 半截的压缩包，留下空的最终目录，此后每次都报「目录在而可执行文件不在」；解压到一半被打断的，可执行文件已解出、别的还缺，
// 判为已装却无法启动。所以命令行装进缓存根下本次新建的临时目录（经 PUPPETEER_CACHE_DIR：命令行不收 --path），装完整目录改名到
// 最终位置：同一文件系统里改名是原子的，最终目录只在完整解压后出现；打断时的半截东西都在临时目录里，随它删掉。
// 这里只碰 puppeteer 的缓存目录，它不在存储服务的根里，所以直接用 node:fs/promises。
// ============================================================

import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { puppeteerCliPath } from './launch.js';

/** 一次安装的时限：调用方须在到时停掉命令行，过期临时目录的判定以它为界 */
const INSTALL_TIMEOUT_MS = 300_000;
/** 临时目录名：前缀加创建时刻（毫秒）再加 mkdtemp 的随机后缀 */
const STAGING_PREFIX = '.aalis-chrome-install-';
const STAGING_NAME = /^\.aalis-chrome-install-(\d+)-/;
/** 命令行结束到改名或删掉临时目录之间的余量 */
const STALE_MARGIN_MS = 60_000;
/** Windows 上改名、删除遇占用时的尝试次数上限，间隔逐次加 100 毫秒、至多 1 秒（合计约 15 秒） */
const LOCKED_ATTEMPTS = 20;

/** 跑 puppeteer 命令行的一次请求：用 node 跑 args（第一个是命令行脚本），子进程的环境整份给 env */
export interface ChromeInstallRun {
  args: string[];
  env: Record<string, string | undefined>;
  /** 时限（毫秒）：调用方须在到时停掉子进程 */
  timeoutMs: number;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * 下载 puppeteer 自带的 Chrome 并装进它的缓存。run 由调用方经自己的进程服务执行，给时限与中止信号；退出码不为 0 时抛错，
 * 正常时交回 stdout
 */
export async function installBundledChrome(run: (request: ChromeInstallRun) => Promise<string>): Promise<void> {
  const { default: puppeteer } = await import('puppeteer');
  // configuration 不在 puppeteer 的公开类型里；命令行（cli.js）与启动时找自带的 Chrome 用的都是它的 cacheDirectory
  const cacheDir = (puppeteer as unknown as { configuration: { cacheDirectory: string } }).configuration.cacheDirectory;
  await mkdir(cacheDir, { recursive: true });
  await removeStaleStaging(cacheDir);
  const staging = await mkdtemp(join(cacheDir, `${STAGING_PREFIX}${Date.now()}-`));
  try {
    const out = (
      await run({
        args: [puppeteerCliPath(), 'browsers', 'install', 'chrome', '--format', '{{path}}'],
        env: { ...process.env, PUPPETEER_CACHE_DIR: staging },
        timeoutMs: INSTALL_TIMEOUT_MS,
      })
    ).trim();
    // 交回的是装好的可执行文件，缓存的布局是 <浏览器>/<平台>-<版本>/<可执行文件在安装目录里的相对路径>
    const rel = relative(staging, out);
    const [browser, version, ...exe] = rel.split(sep);
    if (isAbsolute(rel) || browser === '..' || exe.length === 0) {
      throw new Error(`下载 Chrome 的命令行交回的可执行文件不在临时目录里: ${out}`);
    }
    const target = join(cacheDir, browser, version);
    // 可执行文件已在：别的进程在这期间装好了，或版本是别名、别名先前没记进来，留着它，这次装的随临时目录删掉
    if (!(await exists(join(target, ...exe)))) {
      // 最终目录在而可执行文件不在：此前在原地被打断留下的，换成这次装好的
      await rm(target, { recursive: true, force: true });
      await mkdir(join(cacheDir, browser), { recursive: true });
      await whileLocked(() => rename(join(staging, browser, version), target));
    }
    await mergeAliases(join(staging, browser, '.metadata'), join(cacheDir, browser, '.metadata'));
  } catch (err) {
    // 没装成（命令行失败、被中止）：临时目录删一次，删不掉的留给之后安装前的过期清理。不重试，免得阻塞调用方的停用、拿删除的
    // 报错盖掉原来的错误
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await whileLocked(() => rm(staging, { recursive: true, force: true }));
}

/**
 * 删掉宿主中途崩溃留下的临时目录：只认本模块起的名字，且只删创建早于 时限 + 余量 的。临时目录建好才启动命令行；宿主活着时，
 * 它在时限到时停掉命令行，命令行结束后随即改名或删掉临时目录，所以过了这个时刻的不会再被哪次在装的安装用到。宿主已经崩溃的，
 * 它启动的命令行即使还在写，写出的东西也没人改名到位，删掉无害。删不掉的（那个命令行还占着文件，或边写边删）留到下次，不挡这次
 * 安装：这次装进自己新建的临时目录，与它无关
 */
async function removeStaleStaging(cacheDir: string): Promise<void> {
  const before = Date.now() - INSTALL_TIMEOUT_MS - STALE_MARGIN_MS;
  for (const name of await readdir(cacheDir)) {
    const created = STAGING_NAME.exec(name)?.[1];
    if (created && Number(created) < before) {
      await rm(join(cacheDir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * 改名到位、删临时目录。Windows 上杀毒软件会短暂占住刚解出的文件，这两步报 EPERM、EACCES 或 EBUSY：隔一会儿再试，有次数
 * 上限。别的平台上这几种错误不会自己消失，不重试
 */
async function whileLocked(op: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const locked = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!locked || attempt >= LOCKED_ATTEMPTS) throw err;
      await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 100, 1_000)));
    }
  }
}

/**
 * 版本配成别名（如 stable）时，命令行把别名指向的版本记在 <浏览器>/.metadata 的 aliases 里，puppeteer 按它找可执行文件：
 * 并进缓存里那份，原有的别名与别的字段保留
 */
async function mergeAliases(staged: string, kept: string): Promise<void> {
  if (!(await exists(staged))) return;
  const { aliases } = JSON.parse(await readFile(staged, 'utf8')) as { aliases?: Record<string, string> };
  const metadata = (await exists(kept)) ? JSON.parse(await readFile(kept, 'utf8')) : {};
  metadata.aliases = { ...metadata.aliases, ...aliases };
  await writeFile(kept, JSON.stringify(metadata, null, 2));
}
