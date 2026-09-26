import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageManagerService } from '../../packages/api-package-manager/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { registerMarketplaceRoutes } from '../../packages/plugin-webui-server/src/routes/marketplace.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// ════════════════════════════════════════════════════════════
// 市场的检索源（marketplaceRegistry）只管「有哪些包」：多数镜像不支持 search，检索源常与安装源不同。
// 卡片的最新版与可更新、系统组件的 latest、依赖图里未安装包的 packument，都要向安装实际使用的源
// （package-manager 报告的 npm registry）查——否则检索源比安装源新时，卡片给出的「可更新 v9.9.9」
// 装不到，update 还会拿这个版本号去预检。检索结果另按搜索词在包名、描述、关键词上本地过滤。
// 全程替身：fetch 被截下，项目根是临时目录，不发真实请求。
// ════════════════════════════════════════════════════════════

const SEARCH = 'https://search.example.invalid';
const INSTALL = 'https://install.example.invalid';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** 检索源只给 aalis-plugin 一类结果；版本号一律 9.9.9，卡片若用了它测试就会红 */
const SEARCH_HITS = [
  { package: { name: 'zz-plugin-a', version: '9.9.9', description: 'Vector memory', keywords: ['aalis-plugin'] } },
  { package: { name: 'zz-plugin-c', version: '9.9.9', description: 'Browser tools', keywords: ['aalis-plugin'] } },
];

const PACKUMENTS: Record<string, unknown> = {
  [`${INSTALL}/zz-plugin-a`]: { 'dist-tags': { latest: '1.1.0' } },
  [`${INSTALL}/zz-plugin-c`]: { 'dist-tags': { latest: '2.0.0' } },
  [`${INSTALL}/@zz%2Fapi-b`]: { 'dist-tags': { latest: '0.2.0' } },
  [`${INSTALL}/zz-plugin-remote`]: {
    'dist-tags': { latest: '3.0.0' },
    versions: {
      '3.0.0': { dependencies: { '@aalis/zz-dep': '^1.0.0' }, aalis: { service: { provides: ['zz-svc'] } } },
    },
  },
  [`${SEARCH}/zz-plugin-a`]: { 'dist-tags': { latest: '9.9.9' } },
};

let project: string;
let requested: string[];

