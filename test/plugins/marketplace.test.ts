import { describe, expect, it } from 'vitest';
import {
  augmentInstalled,
  buildDependencyChain,
  buildSearchUrl,
  classifyPackage,
  findPackageDependents,
  findServiceDependents,
  toManifest,
  toMarketplacePackages,
} from '../../packages/plugin-webui-server/src/routes/marketplace.js';

// ════════════════════════════════════════════════════════════
// 插件市场 — npm registry 检索映射（纯 npm 路线，keyword 发现）
// ════════════════════════════════════════════════════════════

describe('buildSearchUrl（单类型关键词；调用方对四类各发一条再合并 = OR）', () => {
  it('无搜索词只按该 keyword（npm 的 keywords 逗号是 AND，故不合并成一条）', () => {
    expect(buildSearchUrl('', 'aalis-util')).toBe(
      'https://registry.npmjs.org/-/v1/search?text=keywords%3Aaalis-util&size=100',
    );
  });
  it('带搜索词时 keyword + 词同时约束', () => {
    expect(decodeURIComponent(buildSearchUrl('memory', 'aalis-plugin'))).toContain('keywords:aalis-plugin memory');
  });
  it('可配 registry 基址（去尾斜杠；空值回退官方源）', () => {
    expect(buildSearchUrl('', 'aalis-api', 'https://npm.example.com/')).toBe(
      'https://npm.example.com/-/v1/search?text=keywords%3Aaalis-api&size=100',
    );
    expect(buildSearchUrl('', 'aalis-plugin', '')).toContain('registry.npmjs.org');
  });
});

describe('toMarketplacePackages（响应映射 + 已装 + 官方标注 + 富信息）', () => {
  const resp = {
    objects: [
      {
        package: { name: '@aalis/plugin-foo', version: '1.2.0', description: 'Foo', publisher: { username: 'alice' } },
      },
      { package: { name: 'someone-aalis-plugin-bar', version: '0.1.0' } }, // 社区包（非 @aalis scope）
    ],
  };

  it('映射字段 + 已装标注 + @aalis scope 判官方（无 keyword 时为空数组）', () => {
    const pkgs = toMarketplacePackages(resp, new Set(['@aalis/plugin-foo']));
    expect(pkgs[0]).toMatchObject({
      name: '@aalis/plugin-foo',
      version: '1.2.0',
      description: 'Foo',
      author: 'alice',
      installed: true,
      official: true,
      keywords: [],
    });
    expect(pkgs[1]).toMatchObject({
      name: 'someone-aalis-plugin-bar',
      version: '0.1.0',
      description: '',
      installed: false,
      official: false, // 非 @aalis scope = 社区
    });
  });

  it('提取富信息字段（下载量/评分/更新/不安全/许可/链接）并剔除 aalis-plugin 关键词', () => {
    const rich = {
      objects: [
        {
          package: {
            name: '@aalis/plugin-rich',
            version: '2.0.0',
            description: 'rich',
            keywords: ['aalis-plugin', 'memory', 'vector'],
            date: '2026-01-01T00:00:00.000Z',
            license: 'MIT',
            links: { npm: 'https://npm/x', homepage: 'https://home' },
          },
          score: { final: 0.8, detail: { quality: 0.9, popularity: 0.5, maintenance: 0.7 } },
          downloads: { monthly: 12345, weekly: 3000 },
          flags: { insecure: 1 },
          updated: '2026-06-01T00:00:00.000Z',
        },
      ],
    };
    const [p] = toMarketplacePackages(rich, new Set());
    expect(p.keywords).toEqual(['memory', 'vector']); // aalis-plugin 被剔除
    expect(p.downloads).toBe(12345);
    expect(p.updated).toBe('2026-06-01T00:00:00.000Z'); // updated 优先于 package.date
    expect(p.score).toBe(0.8);
    expect(p.insecure).toBe(true);
    expect(p.license).toBe('MIT');
    expect(p.links).toEqual({ npm: 'https://npm/x', homepage: 'https://home' });
  });

  it('空响应返回空数组（降级安全）', () => {
    expect(toMarketplacePackages({}, new Set())).toEqual([]);
    expect(toMarketplacePackages({ objects: [] }, new Set())).toEqual([]);
  });
});

