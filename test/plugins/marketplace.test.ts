import { describe, expect, it } from 'vitest';
import {
  augmentInstalled,
  buildSearchUrl,
  classifyPackage,
  findServiceDependents,
  toManifest,
  toMarketplacePackages,
} from '../../packages/plugin-webui-server/src/routes/marketplace.js';

// ════════════════════════════════════════════════════════════
// 插件市场 — npm registry 检索映射（纯 npm 路线，keyword 发现）
// ════════════════════════════════════════════════════════════

describe('buildSearchUrl（keyword 约定）', () => {
  it('无搜索词按四类 keyword（plugin∪util∪api∪interface，逗号 = 任一命中）', () => {
    expect(buildSearchUrl('')).toBe(
      'https://registry.npmjs.org/-/v1/search?text=keywords%3Aaalis-plugin%2Caalis-util%2Caalis-api%2Caalis-interface&size=100',
    );
  });
  it('带搜索词时 keyword + 词同时约束', () => {
    const url = buildSearchUrl('memory');
    expect(decodeURIComponent(url)).toContain('keywords:aalis-plugin,aalis-util,aalis-api,aalis-interface memory');
  });
  it('可配 registry 基址（去尾斜杠；空值回退官方源）', () => {
    expect(buildSearchUrl('', 'https://npm.example.com/')).toBe(
      'https://npm.example.com/-/v1/search?text=keywords%3Aaalis-plugin%2Caalis-util%2Caalis-api%2Caalis-interface&size=100',
    );
    expect(buildSearchUrl('', '')).toContain('registry.npmjs.org');
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

describe('toManifest（packument → 装前能力清单）', () => {
  it('读 dist-tags.latest 版本的 aalis.service', () => {
    const packument = {
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.0.0': { description: '旧' },
        '1.2.0': {
          description: '新',
          aalis: { service: { required: ['llm'], optional: ['memory'], provides: ['x'] } },
        },
      },
    };
    expect(toManifest(packument)).toEqual({
      name: '',
      version: '1.2.0',
      description: '新',
      service: { required: ['llm'], optional: ['memory'], provides: ['x'] },
    });
  });

  it('无 aalis.service 字段时 service 为 undefined（仍返回版本/描述）', () => {
    const m = toManifest({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { description: 'd' } } });
    expect(m).toEqual({ name: '', version: '1.0.0', description: 'd', service: undefined });
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
