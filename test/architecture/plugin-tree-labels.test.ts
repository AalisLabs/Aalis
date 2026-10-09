import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DEFAULT_SUBSYSTEM_METADATA } from '../../packages/api-webui/src/index.js';
import type { PluginDefinition } from '../../packages/core/src/index.js';

// WebUI 插件树按 subsystem 分组、按 displayName 列出插件：默认表里没有的 subsystem 按 id 原样当组名，没有 displayName
// 的列包名、归进「其他」。第三方插件可以这样，第一方插件要在默认表里有中文组名、自带显示名，新装的实例里插件树才整齐。

const PACKAGES = join(__dirname, '../../packages');

it('第一方插件都有显示名，subsystem 在默认表里', async () => {
  const known = new Set(DEFAULT_SUBSYSTEM_METADATA.map(entry => entry.id));
  const problems: string[] = [];
  let audited = 0;
  for (const pkg of readdirSync(PACKAGES)) {
    const pkgJson = join(PACKAGES, pkg, 'package.json');
    const entry = join(PACKAGES, pkg, 'src/index.ts');
    if (!existsSync(pkgJson) || !existsSync(entry)) continue;
    const keywords = (JSON.parse(readFileSync(pkgJson, 'utf-8')) as { keywords?: string[] }).keywords ?? [];
    if (!keywords.includes('aalis-plugin')) continue;
    const def = ((await import(entry)) as { default: PluginDefinition }).default;
    audited++;
    if (!def.displayName) problems.push(`${pkg}：没有 displayName，插件树列出包名`);
    if (!def.subsystem || !known.has(def.subsystem)) {
      problems.push(`${pkg}：subsystem「${def.subsystem ?? '没写'}」不在 DEFAULT_SUBSYSTEM_METADATA 里`);
    }
  }
  expect(audited).toBeGreaterThan(50);
  expect(problems).toEqual([]);
}, 120_000);
