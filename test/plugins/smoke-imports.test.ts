import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../../packages');

/**
 * 全插件 smoke import 测试
 *
 * 每个生产插件都应该：
 * 1. 能被 import 成功（编译/依赖链路 OK）
 * 2. 默认导出是 definePlugin 的产物，带 `name: string`（PluginManager 用作 ID）
 * 3. 默认导出带 `apply: function`（PluginManager 用作激活入口）
 *
 * 目的不是验证业务行为，而是防止破坏性重构悄无声息地把插件搞坏：
 * 编译过 ≠ 模块能被 ESM 加载 ≠ 入口契约还在。
 *
 * **名单是扫出来的，不是手写的。** 此前是一份硬编码数组，实测漏了 8 个插件
 * （code-sandbox-os / cron-engine / doctor / memory-history / process-local /
 * session-confirm / user-relation / workflow）—— 每个都 `private:false`、带
 * `aalis-plugin` 关键词、导出 name/apply，纯粹是新增时忘了往数组里加。
 * 手写名单的失效方式是**静默漏测**，没有任何信号；改为扫描后新插件自动进来。
 */

/** 判定与两个加载器同源：纯 `aalis-plugin` 关键词正向门（见 runtime 的 isLoadablePlugin）。 */
function loadablePluginDirs(): string[] {
  return readdirSync(PACKAGES)
    .filter(dir => {
      const manifest = join(PACKAGES, dir, 'package.json');
      if (!existsSync(manifest)) return false;
      const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { private?: boolean; keywords?: string[] };
      return pkg.private !== true && Array.isArray(pkg.keywords) && pkg.keywords.includes('aalis-plugin');
    })
    .sort();
}

describe('全插件 smoke import 契约', () => {
  const dirs = loadablePluginDirs();

  it('扫到足够多的插件——判据没有因为扫描口径变化而失效', () => {
    expect(dirs.length).toBeGreaterThan(50);
  });

  for (const dir of dirs) {
    it(`${dir} 导出 name + apply`, async () => {
      const { default: plugin } = await import(`../../packages/${dir}/src/index.ts`);
      expect(typeof plugin?.name).toBe('string');
      expect(plugin.name.length).toBeGreaterThan(0);
      expect(typeof plugin.apply).toBe('function');
    });
  }
});
