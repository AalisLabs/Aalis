import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SmokeResult } from './core-scenario.js';

// ════════════════════════════════════════════════════════════
// core 多运行时冒烟：编译期守卫（test/core/architecture.test.ts 的宿主全局白名单）只说明源码只用登记过的
// 宿主全局，这里把同一场景（core-scenario.ts）拿到不同运行时里实跑，结果逐项对照 EXPECTED。
//   - Node：子进程按包名 `@aalis/core` 解析到 packages/core/dist（子进程避开 vitest 的源码别名）；
//   - 无头 Chromium：请求拦截把虚拟源的 /core/* 映射到 packages/core/dist，其余请求一律拒绝；
//     主线程与 module Worker 各跑一遍，并确认两处都没有 process。
// 跑的是构建产物：preflight 与 CI 都先 build 再 test；dist 缺失时直接报错，不跳过。
// 浏览器取法同 test/plugins/draw-render.test.ts：用仓库已装的 puppeteer 与它缓存的 Chrome，取不到即失败。
// ════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CORE_DIST = join(ROOT, 'packages/core/dist');
const ORIGIN = 'https://core-smoke.invalid';

const HANG_GIVEN_UP = 'warn aalis:provider DisposableChain: 异步清理 [hang] 超过 30ms，放弃等待，继续后续清理';
const EXPECTED: SmokeResult = {
  cascade: {
    consumerAlone: 'pending',
    loaded: ['provider', 'consumer'],
    states: { consumer: 'active', provider: 'active' },
  },
  bounce: { loaded: ['provider', 'consumer'], consumerSaw: [1, 2], consumerDisposed: [1] },
  ready: ['consumer#1', 'late', 'consumer#2'],
  flushed: ['provider#1', 'provider#2'],
  slow: { during: { state: 'activating', slow: true }, after: { state: 'active', slow: false } },
  signal: { beforeStop: [true, false], afterStop: [true, true], reasons: ['AbortError', 'AbortError'] },
  stopped: { consumer: 'disposed', provider: 'disposed', late: 'disposed', slow: 'disposed' },
  warnings: [
    HANG_GIVEN_UP,
    'warn aalis:plugins 插件 "slow" 激活超过 30ms 仍未完成，转入后台继续；它提供的服务在激活完成前不对依赖方开放',
    HANG_GIVEN_UP,
  ],
};

/** 场景转译成的 ES 模块源码（没有 import，Node 以 data: URL、浏览器以虚拟源加载） */
let scenario = '';
beforeAll(() => {
  if (!existsSync(join(CORE_DIST, 'index.js'))) {
    throw new Error(
      `缺少 ${relative(ROOT, CORE_DIST)}/index.js：本测试跑 core 的构建产物，先执行 pnpm --filter @aalis/core build`,
    );
  }
  const source = readFileSync(join(HERE, 'core-scenario.ts'), 'utf-8');
  scenario = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
});

/** Node 子进程：场景源码从 stdin 读入 */
const NODE_RUNNER = `
import { readFileSync } from 'node:fs';
const core = await import('@aalis/core');
const { smoke } = await import('data:text/javascript,' + encodeURIComponent(readFileSync(0, 'utf-8')));
process.stdout.write(JSON.stringify({ resolved: import.meta.resolve('@aalis/core'), result: await smoke(core) }));
`;

