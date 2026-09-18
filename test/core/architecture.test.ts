import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
// 检查的是源文件**直接** import 说明符，由 TypeScript 语法树取出（import / export-from / 副作用 import /
// `import x = require()` / 内联 `import('...')` 类型 / 字面量动态 import），按**解析后的真实路径**判层——
// 只比文件名会在目录移动后静默变绿；用正则取说明符会被注释、字符串和转义骗过。
// types/ 按种类存放类型词汇：app.ts、plugin.ts 是编排层词汇，index.ts barrel 会把它们一并带出，
// 下层三者都不得引用；其余为基础词汇文件，只许互相引用。下层与基础词汇文件守同一条规则，
// 故只查直接 import 即可，不必另算传递闭包。
// ════════════════════════════════════════════════════════════

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core/src');

/** 分层目录，自下而上 */
const LAYERS = ['kernel', 'primitives', 'context', 'orchestration'] as const;
type Layer = (typeof LAYERS)[number];

/** src 根目录只许 barrel */
const ROOT_FILES = ['index.ts'];

/** types/ 里下层不得引用的文件：编排层词汇，以及会把它们一并带出的 barrel；其余为基础词汇 */
const UPPER_TYPES = new Set(['types/app.ts', 'types/plugin.ts', 'types/index.ts']);

interface Parsed {
  /** 全部字面量模块说明符（取 cooked 值，转义写法骗不过） */
  specifiers: string[];
  /** 说明符不是字面量的动态 import 个数——路径是算出来的，静态看不见它指向哪 */
  computedImports: number;
  /** `declare module 'x'` 的 x */
  ambientModules: string[];
  /** 有内容的接口名：自带成员，或经 extends 继承成员 */
  nonEmptyInterfaces: Set<string>;
}

const parsed = new Map<string, Parsed>();

function parse(file: string): Parsed {
  const hit = parsed.get(file);
  if (hit) return hit;
  const out: Parsed = { specifiers: [], computedImports: 0, ambientModules: [], nonEmptyInterfaces: new Set() };
  parsed.set(file, out);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) out.specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExternalModuleReference(node)) {
      if (ts.isStringLiteralLike(node.expression)) out.specifiers.push(node.expression.text);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        out.specifiers.push(node.argument.literal.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.specifiers.push(arg.text);
      else out.computedImports++;
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      out.ambientModules.push(node.name.text);
    } else if (ts.isInterfaceDeclaration(node)) {
      if (node.members.length > 0 || node.heritageClauses?.length) out.nonEmptyInterfaces.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest));
  return out;
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

/** 相对说明符（含裸 `.` / `..`）→ 它指向的路径（相对 src）；非相对说明符返回 null */
function resolveTarget(fromAbs: string, spec: string): string | null {
  if (!/^\.\.?(\/|$)/.test(spec)) return null;
  return relToSrc(resolve(dirname(fromAbs), spec.replace(/\.js$/, '.ts')));
}

/**
 * 目标必须落到 core/src 内的一个源文件上。目录形式（`'../types'`、`'..'`）会被 bundler 解析折叠成
 * 该目录的 index.ts，按路径判层就漏了——一律不认，要求写到文件。
 */
function isSourceFile(target: string): boolean {
  return !target.startsWith('../') && (statSync(join(SRC_DIR, target), { throwIfNoEntry: false })?.isFile() ?? false);
}

