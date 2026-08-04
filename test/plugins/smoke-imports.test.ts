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
 * 2. 导出 `name: string`（PluginManager 用作 ID）
 * 3. 导出 `apply: function`（PluginManager 用作激活入口）
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

/**
 * 跳过名单：只放**在 node 测试环境里跑不起来**的，不放「忘了加」的。
 * 每条都要写清为什么——否则它会变成第二个静默漏测的通道。
 */
const SKIP: Record<string, string> = {
  'plugin-vectorstore-lancedb': '原生 lance 绑定，CI 镜像不一定可用',
  // 曾有一条 'plugin-webui-client': '纯前端 React 包' —— 那是**死条目**：它的 keywords 是
  // `aalis-interface`，压根不进 loadablePluginDirs()，"跳过"从未发生。下面的守卫只查目录
  // 存在性，抓不出这类失效，故此记一笔：加 SKIP 前先确认该目录真的会被扫到。
};

describe('全插件 smoke import 契约', () => {
  const dirs = loadablePluginDirs();

  it('扫到足够多的插件——判据没有因为扫描口径变化而失效', () => {
    expect(dirs.length).toBeGreaterThan(50);
  });

  it('跳过名单里的每一项都仍然存在（删包后要一并清理，否则名单会掩盖真实缺失）', () => {
    const stale = Object.keys(SKIP).filter(d => !existsSync(join(PACKAGES, d, 'package.json')));
    expect(stale, `跳过名单里的包已不存在: ${stale.join('、')}`).toEqual([]);
  });

  for (const dir of dirs) {
    const reason = SKIP[dir];
    if (reason) {
      it.skip(`${dir} 导出 name + apply（跳过：${reason}）`, () => {});
      continue;
    }
    it(`${dir} 导出 name + apply`, async () => {
      const mod = await import(`../../packages/${dir}/src/index.ts`);
      expect(typeof mod.name).toBe('string');
      expect(mod.name.length).toBeGreaterThan(0);
      expect(typeof mod.apply).toBe('function');
    });
  }
});
