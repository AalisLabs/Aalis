import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageManagerService } from '../../packages/api-package-manager/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { registerMarketplaceRoutes } from '../../packages/plugin-webui-server/src/routes/marketplace.js';
import { ref } from '../fixtures/service-ref.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// ════════════════════════════════════════════════════════════
// 市场的检索、查最新版与依赖图的 packument 是替前端的那次 HTTP 请求做的：客户端断开（换页、刷新）时这些到源的请求随之中止，
// 不再等各自的 8 秒时限。fetch 被截下：hang 匹配的地址一直不回，只在中止时拒绝；其余按 replies 回。客户端断开用路由夹具的
// 连接事件源 emit('close') 模拟。
// ════════════════════════════════════════════════════════════

const SEARCH = 'https://search.example.invalid';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 每次请求的地址与收到的信号 */
let sent: Array<{ url: string; signal: AbortSignal }>;
let hang: (url: string) => boolean;

beforeEach(() => {
  sent = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const signal = init?.signal as AbortSignal;
    sent.push({ url, signal });
    if (hang(url)) {
      return new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    }
    // 检索只在 aalis-plugin 一类里给一条结果
    const text = new URL(url).searchParams.get('text') ?? '';
    return json({
      objects: text.startsWith('keywords:aalis-plugin')
        ? [{ package: { name: 'zz-plugin-a', version: '1.0.0', description: '', keywords: ['aalis-plugin'] } }]
        : [],
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mount(appDir = '/zz-nonexistent-project') {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const { expressApp, invoke } = captureRoutes();
  registerMarketplaceRoutes(
    expressApp as never,
    {
      logger,
      plugins: ref(),
      services: { inspect: () => [] },
      // package-manager 不在：查版本也向检索源查
      packageManager: ref<PackageManagerService>(),
      appDir,
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    SEARCH,
    () => new Map(),
    () => {},
  );
  /** 发一次请求：connection 上 emit('close') 即客户端断开 */
  return (path: string, query: Record<string, string>) => {
    const connection = new EventEmitter();
    const reply = invoke(`GET ${path}`, { query }, connection);
    return { connection, reply };
  };
}

describe('市场替前端做的请求随客户端断开中止', () => {
  it('检索途中客户端断开：到检索源的请求随之中止', async () => {
    hang = () => true;
    const { connection, reply } = mount()('/api/marketplace', { q: '' });
    await expect.poll(() => sent.length).toBe(5);
    connection.emit('close');
    expect(sent.map(({ signal }) => signal.aborted)).toEqual([true, true, true, true, true]);
    await reply;
  });

  it('查最新版途中客户端断开：到源的请求随之中止', async () => {
    hang = url => url.endsWith('/latest');
    const { connection, reply } = mount()('/api/marketplace', { q: '' });
    await expect.poll(() => sent.map(({ url }) => url)).toContain(`${SEARCH}/zz-plugin-a/latest`);
    connection.emit('close');
    expect(sent.find(({ url }) => url.endsWith('/latest'))?.signal.aborted).toBe(true);
    await reply;
  });

  it('系统组件查 latest 途中客户端断开：到源的请求随之中止', async () => {
    // 项目根：根依赖声明一个契约包，node_modules 里是它本地已装的版本
    const project = mkdtempSync(join(tmpdir(), 'aalis-market-abort-'));
    try {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { '@zz/api-b': '^0.1.0' } }));
      mkdirSync(join(project, 'node_modules', '@zz', 'api-b'), { recursive: true });
      writeFileSync(
        join(project, 'node_modules', '@zz', 'api-b', 'package.json'),
        JSON.stringify({ name: '@zz/api-b', version: '0.1.0', keywords: ['aalis', 'aalis-api'] }),
      );
      hang = () => true;
      const { connection, reply } = mount(project)('/api/system-components', {});
      await expect.poll(() => sent.map(({ url }) => url)).toEqual([`${SEARCH}/@zz/api-b/latest`]);
      connection.emit('close');
      expect(sent[0].signal.aborted).toBe(true);
      await reply;
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('依赖图取 packument 途中客户端断开：到源的请求随之中止', async () => {
    hang = () => true;
    const { connection, reply } = mount()('/api/marketplace/depgraph', { name: 'zz-plugin-remote' });
    await expect.poll(() => sent.length).toBe(1);
    connection.emit('close');
    expect(sent[0].signal.aborted).toBe(true);
    await reply;
  });
});
