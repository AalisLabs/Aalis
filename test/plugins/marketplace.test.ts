import { describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
  findServiceDependents,
  isProtectedPackage,
  toManifest,
  toMarketplacePackages,
} from '../../packages/plugin-webui-server/src/routes/marketplace.js';

// ════════════════════════════════════════════════════════════
// 插件市场 — npm registry 检索映射（纯 npm 路线，keyword 发现）
// ════════════════════════════════════════════════════════════

describe('buildSearchUrl（keyword 约定）', () => {
  it('无搜索词只按 aalis-plugin keyword', () => {
    expect(buildSearchUrl('')).toBe('https://registry.npmjs.org/-/v1/search?text=keywords%3Aaalis-plugin&size=100');
  });
  it('带搜索词时 keyword + 词同时约束', () => {
    const url = buildSearchUrl('memory');
    expect(decodeURIComponent(url)).toContain('keywords:aalis-plugin memory');
  });
  it('可配 registry 基址（去尾斜杠；空值回退官方源）', () => {
    expect(buildSearchUrl('', 'https://npm.example.com/')).toBe(
      'https://npm.example.com/-/v1/search?text=keywords%3Aaalis-plugin&size=100',
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
    expect(p.scoreDetail).toEqual({ quality: 0.9, popularity: 0.5, maintenance: 0.7 });
    expect(p.insecure).toBe(true);
    expect(p.license).toBe('MIT');
    expect(p.links).toEqual({ npm: 'https://npm/x', homepage: 'https://home' });
  });

  it('空响应返回空数组（降级安全）', () => {
    expect(toMarketplacePackages({}, new Set())).toEqual([]);
    expect(toMarketplacePackages({ objects: [] }, new Set())).toEqual([]);
  });
});

describe('isProtectedPackage（卸载护栏：核心/契约/WebUI 基础设施不可卸）', () => {
  it('硬保护：core / package-manager / webui-server / webui-client', () => {
    expect(isProtectedPackage('@aalis/core')).toBe(true);
    expect(isProtectedPackage('@aalis/plugin-package-manager')).toBe(true);
    expect(isProtectedPackage('@aalis/plugin-webui-server')).toBe(true);
    expect(isProtectedPackage('@aalis/plugin-webui-client')).toBe(true);
  });
  it('契约包：任意 *-api 短名（被大量插件依赖）', () => {
    expect(isProtectedPackage('@aalis/plugin-webui-api')).toBe(true);
    expect(isProtectedPackage('@aalis/plugin-tools-api')).toBe(true);
    expect(isProtectedPackage('some-thing-api')).toBe(true);
  });
  it('manifest 标记 core===true 的插件受保护', () => {
    expect(isProtectedPackage('@aalis/plugin-agent', { core: true })).toBe(true);
    expect(isProtectedPackage('@aalis/plugin-agent', { core: false })).toBe(false);
  });
  it('普通功能插件可卸', () => {
    expect(isProtectedPackage('@aalis/plugin-openai')).toBe(false);
    expect(isProtectedPackage('community-aalis-plugin-foo')).toBe(false);
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
