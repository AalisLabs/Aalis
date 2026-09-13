import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countPlugins, renderReadme } from '../../packages/create-aalis/src/cli.js';

function keywordsOf(pkgDir: string): string[] {
  const raw = readFileSync(new URL(`../../packages/${pkgDir}/package.json`, import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { keywords?: string[] }).keywords ?? [];
}

// 生成项目的「启用集：N 个插件」必须对得上运行时「发现 N 个插件」。
// webui-client 是 webui-server 的伴生前端静态资源（keywords 为 aalis-interface、无 apply），
// 加载器的关键词硬门不认它；算进去会让 README 比实际多一个（standard 档实测 41 vs 40）。

describe('create-aalis 插件计数', () => {
  it('排除非插件伴生包 webui-client', () => {
    const enabled = new Set([
      '@aalis/plugin-webui-server',
      '@aalis/plugin-webui-client',
      '@aalis/plugin-package-manager',
    ]);
    expect(countPlugins(enabled)).toBe(2);
  });

  it('没有伴生包时与集合大小一致', () => {
    expect(countPlugins(['@aalis/plugin-cli', '@aalis/plugin-agent'])).toBe(2);
  });

  // 脚手架里的排除表是手抄的，真实判据却是加载器的关键词硬门（isLoadablePlugin）。
  // 两边同源漂移就会一起错，所以把手抄表钉到真实 package.json 上。
  it('排除表里的包，在真实 package.json 里确实不带 aalis-plugin 关键词', () => {
    expect(keywordsOf('plugin-webui-client')).not.toContain('aalis-plugin');
    // 反面：随便一个真插件必须带着这个关键词，否则说明判据本身变了
    expect(keywordsOf('plugin-webui-server')).toContain('aalis-plugin');
  });

  it('空集为 0', () => {
    expect(countPlugins(new Set())).toBe(0);
  });

  it('README 里的计数用的是插件数，不是依赖数', () => {
    const enabled = new Set([
      '@aalis/plugin-webui-server',
      '@aalis/plugin-webui-client',
      '@aalis/plugin-package-manager',
    ]);
    expect(renderReadme('demo', enabled)).toContain('启用集：2 个插件');
  });
});