describe('core 多运行时冒烟', () => {
  it('Node：@aalis/core 按包名解析到 dist，场景结果符合预期', () => {
    const run = spawnSync(process.execPath, ['--input-type=module', '--eval', NODE_RUNNER], {
      cwd: ROOT,
      input: scenario,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as { resolved: string; result: SmokeResult };
    expect(out.resolved).toBe(pathToFileURL(join(CORE_DIST, 'index.js')).href);
    expect(out.result).toEqual(EXPECTED);
  }, 40_000);

  describe('无头 Chromium', () => {
    let browser: Browser | undefined;
    let cdp: CdpSession | undefined;
    let page: Page;

    beforeAll(async () => {
      // 根目录不直接依赖 puppeteer，从 plugin-draw 的依赖里取
      const puppeteer = createRequire(join(ROOT, 'packages/plugin-draw/package.json'))('puppeteer') as Puppeteer;
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      // 拦截开在浏览器级：页面级拦截（page.setRequestInterception）接不全 Worker 里的模块请求，Worker 会卡在加载
      const session = await browser.target().createCDPSession();
      cdp = session;
      session.on('Fetch.requestPaused', ({ requestId, request }) => void serve(session, requestId, request.url));
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      page = await browser.newPage();
      await page.goto(`${ORIGIN}/`);
    }, 60_000);

    // 全量测试的负载下 browser.close() 曾 30 秒不返回（单跑与同批浏览器测试并跑都复现不了，原因未查明）：
    // 先停掉浏览器级拦截再关，10 秒仍未关掉就直接杀进程，不留残余 Chrome
    afterAll(async () => {
      await cdp?.send('Fetch.disable', {}).catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        browser?.close().catch(() => {}),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 10_000);
        }),
      ]);
      clearTimeout(timer);
      browser?.process()?.kill('SIGKILL');
    }, 30_000);

    it('主线程：没有 process，场景结果符合预期', async () => {
      const out = await page.evaluate<Run>(`(async () => {
        const core = await import('/core/index.js');
        const { smoke } = await import('/scenario.js');
        return { process: typeof process, result: await smoke(core) };
      })()`);
      expect(out.process).toBe('undefined');
      expect(out.result).toEqual(EXPECTED);
    }, 30_000);

    it('module Worker：没有 process，场景结果符合预期', async () => {
      const out = await page.evaluate<Run>(`new Promise((resolve, reject) => {
        const worker = new Worker('/worker.js', { type: 'module' });
        worker.onmessage = event => {
          worker.terminate();
          event.data.error ? reject(new Error(event.data.error)) : resolve(event.data);
        };
        worker.onerror = event => reject(new Error('Worker 加载失败: ' + event.message));
      })`);
      expect(out.process).toBe('undefined');
      expect(out.result).toEqual(EXPECTED);
    }, 30_000);
  });
});

/** Worker 入口：与主线程同一段场景，结果或错误经 postMessage 交回页面 */
const WORKER = `
import * as core from '/core/index.js';
import { smoke } from '/scenario.js';
try {
  postMessage({ process: typeof process, result: await smoke(core) });
} catch (error) {
  postMessage({ error: String(error && error.stack || error) });
}
`;

/** 虚拟源只答这几类路径，其余请求（含任何外网）一律拒绝 */
function serve(cdp: CdpSession, requestId: string, href: string): Promise<unknown> {
  const url = new URL(href);
  if (url.origin !== ORIGIN) return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  const body = route(url.pathname);
  if (body === undefined) return cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 404 });
  return cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: 200,
    responseHeaders: [{ name: 'Content-Type', value: url.pathname === '/' ? 'text/html' : 'text/javascript' }],
    body: Buffer.from(body).toString('base64'),
  });
}

/** 页面、场景、Worker 入口，与 /core/* → dist */
function route(pathname: string): string | Buffer | undefined {
  if (pathname === '/') return '<!doctype html><link rel="icon" href="data:,"><title>core smoke</title>';
  if (pathname === '/scenario.js') return scenario;
  if (pathname === '/worker.js') return WORKER;
  // URL 解析已消去 `..` 段，拼出的路径不会越出 dist
  const file = join(CORE_DIST, pathname.slice('/core/'.length));
  return pathname.startsWith('/core/') && file.endsWith('.js') && existsSync(file) ? readFileSync(file) : undefined;
}

interface Run {
  process: string;
  result: SmokeResult;
}

// puppeteer 不在根目录的依赖里，只声明用到的部分（与 plugin-draw 的做法相同）
interface Puppeteer {
  launch(options: Record<string, unknown>): Promise<Browser>;
}
interface Browser {
  target(): { createCDPSession(): Promise<CdpSession> };
  newPage(): Promise<Page>;
  close(): Promise<void>;
  process(): { kill(signal: string): boolean } | null;
}
interface CdpSession {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  on(event: 'Fetch.requestPaused', handler: (event: { requestId: string; request: { url: string } }) => void): void;
}
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
}
