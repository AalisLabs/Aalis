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
  'disposable-chain.ts',
  'events.ts',
  'hooks.ts',
  'logger.ts',
  'service-helpers.ts',
  'service.ts',
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
