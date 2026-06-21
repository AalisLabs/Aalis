import { describe, expect, it } from 'vitest';
import {
  collectLocalPackageNames,
  type DiscoveryEnv,
  discoverClients,
} from '../../packages/plugin-webui-server/src/client-discovery.js';

// ════════════════════════════════════════════════════════════
// webui-server 全动态前端发现：按 aalis.client 标记扫描，不硬编码任何前端名。
// 用内存 fs 驱动纯逻辑（无需真实文件系统/启动服务）。
// ════════════════════════════════════════════════════════════

function makeEnv(spec: {
  exists: string[];
  dirs?: Record<string, string[]>;
  pkgs?: Record<string, unknown>;
  resolve?: Record<string, string>;
}): DiscoveryEnv {
  const existsSet = new Set(spec.exists);
  return {
    existsSync: p => existsSet.has(p),
    readdirSync: p => spec.dirs?.[p] ?? [],
    readJson: p => spec.pkgs?.[p],
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    dirname: p => p.slice(0, p.lastIndexOf('/')) || '/',
    resolvePkgJson: id => spec.resolve?.[id],
  };
}

describe('discoverClients（全动态前端发现）', () => {
  it('扫目录：收录带 aalis.client 标记 + 有 dist/index.html 的包；排除无标记 / 缺 index.html', () => {
    const env = makeEnv({
      dirs: { '/pkgs': ['plugin-webui-client', 'plugin-webui-client-example', 'plugin-foo', 'plugin-no-dist'] },
      exists: [
        '/pkgs',
        '/pkgs/plugin-webui-client/package.json',
        '/pkgs/plugin-webui-client/dist/index.html',
        '/pkgs/plugin-webui-client-example/package.json',
        '/pkgs/plugin-webui-client-example/dist/index.html',
        '/pkgs/plugin-foo/package.json', // 非前端
        '/pkgs/plugin-no-dist/package.json', // 标了 client 但没构建出 dist/index.html
      ],
      pkgs: {
        '/pkgs/plugin-webui-client/package.json': {
          name: '@aalis/plugin-webui-client',
          displayName: 'Aalis 默认前端',
          aalis: { client: true },
        },
        '/pkgs/plugin-webui-client-example/package.json': {
          name: '@aalis/plugin-webui-client-example',
          description: '示例前端',
          aalis: { client: true },
        },
        '/pkgs/plugin-foo/package.json': { name: '@aalis/plugin-foo', aalis: { service: {} } },
        '/pkgs/plugin-no-dist/package.json': { name: '@aalis/plugin-no-dist', aalis: { client: true } },
      },
    });
    const r = discoverClients(['/pkgs'], [], env);
    expect(r.map(c => c.id)).toEqual(['@aalis/plugin-webui-client', '@aalis/plugin-webui-client-example']); // 排序、剔除 foo/no-dist
    expect(r[0].label).toBe('Aalis 默认前端'); // displayName 优先
    expect(r[1].label).toBe('示例前端'); // 回退 description
    expect(r[0].dir).toBe('/pkgs/plugin-webui-client/dist');
  });

  it('第三方前端经 deps 解析发现；与目录扫描结果按包名去重', () => {
    const env = makeEnv({
      dirs: { '/pkgs': ['plugin-webui-client'] },
      exists: [
        '/pkgs',
        '/pkgs/plugin-webui-client/package.json',
        '/pkgs/plugin-webui-client/dist/index.html',
        '/nm/their-client/package.json',
        '/nm/their-client/dist/index.html',
      ],
      pkgs: {
        '/pkgs/plugin-webui-client/package.json': { name: '@aalis/plugin-webui-client', aalis: { client: true } },
        '/nm/their-client/package.json': { name: '@scope/their-client', aalis: { client: true } },
      },
      resolve: {
        '@aalis/plugin-webui-client': '/pkgs/plugin-webui-client/package.json', // 同时也在 deps 里
        '@scope/their-client': '/nm/their-client/package.json',
      },
    });
    const r = discoverClients(['/pkgs'], ['@aalis/plugin-webui-client', '@scope/their-client'], env);
    // webui-client 虽既在目录又在 deps，只出现一次；@aalis 排在 @scope 前
    expect(r.map(c => c.id)).toEqual(['@aalis/plugin-webui-client', '@scope/their-client']);
    expect(r.filter(c => c.id === '@aalis/plugin-webui-client')).toHaveLength(1);
  });

  it('不存在的扫描目录、空输入 → 安全返回 []（无前端时调用方回退 404）', () => {
    expect(discoverClients(['/missing'], [], makeEnv({ exists: [] }))).toEqual([]);
    expect(discoverClients([], [], makeEnv({ exists: [] }))).toEqual([]);
  });

  it('label 回退链：displayName → description → name', () => {
    const env = makeEnv({
      dirs: { '/p': ['a'] },
      exists: ['/p', '/p/a/package.json', '/p/a/dist/index.html'],
      pkgs: { '/p/a/package.json': { name: '@x/only-name', aalis: { client: true } } },
    });
    expect(discoverClients(['/p'], [], env)[0].label).toBe('@x/only-name');
  });
});

describe('collectLocalPackageNames（市场「已装」兜底：扫盘列本地包名，scope 无关）', () => {
  it('收集各 scanDir 下子目录 package.json.name；含工作区 api/前端（require.resolve 漏掉的）', () => {
    const env = makeEnv({
      dirs: {
        '/pkgs': ['plugin-foo', 'plugin-webui-api', 'plugin-webui-client', 'no-pkgjson'],
        '/nm/@aalis': ['core'],
      },
      exists: [
        '/pkgs',
        '/pkgs/plugin-foo/package.json',
        '/pkgs/plugin-webui-api/package.json',
        '/pkgs/plugin-webui-client/package.json',
        '/nm/@aalis',
        '/nm/@aalis/core/package.json',
      ],
      pkgs: {
        '/pkgs/plugin-foo/package.json': { name: '@aalis/plugin-foo' },
        '/pkgs/plugin-webui-api/package.json': { name: '@aalis/plugin-webui-api', aalis: { types: true } },
        '/pkgs/plugin-webui-client/package.json': { name: '@aalis/plugin-webui-client', aalis: { client: true } },
        '/nm/@aalis/core/package.json': { name: '@aalis/core' },
      },
    });
    const names = collectLocalPackageNames(['/pkgs', '/nm/@aalis'], env);
    expect([...names].sort()).toEqual([
      '@aalis/core',
      '@aalis/plugin-foo',
      '@aalis/plugin-webui-api',
      '@aalis/plugin-webui-client',
    ]);
  });

  it('跳过无 package.json / 无 name 的子目录；不存在的 scanDir 安全略过', () => {
    const env = makeEnv({
      dirs: { '/p': ['a', 'broken'] },
      exists: ['/p', '/p/a/package.json'], // broken 无 package.json
      pkgs: { '/p/a/package.json': { name: '@x/a' } },
    });
    expect([...collectLocalPackageNames(['/p', '/missing'], env)]).toEqual(['@x/a']);
  });
});
