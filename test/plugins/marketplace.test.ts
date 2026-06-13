import { describe, expect, it } from 'vitest';
import { buildSearchUrl, toMarketplacePackages } from '../../packages/plugin-webui-server/src/routes/marketplace.js';

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
});

describe('toMarketplacePackages（响应映射 + 已装标注）', () => {
  const resp = {
    objects: [
      {
        package: { name: '@aalis/plugin-foo', version: '1.2.0', description: 'Foo', publisher: { username: 'alice' } },
      },
      { package: { name: '@aalis/plugin-bar', version: '0.1.0' } }, // 缺 description/publisher
    ],
  };

  it('映射字段并按已装集合标注 installed', () => {
    const pkgs = toMarketplacePackages(resp, new Set(['@aalis/plugin-foo']));
    expect(pkgs).toEqual([
      { name: '@aalis/plugin-foo', version: '1.2.0', description: 'Foo', author: 'alice', installed: true },
      { name: '@aalis/plugin-bar', version: '0.1.0', description: '', author: undefined, installed: false },
    ]);
  });

  it('空响应返回空数组（降级安全）', () => {
    expect(toMarketplacePackages({}, new Set())).toEqual([]);
    expect(toMarketplacePackages({ objects: [] }, new Set())).toEqual([]);
  });
});