beforeEach(() => {
  // 项目根：根依赖声明两个 registry 来源的包，node_modules 里是本地已装版本
  project = mkdtempSync(join(tmpdir(), 'aalis-market-src-'));
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ dependencies: { 'zz-plugin-a': '^1.0.0', '@zz/api-b': '^0.1.0' } }),
  );
  for (const [name, version, keyword] of [
    ['zz-plugin-a', '1.0.0', 'aalis-plugin'],
    ['@zz/api-b', '0.1.0', 'aalis-api'],
  ]) {
    mkdirSync(join(project, 'node_modules', name), { recursive: true });
    writeFileSync(
      join(project, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version, keywords: ['aalis', keyword] }),
    );
  }
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  requested = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith(`${SEARCH}/-/v1/search`)) {
      const text = new URL(url).searchParams.get('text') ?? '';
      return json({ objects: text.startsWith('keywords:aalis-plugin') ? SEARCH_HITS : [] });
    }
    return url in PACKUMENTS ? json(PACKUMENTS[url]) : new Response('not found', { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

function mount(packageManager: Pick<PackageManagerService, 'registry' | 'serviceDependents'> | undefined) {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (msg: string) => void warns.push(msg),
    error() {},
    child: () => logger,
  };
  const { expressApp, invoke } = captureRoutes();
  registerMarketplaceRoutes(
    expressApp as never,
    {
      logger,
      plugins: { current: undefined },
      services: { inspect: () => [] },
      packageManager: { current: packageManager as PackageManagerService | undefined },
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    SEARCH,
    () => new Map(),
    () => {},
  );
  const get = (path: string, query: Record<string, string> = {}) => invoke(`GET ${path}`, { query });
  return { get, warns };
}

type Card = { name: string; version: string; updatable: boolean };
type Component = { name: string; latest?: string; updatable: boolean };

const installSource = { registry: async () => INSTALL, serviceDependents: () => [] };

describe('市场的版本来源与安装源一致', () => {
  it('卡片的最新版与可更新按安装源查，不用检索结果自带的版本号', async () => {
    const { get } = mount(installSource);
    const reply = await get('/api/marketplace', { q: '' });
    const { packages, warning } = reply.body as { packages: Card[]; warning?: string };
    expect(warning).toBeUndefined();
    expect(packages.find(p => p.name === 'zz-plugin-a')).toMatchObject({ version: '1.1.0', updatable: true });
    expect(packages.find(p => p.name === 'zz-plugin-c')).toMatchObject({ version: '2.0.0', updatable: false });
    expect(requested, '版本不该向检索源查').not.toContain(`${SEARCH}/zz-plugin-a`);
  });

  it('系统组件的 latest 与依赖图里未安装包的 packument 同样向安装源查', async () => {
    const { get } = mount(installSource);
    const system = (await get('/api/system-components')).body as { components: Component[]; warning?: string };
    expect(system.warning).toBeUndefined();
    expect(system.components.find(c => c.name === '@zz/api-b')).toMatchObject({ latest: '0.2.0', updatable: true });

    const graph = (await get('/api/marketplace/depgraph', { name: 'zz-plugin-remote' })).body as {
      upstream: { children: Array<{ name: string }> };
      services: { provides: string[] };
    };
    expect(graph.upstream.children.map(c => c.name)).toEqual(['@aalis/zz-dep']);
    expect(graph.services.provides).toEqual(['zz-svc']);
    expect(requested).toContain(`${INSTALL}/zz-plugin-remote`);
  });

  it('检索结果按搜索词在包名、描述、关键词上本地过滤，被滤掉的包不查版本', async () => {
    const { get } = mount(installSource);
    const { packages } = (await get('/api/marketplace', { q: 'vector' })).body as { packages: Card[] };
    expect(packages.map(p => p.name)).toEqual(['zz-plugin-a']);
    expect(requested).not.toContain(`${INSTALL}/zz-plugin-c`);
  });

  it('安装源查不到：不给最新版与可更新，响应带 warning 说明，并记一条告警', async () => {
    const { get, warns } = mount({
      registry: async () => {
        throw new Error('npm: command not found');
      },
      serviceDependents: () => [],
    });
    const market = (await get('/api/marketplace', { q: '' })).body as { packages: Card[]; warning?: string };
    expect(market.warning).toBe('无法确定安装源（npm: command not found），暂不显示最新版本与可更新');
    expect(market.packages.find(p => p.name === 'zz-plugin-a')).toMatchObject({ version: '', updatable: false });
    const system = (await get('/api/system-components')).body as { components: Component[]; warning?: string };
    expect(system.warning).toBe(market.warning);
    expect(system.components.find(c => c.name === '@zz/api-b')).toMatchObject({ updatable: false });
    expect(system.components.find(c => c.name === '@zz/api-b')?.latest).toBeUndefined();
    expect(
      requested.filter(u => !u.includes('/-/v1/search')),
      '查不到安装源就不查版本',
    ).toEqual([]);
    expect(warns.some(w => w.includes('npm: command not found'))).toBe(true);
  });

  it('package-manager 缺席（装卸更新都不可用）：最新版退回检索源查，只作展示', async () => {
    const { get } = mount(undefined);
    const { packages, warning } = (await get('/api/marketplace', { q: '' })).body as {
      packages: Card[];
      warning?: string;
    };
    expect(warning).toBeUndefined();
    expect(packages.find(p => p.name === 'zz-plugin-a')?.version).toBe('9.9.9');
    expect(requested).toContain(`${SEARCH}/zz-plugin-a`);
  });
});