describe('findServiceDependents（卸载护栏：断服务依赖检测）', () => {
  const status = [
    { name: '@aalis/plugin-openai', provides: ['llm'], requiredServices: [] },
    { name: '@aalis/plugin-agent', provides: ['agent'], requiredServices: ['llm'] },
    { name: '@aalis/plugin-deepseek', provides: ['llm'], requiredServices: [] },
  ];

  it('删了某服务的唯一提供者 → 列出受影响的依赖方', () => {
    const onlyProvider = [status[0], status[1]]; // 仅 openai 提供 llm，agent 需要 llm
    expect(findServiceDependents('@aalis/plugin-openai', onlyProvider)).toEqual(['@aalis/plugin-agent']);
  });

  it('还有别的提供者 → 删了不致命，无依赖方阻断', () => {
    // openai 与 deepseek 都提供 llm；删 openai，deepseek 仍在
    expect(findServiceDependents('@aalis/plugin-openai', status)).toEqual([]);
  });

  it('目标不提供任何服务 → 空', () => {
    expect(findServiceDependents('@aalis/plugin-agent', status)).toEqual([]);
  });
});

describe('findPackageDependents（import 依赖：谁的 deps 含 target）', () => {
  const depMap = new Map<string, string[]>([
    ['@aalis/plugin-a', ['@aalis/plugin-b', 'express']],
    ['@aalis/plugin-b', ['@aalis/util-c']],
    ['@aalis/util-c', []],
    ['@aalis/plugin-d', ['@aalis/util-c']],
  ]);
  it('列出直接 import 该包的所有包（排序、排除自身）', () => {
    expect(findPackageDependents('@aalis/util-c', depMap)).toEqual(['@aalis/plugin-b', '@aalis/plugin-d']);
    expect(findPackageDependents('@aalis/plugin-b', depMap)).toEqual(['@aalis/plugin-a']);
  });
  it('无人依赖 → 空', () => {
    expect(findPackageDependents('@aalis/plugin-a', depMap)).toEqual([]);
  });
});

describe('buildDependencyChain（import 链路树：传递、环/深度守卫、缺失中断）', () => {
  // a → b → c(util) ；d → c ；e → f(缺失，本地无)
  const depMap = new Map<string, string[]>([
    ['@aalis/plugin-a', ['@aalis/plugin-b', 'express']],
    ['@aalis/plugin-b', ['@aalis/util-c']],
    ['@aalis/util-c', []],
    ['@aalis/plugin-d', ['@aalis/util-c']],
    ['@aalis/plugin-e', ['@aalis/plugin-f']], // f 不在图中（缺失）
  ]);
  const names = (n: { children: { name: string }[] }) => n.children.map(c => c.name);

  it('upstream：传递展开依赖；第三方库（express）被 isRelevant 默认滤掉', () => {
    const t = buildDependencyChain('@aalis/plugin-a', depMap, 'upstream');
    expect(names(t)).toEqual(['@aalis/plugin-b']); // express 被滤
    expect(t.children[0].children.map(c => c.name)).toEqual(['@aalis/util-c']); // 传递到 c
  });
  it('upstream：依赖缺失 → present=false 且不再下钻（中断）', () => {
    const t = buildDependencyChain('@aalis/plugin-e', depMap, 'upstream', { isRelevant: () => true });
    expect(t.children[0]).toMatchObject({ name: '@aalis/plugin-f', present: false, children: [] });
  });
  it('downstream：谁依赖它，传递；不因 target 未装而中断', () => {
    const t = buildDependencyChain('@aalis/util-c', depMap, 'downstream');
    expect(names(t).sort()).toEqual(['@aalis/plugin-b', '@aalis/plugin-d']);
    // b 的上游依赖者是 a → 传递展开
    expect(t.children.find(c => c.name === '@aalis/plugin-b')?.children.map(c => c.name)).toEqual(['@aalis/plugin-a']);
  });
  it('downstream：target 本地未装也能查依赖者（装前场景）', () => {
    const t = buildDependencyChain('@aalis/plugin-f', depMap, 'downstream');
    expect(t.present).toBe(false);
    expect(names(t)).toEqual(['@aalis/plugin-e']); // e 依赖 f
  });
  it('环检测：a↔b 互依不死循环', () => {
    const cyclic = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const t = buildDependencyChain('a', cyclic, 'upstream', { isRelevant: () => true });
    expect(t.children[0].name).toBe('b');
    expect(t.children[0].children[0]).toMatchObject({ name: 'a', children: [] }); // 回到 a 即停
  });
  it('深度上限：maxDepth 截断', () => {
    const chain = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['d']],
    ]);
    const t = buildDependencyChain('a', chain, 'upstream', { isRelevant: () => true, maxDepth: 1 });
    expect(t.children[0]).toMatchObject({ name: 'b', children: [] }); // depth 1 即停，不展开 c
  });
});

