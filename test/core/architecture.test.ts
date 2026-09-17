import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// core 内部分层架构测试
//
// 设计决策：core 不拆 kernel 包——包是发布/
// 版本化单位而非模块化单位；但内部维持单向的依赖方向，
// 由本测试设防，使"理论上可拆"始终成立（满足特定条件时可重新评估）。
//
// 分层即目录，自下而上，每层只许 import 本层与更低层：
// - kernel/：资源生命周期与清理链，只认自己，不引用类型词汇、四原语、Context 或编排层
// - primitives/：四原语注册表，只认 kernel 与类型词汇，不认识 Context、Logger、Config
//   （需要上报的诊断经注入的回调送出）
// - context/：Context 门面及其配置、日志、服务接线辅助，不依赖编排层
// - orchestration/：把下层机制编排成插件生命周期与应用骨架，含宿主 SPI（插件加载器、重启策略）
// src 根只留 barrel（index）。
//
// 检查的是源文件**直接** import 说明符（含 export-from 与内联 `import('...')` 类型
// 引用），按**解析后的真实路径**判层——只比文件名会在目录移动后静默变绿。
// types/index.ts barrel 会在类型层传递性地触达编排层类型，属已知豁免——
// 本测试设防的是值依赖与直接词汇依赖，不是类型可达性。
// ════════════════════════════════════════════════════════════

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core/src');

/** 分层目录，自下而上 */
const LAYERS = ['kernel', 'primitives', 'context', 'orchestration'] as const;
type Layer = (typeof LAYERS)[number];

/** src 根目录只许 barrel */
const ROOT_FILES = ['index.ts'];

/** types/ 里属于编排层词汇的文件；其余为下层可用的基础词汇 */
const ORCHESTRATION_TYPES = new Set(['types/app.ts', 'types/plugin.ts']);

/** 剥掉块注释与行注释——否则解释这些规则的注释本身会把守卫打红。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * 提取一个 TS 源文件的全部模块说明符。
 *
 * 三种位置一并覆盖：`from 'x'`（含 export-from）、纯副作用 `import 'x'`、内联 `import('x')`。
 * 只认 `from` 会漏掉副作用 import，而那正是做 declaration merging 的常用写法；
 * 且不要求 import 写在一行内——biome 的 lineWidth 会折行。
 */
function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.ts') ? [full] : [];
  });
}

/** 绝对路径 → 相对 src 的 posix 路径（'context/context.ts'） */
function relToSrc(abs: string): string {
  return relative(SRC_DIR, abs).split(sep).join('/');
}

/** 相对说明符 → 它指向的源文件（相对 src）；非相对说明符返回 null */
function resolveTarget(fromAbs: string, spec: string): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  return relToSrc(resolve(dirname(fromAbs), spec.replace(/\.js$/, '.ts')));
}

/** 某层文件 import 某目标是否越界；越界返回原因 */
function violation(layer: Layer, target: string): string | null {
  if (target.startsWith('../') || !existsSync(join(SRC_DIR, target))) return '解析不到 core/src 内的文件';
  const top = target.split('/')[0];
  const targetLayer = LAYERS.indexOf(top as Layer);
  if (targetLayer >= 0) return targetLayer > LAYERS.indexOf(layer) ? `${layer}/ 不得依赖上层 ${top}/` : null;
  if (layer === 'orchestration') return null;
  if (layer === 'kernel') return 'kernel/ 只能引用 kernel/ 内部';
  if (top === 'types') return ORCHESTRATION_TYPES.has(target) ? `${target} 是编排层词汇` : null;
  return `${layer}/ 不得引用 ${target}`;
}

