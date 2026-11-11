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
// puppeteer 只在这个包里加载，且在真要启动浏览器时才加载：查 Chrome 装没装、下载它与启动用的是同一份 puppeteer。
// ============================================================

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Browser } from 'puppeteer';

export interface ChromiumLaunchOptions {
  headless: boolean | 'shell';
  /** 不给（或为空串）时用 puppeteer 自带的 Chrome */
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
 * Chromium 本身没起来（含带沙箱时沙箱不可用），消息即 puppeteer 的原话。puppeteer 加载失败不是它，原样抛出：
 * 调用方据此只在真是启动失败时提沙箱
 */
export class ChromiumLaunchError extends Error {
  override name = 'ChromiumLaunchError';
}

export async function launchChromium(opts: ChromiumLaunchOptions): Promise<Browser> {
  const { default: puppeteer } = await import('puppeteer');
  try {
    return await puppeteer.launch({
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
 * puppeteer 自带的 Chrome（不给 executablePath 时启动的就是它）装好后所在的路径，不论装没装。puppeteer 的配置
 * （PUPPETEER_EXECUTABLE_PATH、PUPPETEER_BROWSER、.puppeteerrc）指定了别的可执行文件或别的浏览器时不用自带的 Chrome，
 * 交回 undefined：启动只认配置里的那个，装了自带的也用不上
 */
export async function bundledChromePath(): Promise<string | undefined> {
  const { default: puppeteer } = await import('puppeteer');
  // executablePath() 在配置指定了可执行文件时交回它，默认浏览器不是 chrome 时交回那个浏览器的；configuration 不在
  // puppeteer 的公开类型里（同 install.ts）
  if (
    puppeteer.defaultBrowser !== 'chrome' ||
    (puppeteer as unknown as { configuration: { executablePath?: string } }).configuration.executablePath
  ) {
    return undefined;
  }
  return puppeteer.executablePath();
}

/** puppeteer 包里命令行脚本（package.json 的 bin）的路径：调用方用 node 跑它下载自带的 Chrome */
export function puppeteerCliPath(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('puppeteer/package.json');
  return join(dirname(manifest), (require(manifest) as { bin: string }).bin);
}