/** 某层文件 import 某目标是否越界；越界返回原因 */
function violation(layer: Layer, target: string): string | null {
  if (!isSourceFile(target)) return '解析不到 core/src 内的文件（相对说明符须写到文件，不认目录形式）';
  const top = target.split('/')[0];
  const targetLayer = LAYERS.indexOf(top as Layer);
  if (targetLayer >= 0) return targetLayer > LAYERS.indexOf(layer) ? `${layer}/ 不得依赖上层 ${top}/` : null;
  if (layer === 'orchestration') return null;
  if (layer === 'kernel') return 'kernel/ 只能引用 kernel/ 内部';
  if (top === 'types') return UPPER_TYPES.has(target) ? `${target} 含编排层词汇，请直接引用基础词汇文件` : null;
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
        for (const spec of parse(file).specifiers) {
          const target = resolveTarget(file, spec);
          const reason = target === null ? null : violation(layer, target);
          if (reason) violations.push(`${relToSrc(file)} → ${spec}：${reason}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it('types/ 的基础词汇文件只引用基础词汇（否则下层经它转手就触达上层）', () => {
    const files = walk(join(SRC_DIR, 'types')).filter(file => !UPPER_TYPES.has(relToSrc(file)));
    expect(files.length, '基础词汇文件为空——守卫在空转').toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      for (const spec of parse(file).specifiers) {
        const target = resolveTarget(file, spec);
        if (target === null) continue;
        const ok = target.startsWith('types/') && !UPPER_TYPES.has(target) && isSourceFile(target);
        if (!ok) violations.push(`${relToSrc(file)} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
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
      for (const name of parse(file).ambientModules) {
        if (name.startsWith('.')) offenders.push(`${relToSrc(file)} → ${name}`);
      }
    }
    expect(
      offenders,
      '相对 declare module 会把扩展点接口绑成第二个 symbol，导致 -api 包的 declaration merging 全部失效（且四道门全绿）',
    ).toEqual([]);
  });

  // ── core 洁癖：零运行时依赖 / 环境无关 / 扩展点为空 ──

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

  it('core 源码只写相对说明符，且不用算出来的路径 import', () => {
    // core 零依赖、环境无关、不认识领域词汇，所以任何非相对说明符都不该出现：`@aalis/*` 是领域词汇倒灌，
    // `node:*` 破坏环境无关，其它包名（含 type-only）会让发布出去的 .d.ts 依赖一个没声明的包，
    // `#别名` 则绕开按路径判层。不能只靠 biome：它的 noRestrictedImports 名单只有 8 个模块名，
    // 而**上一次真实事故**注入的 `node:events` 与 `node:path` 都不在名单里——build / test / biome / knip
    // 四道门当时全绿。这里整类拦，不维护名单。
    // 路径是算出来的动态 import（变量、带插值的模板串）静态看不见指向，同样不许：插件从哪里来由宿主的
    // PluginLoader 负责，core 自己没有按路径加载任何东西的理由。
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const { specifiers, computedImports } = parse(file);
      for (const spec of specifiers) {
        if (resolveTarget(file, spec) === null) offenders.push(`${relToSrc(file)} → ${spec}`);
      }
      if (computedImports > 0) offenders.push(`${relToSrc(file)} → ${computedImports} 处非字面量动态 import`);
    }
    expect(offenders, 'core 必须零依赖、环境无关——环境专有件由宿主 @aalis/runtime 经 AppOptions 注入').toEqual([]);
  });

  it('扩展点接口在 core 内只登记基础词汇层能完整表达的 core 自持条目', () => {
    // 同一条规则覆盖四张表：事件的载荷是字符串，core 自持的内置事件全部登记（AalisEvents 从不为空）；
    // services 的 core 自持条目 app / plugins 里，plugins 的契约引用编排层词汇（PluginEntry 等），
    // 基础词汇文件不得向上引用，成对登不了就一个不登；hooks / contributions 没有 core 自持条目。
    const EMPTY_POINTS = ['ServiceTypeMap', 'HookContextMap', 'ContributionPointMap'];
    const offenders: string[] = [];
    let eventsRegistered = false;
    for (const file of walk(SRC_DIR)) {
      const { nonEmptyInterfaces } = parse(file);
      if (nonEmptyInterfaces.has('AalisEvents')) eventsRegistered = true;
      for (const name of EMPTY_POINTS) {
        if (nonEmptyInterfaces.has(name)) offenders.push(`${relToSrc(file)} → ${name} 有条目或继承了别的接口`);
      }
    }
    expect(offenders, 'services / hooks / contributions 的扩展点在 core 内必须为空——条目由 -api 包增广注入').toEqual(
      [],
    );
    expect(eventsRegistered, 'AalisEvents 必须登记 core 自持的内置事件').toBe(true);
  });
});