describe('core 内部分层（目录即层，依赖只许向下）', () => {
  it('src 根目录只有 barrel 与已登记的目录（新目录必须归层，防口径漂移）', () => {
    const entries = readdirSync(SRC_DIR, { withFileTypes: true });
    const files = entries.filter(d => d.isFile() && !d.name.startsWith('.')).map(d => d.name);
    const dirs = entries.filter(d => d.isDirectory()).map(d => d.name);
    expect(files, '源文件必须放进分层目录；src 根只留 barrel').toEqual(ROOT_FILES);
    expect(dirs.sort(), '新增/删除 core 源码目录时请同步更新本测试的分层口径').toEqual([...LAYERS, 'types'].sort());
  });

  for (const layer of LAYERS) {
    it(`${layer}/ 只依赖本层与更低层`, () => {
      const files = walk(join(SRC_DIR, layer));
      expect(files.length, `${layer}/ 为空——守卫在空转`).toBeGreaterThan(0);
      const violations: string[] = [];
      for (const file of files) {
        for (const spec of specifiers(stripComments(readFileSync(file, 'utf-8')))) {
          const target = resolveTarget(file, spec);
          // kernel 连裸说明符也不许有：它不依赖任何包
          const reason =
            target === null ? (layer === 'kernel' ? 'kernel/ 不得引用任何包' : null) : violation(layer, target);
          if (reason) violations.push(`${relToSrc(file)} → ${spec}：${reason}`);
        }
      }
      expect(violations).toEqual([]);
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
 * `orchestration/app.ts` 或 `context/context.ts` 就 100% 复发而守卫一声不吭——而 `app.ts`（编排层、
 * 天然会写 App 相关声明）恰恰是最像会重犯的地方。
 *
 * 本条守的是**说明符形式**（相对路径会把接口绑成第二个 symbol），与「扩展点是否为空」
 * 是两件正交的事——后者由下面单独一条守。
 */
describe('core 扩展点：增广只能用裸包名说明符', () => {
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

  // ── core 洁癖：零运行时依赖 / 环境无关 / 扩展点为空 ──
  //
  // CLAUDE.md 把这三条列为硬约束并声称有测试守，实际此前只有「相对 declare module」一条。
  // 这四条把缺口补齐。
  //
  // 说明符一律**同时匹配 `from 'x'` 与纯副作用 `import 'x'`**：后者不含 `from`，只查前者
  // 会留一个绕过口，而副作用 import 恰恰是本仓做 declaration merging 的常用形态。

  it('core 零运行时依赖（dependencies 必须为空）', () => {
    const pkg = JSON.parse(readFileSync(join(SRC_DIR, '../package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    // peerDependencies 不在此列：core 被插件 peer 依赖是正向的，且不产生安装体积。
    // optionalDependencies 在此列：它同样会被 npm 装进用户的 node_modules。
    expect(
      [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})],
      'core 必须零运行时依赖——环境专有件由宿主经 AppOptions 注入，不由 core 自取',
    ).toEqual([]);
  });

  it('core 源码不 import 任何 @aalis/* 包（含类型 import 与纯副作用 import）', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      // stripComments 已剥掉注释，故不会被「注释里提到包名」误伤
      for (const spec of specifiers(stripComments(readFileSync(file, 'utf-8')))) {
        if (spec.startsWith('@aalis/')) offenders.push(`${file.slice(SRC_DIR.length + 1)} → ${spec}`);
      }
    }
    expect(offenders, 'core 引用了其它 @aalis 包——领域词汇正在倒灌进内核').toEqual([]);
  });

  it('core 源码不 import 任何 node: 内置模块（环境无关）', () => {
    // 不能只靠 biome：它的 noRestrictedImports 名单只有 8 个模块名，而**上一次真实事故**
    // 注入的 `node:events` 与 `node:path` 都不在名单里 —— build / test / biome / knip
    // 四道门当时全绿。这里按前缀整类拦，不维护名单。
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      for (const spec of specifiers(stripComments(readFileSync(file, 'utf-8')))) {
        if (spec.startsWith('node:')) offenders.push(`${file.slice(SRC_DIR.length + 1)} → ${spec}`);
      }
    }
    expect(offenders, 'core 必须环境无关——node 专有件由宿主 @aalis/runtime 经 AppOptions 注入').toEqual([]);
  });

  it('三个扩展点在 core 内保持字面为空（条目一律由 -api 包增广注入）', () => {
    // 不含 AalisEvents：core 自持 11 条基础设施事件，它从来不空（CLAUDE.md 那句话是错的）。
    const EMPTY_POINTS = ['ServiceTypeMap', 'HookContextMap', 'ContributionPointMap'];
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      for (const name of EMPTY_POINTS) {
        // 匹配 `interface X {  }`：花括号内出现任何非空白即视为登记了条目
        for (const m of code.matchAll(new RegExp(`interface\\s+${name}\\s*\\{([^}]*)\\}`, 'g'))) {
          if (m[1].trim()) offenders.push(`${file.slice(SRC_DIR.length + 1)} → ${name} 内有条目`);
        }
      }
    }
    expect(
      offenders,
      '扩展点在 core 内必须为空——即便是 core 自己 provide 的 app/plugins 也不例外：' +
        '全部消费点都显式传了类型参数，写进去买不到任何东西，却要拿洁癖去换',
    ).toEqual([]);
  });
});
