import { describe, expect, it } from 'vitest';
import {
  collectLocalPackageDeps,
  type DiscoveryEnv,
  discoverClients,
  pickFreshClients,
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

describe('collectLocalPackageDeps（扫盘 → name→{version,deps}；keys 补已装判定）', () => {
  it('收集各 scanDir 下子目录 name + 自身版本 + 依赖名（dependencies/peer/optional 并集，剔版本）', () => {
    const env = makeEnv({
      dirs: {
        '/pkgs': ['plugin-foo', 'api-webui', 'no-pkgjson'],
        '/nm/@aalis': ['core'],
      },
      exists: [
        '/pkgs',
        '/pkgs/plugin-foo/package.json',
        '/pkgs/api-webui/package.json',
        '/nm/@aalis',
        '/nm/@aalis/core/package.json',
      ],
      pkgs: {
        // workspace:^ 与 ^1.0.0 都只取名；dependencies + peer + optional 并集去重
        '/pkgs/plugin-foo/package.json': {
          name: '@aalis/plugin-foo',
          version: '0.9.0',
          dependencies: { '@aalis/api-webui': 'workspace:^', express: '^4.0.0' },
          peerDependencies: { '@aalis/core': '>=0.2.0 <1.0.0' },
          optionalDependencies: { express: '^4.0.0' },
        },
        '/pkgs/api-webui/package.json': { name: '@aalis/api-webui', aalis: { types: true } },
        '/nm/@aalis/core/package.json': { name: '@aalis/core' },
      },
    });
    const map = collectLocalPackageDeps(['/pkgs', '/nm/@aalis'], env);
    // keys = 已装包名（含工作区 api，require.resolve 从根漏掉的）
    expect([...map.keys()].sort()).toEqual(['@aalis/api-webui', '@aalis/core', '@aalis/plugin-foo']);
    // deps = 依赖名并集去重，版本协议被忽略
    expect(map.get('@aalis/plugin-foo')?.deps.sort()).toEqual(['@aalis/api-webui', '@aalis/core', 'express']);
    expect(map.get('@aalis/api-webui')?.deps).toEqual([]); // 无依赖 → 空数组
    // version = 该包自身的版本。市场卡片靠它显示工作区包的**本地**版本：这条路径
    // require.resolve 走不通，不带上就只能退回显示 npm latest（把远端版本当成已装版本）。
    expect(map.get('@aalis/plugin-foo')?.version).toBe('0.9.0');
    expect(map.get('@aalis/api-webui')?.version, '无 version 字段则 undefined').toBeUndefined();
  });

  it('跳过无 package.json / 无 name 的子目录；不存在的 scanDir 安全略过', () => {
    const env = makeEnv({
      dirs: { '/p': ['a', 'broken'] },
      exists: ['/p', '/p/a/package.json'], // broken 无 package.json
      pkgs: { '/p/a/package.json': { name: '@x/a' } },
    });
    expect([...collectLocalPackageDeps(['/p', '/missing'], env).keys()]).toEqual(['@x/a']);
  });
});

describe('pickFreshClients（重复发现的幂等闸）', () => {
  const c = (id: string) => ({ id, label: id, dir: `/x/${id}` });

  it('只回未登记的候选——重复 provide 会在服务容器里堆同名重复项', () => {
    const discovered = [c('@aalis/plugin-webui-client'), c('@acme/my-ui')];
    expect(pickFreshClients(['@aalis/plugin-webui-client'], discovered).map(x => x.id)).toEqual(['@acme/my-ui']);
  });

  it('第二次跑同一份结果回空（幂等）', () => {
    const discovered = [c('a'), c('b')];
    const first = pickFreshClients([], discovered);
    expect(first).toHaveLength(2);
    expect(
      pickFreshClients(
        first.map(x => x.id),
        discovered,
      ),
    ).toEqual([]);
  });

  it('已登记集为空 → 全部是新的（首次启动）', () => {
    expect(pickFreshClients([], [c('a')])).toHaveLength(1);
  });
});
