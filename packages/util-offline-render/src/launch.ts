// ============================================================
// launch.ts — 起浏览器：启动参数、沙箱策略与信号处理
//
// 封网共三道，这里是后两道（第一道是 engine.ts 的逐请求拦截）：
//   - 解析规则把所有主机名映射到本机 1 号端口（那里没有服务）。不映射成 NOTFOUND：那样 Chrome 会发一次公网 DNS 探测。
//   - 代理指向同一个死端口，`<-loopback>` 取消回环地址默认直连：漏过拦截的连接（IP 字面量、预连接、DNS 预取、
//     浏览器自己的后台请求）都落到死端口上；同时压住 macOS 上 Chrome 默认走系统代理。
// 沙箱：不带 --no-sandbox 起。`required` 起不来就报不可用、不回落；`preferred` 起不来加 --no-sandbox 再起一次，
// 本实例之后都不带沙箱起，告警只记一次。
// 信号：puppeteer 默认在 SIGINT 时先杀浏览器、再 process.exit(130)，会截断宿主的优雅停机；三种信号都不交给它，
// 浏览器由调用方的生命周期关。
// ============================================================

import type { Browser, LaunchOptions } from 'puppeteer';

export type SandboxPolicy = 'required' | 'preferred';

/** 浏览器起不来：puppeteer 加载失败、Chromium 启动失败，或 `required` 策略下沙箱不可用。 */
export class RenderUnavailableError extends Error {
  override name = 'RenderUnavailableError';
}

const NETWORK_ARGS = [
  '--host-resolver-rules=MAP * 127.0.0.1:1',
  '--proxy-server=http://127.0.0.1:1',
  '--proxy-bypass-list=<-loopback>',
];
const NO_SANDBOX_ARGS = ['--no-sandbox', '--disable-setuid-sandbox'];

interface LaunchConfig {
  sandbox: SandboxPolicy;
  headless: boolean | 'shell';
  executablePath?: string;
  stepTimeoutMs: number;
  logger: { info(m: string): void; warn(m: string): void };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Launcher {
  /** `preferred` 下带沙箱起过一次失败：本实例之后直接不带沙箱起 */
  private sandboxFailed = false;

  constructor(private readonly cfg: LaunchConfig) {}

  private options(noSandbox: boolean): LaunchOptions {
    return {
      headless: this.cfg.headless,
      ...(this.cfg.executablePath ? { executablePath: this.cfg.executablePath } : {}),
      args: ['--disable-dev-shm-usage', ...NETWORK_ARGS, ...(noSandbox ? NO_SANDBOX_ARGS : [])],
      // 单条 CDP 命令的时限（puppeteer 默认 180 秒）。取步骤时限的两倍：套了步骤时限的调用总由步骤计时器先判超时；
      // 没套的调用（开上下文与页面、设视口、动画的时长探测与逐帧定格、关上下文、关浏览器）挂住时以它为上限
      protocolTimeout: this.cfg.stepTimeoutMs * 2,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
  }

  async launch(): Promise<Browser> {
    let puppeteer: typeof import('puppeteer')['default'];
    try {
      ({ default: puppeteer } = await import('puppeteer'));
    } catch (err) {
      throw new RenderUnavailableError(`离线渲染不可用：加载 puppeteer 失败（${errorText(err)}）`, { cause: err });
    }
    if (!this.sandboxFailed) {
      try {
        const browser = await puppeteer.launch(this.options(false));
        this.cfg.logger.info('离线渲染 Chromium 已启动（带沙箱）');
        return browser;
      } catch (err) {
        if (this.cfg.sandbox === 'required') {
          throw new RenderUnavailableError(`离线渲染不可用：Chromium 带沙箱启动失败（${errorText(err)}）`, {
            cause: err,
          });
        }
        this.sandboxFailed = true;
        this.cfg.logger.warn(`Chromium 带沙箱启动失败（${errorText(err)}），本实例改为不带沙箱启动`);
      }
    }
    try {
      const browser = await puppeteer.launch(this.options(true));
      this.cfg.logger.info('离线渲染 Chromium 已启动（不带沙箱）');
      return browser;
    } catch (err) {
      throw new RenderUnavailableError(`离线渲染不可用：Chromium 启动失败（${errorText(err)}）`, { cause: err });
    }
  }
}
