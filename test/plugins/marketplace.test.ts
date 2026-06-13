import { describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
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

describe('toMarketplacePackages（响应映射 + 已装 + 官方标注）', () => {
  const resp = {
    objects: [
      {
        package: { name: '@aalis/plugin-foo', version: '1.2.0', description: 'Foo', publisher: { username: 'alice' } },
      },
      { package: { name: 'someone-aalis-plugin-bar', version: '0.1.0' } }, // 社区包（非 @aalis scope）
    ],
  };

  it('映射字段 + 已装标注 + @aalis scope 判官方', () => {
    const pkgs = toMarketplacePackages(resp, new Set(['@aalis/plugin-foo']));
    expect(pkgs).toEqual([
      {
        name: '@aalis/plugin-foo',
        version: '1.2.0',
        description: 'Foo',
        author: 'alice',
        installed: true,
        official: true,
      },
      {
        name: 'someone-aalis-plugin-bar',
        version: '0.1.0',
        description: '',
        author: undefined,
        installed: false,
        official: false, // 非 @aalis scope = 社区
      },
    ]);
  });

  it('空响应返回空数组（降级安全）', () => {
    expect(toMarketplacePackages({}, new Set())).toEqual([]);
    expect(toMarketplacePackages({ objects: [] }, new Set())).toEqual([]);
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
