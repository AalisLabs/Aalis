import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, type ToolExecutionResult, tools } from '../../packages/api-tools/src/index.js';
import { type WebuiActionHandler, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, type BoundOf, provide, services } from '../../packages/core/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import browserPlugin from '../../packages/plugin-tool-browser/src/index.js';

// ════════════════════════════════════════════════════════════
// 浏览器工具的两条实证缺陷（真 Chromium + 真本机 http 服务 + 真 fs）：
//
//   1) browser_screenshot 把整张 PNG 的 base64 塞进工具文本结果——模型看不到图，
//      几十万字符灌进上下文还落进历史。交付形态定死：一律先落盘 tmp 根拿 URI，
//      content 恒带 storage_uri（文件名取内容哈希，同图零增量），调用方接得住图
//      时再把图随结果附上；两种情况 content 都不含 base64，note 按有没有附图分写。
//   2) ensureBrowser 只判句柄非空，Chromium 崩溃/被杀后所有 browser_* 永久失效
//      到插件 bounce，pages 表还列着死页面。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;

const PAGE_HTML = '<html><title>截图页</title><body style="background:#3b82f6"><h1>hello</h1></body></html>';

/** 宿主侧要用的能力：发布桩服务 + 动态取 storage 实例挂 spy */
const hostUses = { provide, services };

let base: string;
let app: App;
let host: BoundOf<typeof hostUses>;
let server: Server;
let port: number;
let handlers: Record<string, Handler>;
let actions: Map<string, WebuiActionHandler>;

/** SIGKILL 掉本进程下的 Chromium 子进程——真崩溃，不是 browser.close() 的优雅退出 */
function killChromium(): number {
  const children = execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' })
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  let killed = 0;
  for (const pid of children) {
    const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8' });
    if (!/Chrom(e|ium)/i.test(cmd)) continue;
    process.kill(Number(pid), 'SIGKILL');
    killed++;
  }
  return killed;
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'aalis-browser-shot-'));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  await app.plugins.register(storageLocal, {
    roots: [
      {
        name: 'tmp',
        path: join(base, 'tmp'),
        label: 'tmp',
        kind: 'tmp',
        browsable: false,
        readable: true,
        writable: true,
        deletable: true,
      },
    ],
  });
  host = app.bind(hostUses);
  handlers = {};
  actions = new Map();
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  // blockPrivate:false 才连得上本机测试服务（同时省掉请求拦截）
  await app.plugins.register(browserPlugin, { headless: true, blockPrivate: false });
  await app.plugins.idle();
}, 60_000);

afterAll(async () => {
  await app.stop();
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(base, { recursive: true, force: true });
}, 30_000);

async function navigate(): Promise<string> {
  const out = JSON.parse(
    (await handlers.browser_navigate({ url: `http://127.0.0.1:${port}/` }, { sessionId: 's' })) as string,
  );
  if (out.error) throw new Error(`导航失败: ${out.error}`);
  return out.pageId as string;
}

describe('browser_screenshot 的交付形态', () => {
  it('调用方接得住图：PNG 随 images 交出，content 只有元信息 + storage_uri、不含 base64', async () => {
    const pageId = await navigate();
    const result = (await handlers.browser_screenshot(
      { pageId },
      { sessionId: 'onebot:t:group:1', acceptsImages: true },
    )) as ToolExecutionResult;
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0].startsWith('data:image/png;base64,')).toBe(true);
    expect(result.content).not.toContain('base64');
    const out = JSON.parse(result.content);
    expect(out).toMatchObject({ ok: true });
    // 接得住图也照样落盘给 URI：看不到图的下游（送去 analyze_image / 发出去）有路可走
    expect(out.storage_uri).toMatch(/^tmp:\/browser\/onebot_t_group_1\/shot-[0-9a-f]{16}\.png$/);
    expect(out.note).toBe('图已随结果附上；若你看不到图，用 storage_uri 走 analyze_image / send_attachment');
    expect(result.content.length).toBeLessThan(400);
  }, 60_000);

  it('调用方只读 content（mcp-server / workflow）：落盘 tmp 根返回 storage_uri，仍不含 base64', async () => {
    const pageId = await navigate();
    const raw = (await handlers.browser_screenshot({ pageId }, { sessionId: 's' })) as string;
    const out = JSON.parse(raw);
    expect(out.error).toBeUndefined();
    expect(raw).not.toContain('base64');
    expect(out.storage_uri).toMatch(/^tmp:\/browser\/s\/shot-[0-9a-f]{16}\.png$/);
    // 接不住图的这一路没有 images，note 不能写成「图已随结果附上」
    expect(out.note).not.toContain('已随结果附上');
    expect(out.note).toBe('图未随结果附上，用 storage_uri 走 analyze_image / send_attachment 查看');
    const png = await readFile(join(base, 'tmp', out.storage_uri.replace(/^tmp:\//, '')));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.byteLength).toBe(out.size);
  }, 60_000);

  it('同一张图重截落在同一个文件上（文件名取内容 sha256 前 16 位，零增量）', async () => {
    const pageId = await navigate();
    const dir = join(base, 'tmp', 'browser', 'zzz-dedup');
    const shoot = async (): Promise<string> =>
      JSON.parse((await handlers.browser_screenshot({ pageId }, { sessionId: 'zzz-dedup' })) as string).storage_uri;
    const first = await shoot();
    const second = await shoot();
    expect(second).toBe(first);
    expect(await readdir(dir)).toHaveLength(1);
  }, 60_000);

  it('落盘失败：接得住图的仍拿到图（只丢 storage_uri），只读 content 的拿到明确错误而非 base64', async () => {
    const pageId = await navigate();
    // 真 storage 的写口上挂失败：落盘那一步失败，其余全真
    const storageSvc = host.services.get(storage)!;
    const spy = vi.spyOn(storageSvc, 'writeFile').mockRejectedValue(new Error('zz-写盘失败'));
    try {
      const withImg = (await handlers.browser_screenshot(
        { pageId },
        { sessionId: 'zzz-fail', acceptsImages: true },
      )) as ToolExecutionResult;
      expect(withImg.images).toHaveLength(1);
      expect(JSON.parse(withImg.content).storage_uri).toBeUndefined();
      const textOnly = JSON.parse((await handlers.browser_screenshot({ pageId }, { sessionId: 'zzz-fail' })) as string);
      expect(textOnly.error).toContain('截图落盘失败');
      expect(JSON.stringify(textOnly)).not.toContain('base64');
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

describe('ensureBrowser 对断连的浏览器', () => {
  it('Chromium 被杀后自动重启并清空页面表，而不是把死句柄一直发下去', async () => {
    const deadPageId = await navigate();
    // 真崩溃：SIGKILL 掉 Chromium 子进程，句柄仍在但连接已断
    expect(killChromium(), '没找到 Chromium 子进程，用例前提不成立').toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 300));

    const freshPageId = await navigate(); // 修复前：拿死句柄 newPage() → 导航直接报错
    expect(freshPageId).not.toBe(deadPageId);

    // 死页面不留在表里（webui 的页面列表也不该列它）
    const listed = (await actions.get('listPages')!({})) as Array<{ id: string }>;
    expect(listed.map(p => p.id)).toEqual([freshPageId]);
    const stale = JSON.parse((await handlers.browser_get_text({ pageId: deadPageId }, { sessionId: 's' })) as string);
    expect(stale.error).toBe('页面不存在');
  }, 90_000);
});