describe('toManifest（packument → 装前能力清单）', () => {
  it('读 dist-tags.latest 版本的 aalis.service', () => {
    const packument = {
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.0.0': { description: '旧' },
        '1.2.0': {
          description: '新',
          aalis: { service: { required: ['llm'], optional: ['memory'], provides: ['x'] } },
          dependencies: { '@aalis/plugin-llm-api': 'workspace:^', zod: '^3.0.0' },
          peerDependencies: { '@aalis/core': '>=0.2.0 <1.0.0' },
        },
      },
    };
    expect(toManifest(packument)).toEqual({
      name: '',
      version: '1.2.0',
      description: '新',
      service: { required: ['llm'], optional: ['memory'], provides: ['x'] },
      dependencies: ['@aalis/plugin-llm-api', 'zod', '@aalis/core'], // deps+peer 并集去重、剔版本
    });
  });

  it('无 aalis.service / 无依赖时 service=undefined、dependencies=[]（仍返回版本/描述）', () => {
    const m = toManifest({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { description: 'd' } } });
    expect(m).toEqual({ name: '', version: '1.0.0', description: 'd', service: undefined, dependencies: [] });
  });

  it('无 latest tag 返回 null（降级安全）', () => {
    expect(toManifest({})).toBeNull();
    expect(toManifest({ versions: {} })).toBeNull();
  });
});

describe('classifyPackage（按类型关键词分类）', () => {
  it('aalis-interface → 前端界面', () => {
    expect(classifyPackage(['aalis', 'aalis-interface'])).toBe('interface');
  });
  it('aalis-api → 契约', () => {
    expect(classifyPackage(['aalis', 'aalis-api'])).toBe('api');
  });
  it('aalis-util → 工具库', () => {
    expect(classifyPackage(['aalis', 'aalis-util'])).toBe('util');
  });
  it('aalis-plugin / 无类型词 → 功能插件（关键词优先，mcp-client 这类靠 aalis-plugin 判定而非名字）', () => {
    expect(classifyPackage(['aalis', 'aalis-plugin'])).toBe('plugin');
    expect(classifyPackage([])).toBe('plugin');
  });
  it('augmentInstalled：已装的 api/前端经 resolve 补判为已安装（getStatus 漏掉它们）', () => {
    // base = getStatus 仅含已加载运行时插件；api/client 带 marker 不在其中
    const base = new Set(['@aalis/plugin-openai']);
    const names = ['@aalis/plugin-openai', '@aalis/plugin-llm-api', '@aalis/plugin-webui-client', '@aalis/plugin-x'];
    // 模拟 node_modules：llm-api 与 webui-client 已装（可 resolve），plugin-x 未装
    const canResolve = (n: string) => n === '@aalis/plugin-llm-api' || n === '@aalis/plugin-webui-client';
    const out = augmentInstalled(names, base, canResolve);
    expect(out.has('@aalis/plugin-openai')).toBe(true); // base 保留
    expect(out.has('@aalis/plugin-llm-api')).toBe(true); // 补判已装（修复"永远未安装"bug）
    expect(out.has('@aalis/plugin-webui-client')).toBe(true);
    expect(out.has('@aalis/plugin-x')).toBe(false); // 未装
    // 用于 toMarketplacePackages 时，api/client installed=true
    const pkgs = toMarketplacePackages({ objects: names.map(n => ({ package: { name: n, version: '1.0.0' } })) }, out);
    expect(pkgs.find(p => p.name === '@aalis/plugin-llm-api')?.installed).toBe(true);
    expect(pkgs.find(p => p.name === '@aalis/plugin-x')?.installed).toBe(false);
  });

  it('toMarketplacePackages 按关键词注入 category', () => {
    const pkgs = toMarketplacePackages(
      {
        objects: [
          { package: { name: '@aalis/plugin-openai', version: '1.0.0', keywords: ['aalis-plugin'] } },
          { package: { name: '@aalis/plugin-tools-api', version: '1.0.0', keywords: ['aalis-api'] } },
          { package: { name: '@aalis/plugin-webui-client', version: '1.0.0', keywords: ['aalis-interface'] } },
        ],
      },
      new Set(),
    );
    expect(pkgs.map(p => p.category)).toEqual(['plugin', 'api', 'interface']);
  });
});
