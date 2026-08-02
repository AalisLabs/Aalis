import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// core 内部分层架构测试
//
// 设计决策：core 不拆 kernel 包——包是发布/
// 版本化单位而非模块化单位；但内部维持「基底层不得 import 编排层」的依赖方向，
// 由本测试设防，使"理论上可拆"始终成立（满足特定条件时可重新评估）。
//
// 分层口径：
// - 基底层：通用机制，不知道"插件"与"应用"概念的存在，可被任何宿主形态复用
// - 编排层：把基底层机制编排成插件生命周期与应用骨架
// - 中立层：barrel（index）与宿主 SPI（providers，type-only 桥接双向词汇，不设防）
//
// 检查的是源文件**直接** import 说明符（含 export-from 与内联 `import('...')` 类型
// 引用）。types/index.ts barrel 会在类型层传递性地触达编排层类型，属已知豁免——
// 本测试设防的是值依赖与直接词汇依赖，不是类型可达性。
// ════════════════════════════════════════════════════════════

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core/src');

/** 基底层：禁止 import 编排层 */
const BASE_LAYER = [
  'config.ts',
  'context.ts',
  'contributions.ts',
  'disposable-chain.ts',
  'events.ts',
  'hooks.ts',
  'logger.ts',
  'services-helpers.ts',
  'services.ts',
];

/** 编排层：插件生命周期 + 应用骨架（允许向下依赖基底层） */
const ORCHESTRATION_LAYER = ['app.ts', 'plugin.ts', 'plugin-activation.ts', 'plugin-topology.ts'];

/** 中立：barrel 与宿主 SPI */
const NEUTRAL = ['index.ts', 'providers.ts'];

/** 基底层文件中被禁止出现的 import 目标（去掉 ./ 前缀与扩展名后比较） */
const FORBIDDEN_TARGETS = new Set([
  'app',
  'plugin',
  'plugin-activation',
  'plugin-topology',
  'types/app',
  'types/plugin',
]);

/** 提取一个 TS 源文件的全部 import 说明符：静态 import/export-from + 内联 import('...') */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specs.push(m[1]);
  }
  return specs;
}

/** './plugin.js' / './types/app.js' → 'plugin' / 'types/app'（非相对导入返回 null） */
function normalizeRelative(spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  return spec.replace(/^(\.\.?\/)+/, '').replace(/\.(js|ts)$/, '');
}

describe('core 内部分层（基底层 ⇸ 编排层）', () => {
  it('src 根目录每个文件都已分层登记（新文件必须归类，防口径漂移）', () => {
    const actual = readdirSync(SRC_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.ts'))
      .map(d => d.name)
      .sort();
    const registered = [...BASE_LAYER, ...ORCHESTRATION_LAYER, ...NEUTRAL].sort();
    expect(actual, '新增/删除 core 源文件时请同步更新本测试的分层清单').toEqual(registered);
  });

  for (const file of BASE_LAYER) {
    it(`基底层 ${file} 不 import 编排层`, () => {
      const source = readFileSync(join(SRC_DIR, file), 'utf-8');
      const violations = importSpecifiers(source)
        .map(normalizeRelative)
        .filter((t): t is string => t !== null && FORBIDDEN_TARGETS.has(t));
      expect(
        violations,
        `${file} 引用了编排层模块 [${violations.join(', ')}]——基底层不得知道"插件/应用"的存在`,
      ).toEqual([]);
    });
  }
});

/**
 * 扩展点增广的**说明符形式**：core 内不得出现相对路径的 `declare module`。
 *
 * 守的是一次实测事故：core 曾在 `types/app.ts` 用相对 `declare module './services.js'` 给
 * ServiceTypeMap 补 `app`/`plugins`。当 `-api` 包的 `declare module '@aalis/core'` 先绑定时
 * （biome 的 import 排序让 `@aalis/api-*` 恒排在 `@aalis/core` 之前，真实代码 100% 命中），
 * TS 把两者绑成**两个不同的接口**——36 个 api 服务在 core 的签名视角里直接不存在，
 * `ctx.getService('storage')` 悄悄退回 `unknown`。build / test / biome / knip 四道门全绿。
 *
 * ⚠️ 递归扫**整个 core/src**，不是只扫 types/。第一版只扫 types/ 一层，实测把同一段挪进
 * `src/app.ts` 或 `src/context.ts` 就 100% 复发而守卫一声不吭——而 `src/app.ts`（编排层、
 * 天然会写 App 相关声明）恰恰是最像会重犯的地方。
 *
 * 注意本条守的是**说明符形式**，不是「接口必须为空」。键写在 ServiceTypeMap 接口体里没问题
 * （`app`/`plugins` 就在那儿，实测对 36 个 api 服务零影响）；病在相对说明符。曾经有过一条
 * 「接口必须字面为空」的守卫，它既拦不住换个文件写的同一个病，又对正确写法误报，已删。
 */
describe('core 扩展点：增广只能用裸包名说明符', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = join(dir, e.name);
      return e.isDirectory() ? walk(full) : e.name.endsWith('.ts') ? [full] : [];
    });

  /** 剥掉块注释与行注释——否则解释这条规则的注释本身会把守卫打红（第一版就中了）。 */
  const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('core/src 下（递归）没有任何相对路径的 declare module', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      for (const m of code.matchAll(/declare\s+module\s+['"](\.[^'"]*)['"]/g)) {
        offenders.push(`${file.slice(SRC_DIR.length + 1)} → ${m[1]}`);
      }
    }
    expect(
      offenders,
      '相对 declare module 会把扩展点接口绑成第二个 symbol，导致 -api 包的 declaration merging 全部失效（且四道门全绿）',
    ).toEqual([]);
  });
});
