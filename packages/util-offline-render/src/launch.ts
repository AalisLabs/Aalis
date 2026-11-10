// ============================================================
// launch.ts — 起浏览器：启动参数、沙箱与信号处理
//
// 封网共三道，这里是后两道（第一道是 engine.ts 的逐请求拦截）：
//   - 解析规则把所有主机名映射到本机 1 号端口（那里没有服务）。不映射成 NOTFOUND：那样 Chrome 会发一次公网 DNS 探测。
//   - 代理指向同一个死端口，`<-loopback>` 取消回环地址默认直连：漏过拦截的连接（IP 字面量、预连接、DNS 预取、
//     浏览器自己的后台请求）都落到死端口上；同时压住 macOS 上 Chrome 默认走系统代理。
// 沙箱：sandbox 为真时不带 --no-sandbox 起，起不来就报不可用、不回落；为假时带 --no-sandbox --disable-setuid-sandbox 起。
// 信号：puppeteer 默认在 SIGINT 时先杀浏览器、再 process.exit(130)，会截断宿主的优雅停机；三种信号都不交给它，
// 浏览器由调用方的生命周期关。
// ============================================================

import type { Browser, LaunchOptions } from 'puppeteer';

/** 浏览器起不来：puppeteer 加载失败，或 Chromium 启动失败（含带沙箱时沙箱不可用）。 */
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
  sandbox: boolean;
  headless: boolean | 'shell';
  executablePath?: string;
  stepTimeoutMs: number;
  logger: { info(m: string): void };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Launcher {
  constructor(private readonly cfg: LaunchConfig) {}

  private options(): LaunchOptions {
    return {
      headless: this.cfg.headless,
      ...(this.cfg.executablePath ? { executablePath: this.cfg.executablePath } : {}),
      args: ['--disable-dev-shm-usage', ...NETWORK_ARGS, ...(this.cfg.sandbox ? [] : NO_SANDBOX_ARGS)],
      // 单条 CDP 命令的时限（puppeteer 默认 180 秒）。取步骤时限的两倍：套了步骤时限的调用总由步骤计时器先判超时；
      // 没套的调用（开上下文与页面、设视口、动画的时长探测与逐帧定格、关上下文、关浏览器）挂住时以它为上限
      protocolTimeout: this.cfg.stepTimeoutMs * 2,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      // 经管道连接：宿主不经停机退出（kill -9、内存耗尽、终端关闭）时 exit 钩子不跑，管道由系统关掉，浏览器随之退出；
      // 经 WebSocket 连接时浏览器自成进程组，整组留下
      pipe: true,
    };
  }

  async launch(): Promise<Browser> {
    let puppeteer: typeof import('puppeteer')['default'];
    try {
      ({ default: puppeteer } = await import('puppeteer'));
    } catch (err) {
      throw new RenderUnavailableError(`离线渲染不可用：加载 puppeteer 失败（${errorText(err)}）`, { cause: err });
    }
    try {
      const browser = await puppeteer.launch(this.options());
      this.cfg.logger.info(`离线渲染 Chromium 已启动（${this.cfg.sandbox ? '带沙箱' : '不带沙箱'}）`);
      return browser;
    } catch (err) {
      const failed = this.cfg.sandbox ? 'Chromium 带沙箱启动失败' : 'Chromium 启动失败';
      throw new RenderUnavailableError(`离线渲染不可用：${failed}（${errorText(err)}）`, { cause: err });
    }
  }
}
