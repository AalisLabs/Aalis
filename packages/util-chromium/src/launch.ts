// ============================================================
// launch.ts — 启动 Chromium：浏览器工具与离线渲染共用的启动参数
//
// 两边相同的部分只写在这里，调用方只加自己的参数（浏览器工具的网络闸、离线渲染的封网）：
// - 沙箱：sandbox 为真时不带 --no-sandbox 启动，启动失败就直接报错、不回落；为假时带 --no-sandbox --disable-setuid-sandbox 启动。
// - --disable-dev-shm-usage：共享内存改用临时目录，容器里的 /dev/shm 常只有 64MB，渲染大页面时会让渲染进程崩溃。
// - 信号：puppeteer 默认在 SIGINT 时先杀浏览器、再 process.exit(130)，宿主的优雅停机无法执行完毕；SIGTERM、SIGHUP 时另行
//   关浏览器，挂着 SIGHUP 监听还让宿主在终端关闭后不退出。三种信号都不交给它，浏览器由调用方的生命周期关。
// - 经管道连接：宿主不经停机退出（崩溃、被 SIGKILL、未捕获异常）时管道由系统关掉，浏览器随之退出；崩溃与 SIGKILL 时
//   exit 钩子不跑，经 WebSocket 连接的浏览器自成进程组，整组留下。
// - 只启动 Chrome：不指定时 puppeteer 启动它配置里的默认浏览器（PUPPETEER_BROWSER、.puppeteerrc）。配成 Firefox 时 Chrome 的
//   命令行参数（沙箱、共享内存，以及浏览器工具网络闸的 --proxy-server、离线渲染封网的解析规则）它都不认，也不经管道连接，网络闸
//   与封网随之失效。puppeteer 配置里的可执行文件是它默认浏览器的：默认浏览器不是 Chrome 时那个文件也不是，当作 Chrome 启动会一直等
//   到协议超时，所以调用方没给路径时不启动它，抛 PuppeteerConfigError 写明原因与改法。
// puppeteer 只在这个包里加载，且在真要启动浏览器时才加载：查 Chrome 装没装、下载它与启动用的是同一份 puppeteer。
// ============================================================

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Browser } from 'puppeteer';

export interface ChromiumLaunchOptions {
  headless: boolean | 'shell';
  /**
   * 不给（或为空串）时用 puppeteer 配置里的可执行文件（PUPPETEER_EXECUTABLE_PATH、.puppeteerrc），没配时用自带的 Chrome；
   * 配置里的那个属于别的默认浏览器时不启动，见文件头
   */
  executablePath?: string;
  /** 共用参数之外，调用方自己的启动参数 */
  args: readonly string[];
  /** 新页面的缺省视口；不给时用 puppeteer 的缺省 */
  viewport?: { width: number; height: number };
  /** 单条 CDP 命令的时限（毫秒），0 为不设（puppeteer 缺省 180 秒） */
  protocolTimeout: number;
  /** 为真时带 Chromium 沙箱启动，无法启动就失败、不回落；为假时带 --no-sandbox --disable-setuid-sandbox 启动 */
  sandbox: boolean;
}

const NO_SANDBOX_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

/**
 * Chromium 本身启动失败（含带沙箱时沙箱不可用），消息即 puppeteer 的原话。puppeteer 加载失败、配置用不了（PuppeteerConfigError）
 * 不是它：调用方据此只在真是启动失败时提沙箱
 */
export class ChromiumLaunchError extends Error {
  override name = 'ChromiumLaunchError';
}

/** puppeteer 的配置这里用不了：配置里的可执行文件属于别的默认浏览器，不启动它。Chromium 未启动，与沙箱无关 */
export class PuppeteerConfigError extends Error {
  override name = 'PuppeteerConfigError';
}

export async function launchChromium(opts: ChromiumLaunchOptions): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer');
  const configured = configuredExecutablePath(puppeteer);
  if (!opts.executablePath && configured && puppeteer.defaultBrowser !== 'chrome') {
    throw new PuppeteerConfigError(
      `puppeteer 配置里的可执行文件（${configured}）是默认浏览器 ${puppeteer.defaultBrowser} 的，这里只启动 Chrome：在插件配置里给 ` +
        'Chrome 的 executablePath，或去掉 puppeteer 配置里的可执行文件（PUPPETEER_EXECUTABLE_PATH，或 .puppeteerrc 的 ' +
        'executablePath）后重新启动 Aalis（应用内的重启沿用原来的环境变量），改用自带的 Chrome',
    );
  }
  try {
    return await puppeteer.launch({
      browser: 'chrome',
      headless: opts.headless,
      ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
      ...(opts.viewport ? { defaultViewport: opts.viewport } : {}),
      args: ['--disable-dev-shm-usage', ...(opts.sandbox ? [] : NO_SANDBOX_ARGS), ...opts.args],
      protocolTimeout: opts.protocolTimeout,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      pipe: true,
    });
  } catch (err) {
    throw new ChromiumLaunchError(err instanceof Error ? err.message : String(err), { cause: err });
  }
}

/**
 * puppeteer 自带的 Chrome 装好后所在的路径，不论装没装。puppeteer 配置里指定了可执行文件（PUPPETEER_EXECUTABLE_PATH、
 * .puppeteerrc）时交回 undefined：自带的用不上。默认浏览器配成别的（PUPPETEER_BROWSER、.puppeteerrc）时也交回 undefined：
 * puppeteer 在启动之前按默认浏览器的版本算路径，算出的不是自带 Chrome 的，判断不了装没装。启动的是什么见文件头
 */
export async function bundledChromePath(): Promise<string | undefined> {
  const { default: puppeteer } = await import('puppeteer');
  // executablePath() 在配置指定了可执行文件时交回它，默认浏览器不是 chrome 时交回那个浏览器的
  if (puppeteer.defaultBrowser !== 'chrome' || configuredExecutablePath(puppeteer)) return undefined;
  return puppeteer.executablePath();
}

/** puppeteer 配置里的可执行文件（PUPPETEER_EXECUTABLE_PATH、.puppeteerrc）；configuration 不在它的公开类型里（同 install.ts） */
function configuredExecutablePath(puppeteer: object): string | undefined {
  return (puppeteer as { configuration: { executablePath?: string } }).configuration.executablePath;
}

/** puppeteer 包里命令行脚本（package.json 的 bin）的路径：调用方用 node 跑它下载自带的 Chrome */
export function puppeteerCliPath(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('puppeteer/package.json');
  return join(dirname(manifest), (require(manifest) as { bin: string }).bin);
}
