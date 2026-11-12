import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runTscProbe } from '../helpers/tsc-probe.js';

// ════════════════════════════════════════════════════════════
// core 内部分层架构测试
//
// 设计决策：core 不拆 kernel 包——包是发布/
// 版本化单位而非模块化单位；但内部维持单向的依赖方向，
// 由本测试设防，使"理论上可拆"始终成立（满足特定条件时可重新评估）。
//
// 分层即目录，自下而上，每层只许 import 本层与更低层：
// - kernel/：资源生命周期与清理链，只认自己，不引用类型词汇、原语或编排层
// - primitives/：原语注册表（服务容器），只认 kernel 与类型词汇，不认识 Logger、Config
// - infrastructure/：配置值拷贝、日志与资源记录，只依赖资源内核、原语与基础词汇
// - composition/：服务描述符、绑定与工厂、默认服务和插件定义，不依赖编排层
// - orchestration/：把下层机制编排成插件生命周期与应用骨架
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
const LAYERS = ['kernel', 'primitives', 'infrastructure', 'composition', 'orchestration'] as const;
type Layer = (typeof LAYERS)[number];

/** src 根目录只许 barrel */
const ROOT_FILES = ['index.ts'];

/** types/ 里下层不得引用的文件：编排层词汇，以及会把它们一并带出的 barrel；其余为基础词汇 */
const UPPER_TYPES = new Set(['types/app.ts', 'types/plugin.ts', 'types/index.ts']);

interface Parsed {
  /** 逐条记录字面量依赖与是否纯类型，避免同包的类型导入掩盖另一条值导入。 */
  specifiers: Array<{ spec: string; typeOnly: boolean }>;
  /** 说明符不是字面量的动态 import 个数——路径是算出来的，静态看不见它指向哪 */
  computedImports: number;
  /** `declare module 'x'` 的 x */
  ambientModules: string[];
  /** 有内容的接口名：自带成员，或经 extends 继承成员 */
  nonEmptyInterfaces: Set<string>;
  /** 能自行补出宿主全局、绕过白名单的写法：`declare` 修饰的声明、对 globalThis 的引用、脚本文件（`行号: 写法`） */
  hostEscapes: string[];
}

const parsed = new Map<string, Parsed>();

function parse(file: string): Parsed {
  const hit = parsed.get(file);
  if (hit) return hit;
  const out = parseSource(file, readFileSync(file, 'utf-8'));
  parsed.set(file, out);
  return out;
}

function parseSource(file: string, source: string): Parsed {
  const out: Parsed = {
    specifiers: [],
    computedImports: 0,
    ambientModules: [],
    nonEmptyInterfaces: new Set(),
    hostEscapes: [],
  };
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const hostEscape =
      ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)
        ? node.getText(sf).split('\n')[0]
        : ts.isIdentifier(node) &&
            node.text === 'globalThis' &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          ? 'globalThis'
          : null;
    if (hostEscape) {
      out.hostEscapes.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${hostEscape}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (!clause?.name &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every(element => element.isTypeOnly));
      out.specifiers.push({ spec: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every(element => element.isTypeOnly));
      out.specifiers.push({ spec: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExternalModuleReference(node)) {
      if (ts.isStringLiteralLike(node.expression)) {
        out.specifiers.push({
          spec: node.expression.text,
          typeOnly: ts.isImportEqualsDeclaration(node.parent) && node.parent.isTypeOnly,
        });
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        out.specifiers.push({ spec: node.argument.literal.text, typeOnly: true });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.specifiers.push({ spec: arg.text, typeOnly: false });
      else out.computedImports++;
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      out.ambientModules.push(node.name.text);
    } else if (ts.isInterfaceDeclaration(node)) {
      if (node.members.length > 0 || node.heritageClauses?.length) out.nonEmptyInterfaces.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // 没有 import / export 的文件是脚本：顶层声明直接进全局，不写 declare 也能补出宿主全局
  if (!ts.isExternalModule(sf)) out.hostEscapes.push('1: 文件没有 import / export，顶层声明会成为全局');
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : e.name.endsWith('.ts') ? [full] : [];
  });
}

/** 绝对路径 → 相对 src 的 posix 路径（'composition/binding.ts'） */
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

/** Core 运行时代码不加载外部包，类型引用也不例外：发布出去的 .d.ts 不得引用未声明的包。 */
function externalReferenceViolations(file: string, source: Parsed): string[] {
  const rel = relToSrc(file);
  const offenders: string[] = [];
  for (const { spec } of source.specifiers) {
    if (resolveTarget(file, spec) !== null) continue;
    offenders.push(`${rel} → ${spec}`);
  }
  if (source.computedImports > 0) offenders.push(`${rel} → ${source.computedImports} 处非字面量动态 import`);
  return offenders;
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
        for (const { spec } of parse(file).specifiers) {
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
      for (const { spec } of parse(file).specifiers) {
        const target = resolveTarget(file, spec);
        if (target === null) continue;
        const ok = target.startsWith('types/') && !UPPER_TYPES.has(target) && isSourceFile(target);
        if (!ok) violations.push(`${relToSrc(file)} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('下层绕经内部激活导入仍被拒绝（含 type-only 与动态 import）', () => {
    const file = join(SRC_DIR, 'composition', 'binding.ts');
    const source =
      "import type { Activation } from '../orchestration/activation.js'; void import('../orchestration/activation-host.js');";
    const imports = parseSource(file, source).specifiers;
    expect(imports).toHaveLength(2);
    for (const { spec } of imports) expect(violation('composition', resolveTarget(file, spec)!)).not.toBeNull();
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
 * `orchestration/app.ts` 或 `composition/binding.ts` 就 100% 复发而守卫一声不吭——而 `app.ts`（编排层、
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

  it('core 零运行时依赖', () => {
    const pkg = JSON.parse(readFileSync(join(SRC_DIR, '../package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}), 'core 不得声明运行时依赖——环境专有件由宿主经 AppOptions 注入').toEqual(
      [],
    );
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
  });

  it('core 不得引用外部模块', () => {
    // `@aalis/*` 是领域词汇倒灌，`node:*` 破坏环境无关，其它包名（含 type-only）会让发布出去的 .d.ts
    // 引用未声明的包，`#别名` 则绕开按路径判层。不能只靠 biome：它的 noRestrictedImports 名单只有 8 个模块名，
    // 而**上一次真实事故**注入的 `node:events` 与 `node:path` 都不在名单里——build / test / biome / knip
    // 四道门当时全绿。这里整类拦，不维护名单。
    // 路径是算出来的动态 import（变量、带插值的模板串）静态看不见指向，同样不许：插件从哪里来由宿主的
    // PluginLoader 负责，core 自己没有按路径加载任何东西的理由。
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      offenders.push(...externalReferenceViolations(file, parse(file)));
    }
    expect(offenders, 'core 运行时环境无关，日志类型在 core 内定义').toEqual([]);
  });

  it('任何层都拒绝外部包引用，含纯类型导入', () => {
    const source = `import type { LogEntry } from '@aalis/schema-log';
      import { type LogLevel } from '@aalis/schema-log';
      type Entry = import('@aalis/schema-log').LogEntry;`;
    for (const path of [
      'infrastructure/logger.ts',
      'orchestration/app.ts',
      'kernel/disposable-chain.ts',
      'primitives/services.ts',
      'types/app.ts',
      'index.ts',
    ]) {
      const file = join(SRC_DIR, path);
      expect(externalReferenceViolations(file, parseSource(file, source)), path).toHaveLength(3);
    }
  });

  it('混合值导入、动态加载、转导出与其他外部包一律拒绝', () => {
    const file = join(SRC_DIR, 'infrastructure/logger.ts');
    for (const source of [
      "import { formatLogLine } from '@aalis/schema-log';",
      "import { type LogEntry, parseLogLine } from '@aalis/schema-log';",
      "import type { LogEntry } from '@aalis/schema-log'; import { parseLogLine } from '@aalis/schema-log';",
      "import '@aalis/schema-log';",
      "import {} from '@aalis/schema-log';",
      "void import('@aalis/schema-log');",
      "const path = '@aalis/schema-log'; void import(path);",
      "export { parseLogLine } from '@aalis/schema-log';",
      "export * from '@aalis/schema-log';",
      "import codec = require('@aalis/schema-log');",
      "import type { LogEntry } from '@aalis/schema-other';",
      "import type { Stats } from 'node:fs';",
    ]) {
      const expected = source.split('@aalis/schema-log').length - 1 > 1 ? 2 : 1;
      expect(externalReferenceViolations(file, parseSource(file, source)), source).toHaveLength(expected);
    }
  });

  it('core 不承载「名字 → 类型」的扩展表；事件、钩子与贡献点的扩展表在各自契约包里保持为空', () => {
    // 服务类型随描述符走；事件、钩子与贡献点的扩展表随契约包（@aalis/api-events / @aalis/api-hooks /
    // @aalis/api-contributions）走，契约包只声明空接口，条目由领域 -api 包与插件增广注入。
    const MOVED_OUT = /\binterface\s+(ServiceTypeMap|AalisEvents|HookContextMap|ContributionPointMap)\b/;
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const hit = readFileSync(file, 'utf-8').match(MOVED_OUT);
      if (hit) offenders.push(`${relToSrc(file)} → core 不再承载 ${hit[1]}`);
    }
    for (const [pkg, name] of [
      ['api-events', 'AalisEvents'],
      ['api-hooks', 'HookContextMap'],
      ['api-contributions', 'ContributionPointMap'],
    ]) {
      const file = join(SRC_DIR, `../../${pkg}/src/index.ts`);
      if (!readFileSync(file, 'utf-8').includes(`export interface ${name} {}`))
        offenders.push(`${pkg} 未声明空的 ${name}`);
      if (parse(file).nonEmptyInterfaces.has(name)) offenders.push(`${pkg} → ${name} 有条目或继承了别的接口`);
    }
    expect(offenders, '扩展表只在契约包里声明为空接口，条目由 -api 包与插件增广注入').toEqual([]);
  });
});

/**
 * 宿主全局白名单：core 用到的、浏览器 / Node / Deno / Bun / Workers 都提供的 Web 标准全局。签名取规范的子集，
 * 只列 core 用到的成员；core 要用新的宿主全局或新成员，先确认各目标运行时都提供，再在这里登记。
 * 没有 console：core 的日志经 Logger 交给宿主注入的 sink。
 */
const HOST_GLOBALS = `
declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare function queueMicrotask(callback: () => void): void;
interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
declare var AbortController: { prototype: AbortController; new (): AbortController };
interface DOMException extends Error {}
declare var DOMException: { prototype: DOMException; new (message?: string, name?: string): DOMException };
`;

/** 探针自检：编译配置漏进 Node 或 DOM 类型（types、lib 或三斜线引用）时，这些名字会变得可见 */
const HOST_ONLY = ['process', 'Buffer', 'require', '__dirname', 'console', 'window'];

describe('core 环境无关：只用 ES 标准库与登记的宿主全局', () => {
  // 继承 core 自己的编译配置，改两处：types 清空，不加载 @types/node；lib 只留 target 对应的 ES 标准库，
  // 不随 core 配置里的 lib 走（那里加上 DOM 也拦得住）。process / Buffer / require / __dirname 等宿主专有全局
  // 因此报「找不到名称」并给出位置。
  const tsconfig = join(SRC_DIR, '../tsconfig.json');
  const { target } = ts.getParsedCommandLineOfConfigFile(tsconfig, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  })!.options;
  const probeConfig = {
    extends: tsconfig,
    compilerOptions: { types: [], lib: [ts.ScriptTarget[target!]] },
    include: [SRC_DIR],
  };
  const missingNames = (errs: string[]) => errs.map(e => /Cannot find name '(\w+)'/.exec(e)?.[1] ?? e).sort();

  it('不加载 Node 与 DOM 类型编译 core 源码零错误', () => {
    const errs = runTscProbe(`${HOST_GLOBALS}${HOST_ONLY.map(name => `void ${name};\n`).join('')}`, probeConfig);
    const inCore = errs.filter(e => e.startsWith('packages/core/src/'));
    expect(inCore, 'core 只用 ES 标准库与 HOST_GLOBALS 登记的宿主全局，环境专有件由宿主经 AppOptions 注入').toEqual([]);
    const probe = missingNames(errs.filter(e => !inCore.includes(e)));
    expect(probe, '探针只应在自检名单上报错，编译配置不得漏进 Node 或 DOM 类型').toEqual([...HOST_ONLY].sort());
  });

  it('去掉白名单时 core 缺的恰好是白名单登记的名字', () => {
    // 证明 core 源码确实在编译范围内（否则上一条恒绿），且白名单没有 core 用不到的多余项
    const registered = [...new Set([...HOST_GLOBALS.matchAll(/(?:function|interface|var) (\w+)/g)].map(m => m[1]))];
    const inCore = runTscProbe('', probeConfig).filter(e => e.startsWith('packages/core/src/'));
    expect([...new Set(missingNames(inCore))]).toEqual(registered.sort());
  });

  it('core 源码没有 declare 声明、不引用 globalThis、每个文件都是模块（否则能自行补出宿主全局，上面两条照样全绿）', () => {
    const offenders = walk(SRC_DIR).flatMap(file => parse(file).hostEscapes.map(hit => `${relToSrc(file)}:${hit}`));
    expect(offenders, '宿主全局只经 HOST_GLOBALS 登记，环境专有件由宿主经 AppOptions 注入').toEqual([]);
  });

  it.each([
    'export {}; declare const process: any;',
    'export {}; declare let require: any;',
    'export {}; declare var Buffer: any;',
    'export {}; declare function require(id: string): unknown;',
    'export {}; declare class Buffer {}',
    'export {}; declare namespace NodeJS {}',
    "export {}; declare module 'node:process' {}",
    'export {}; declare global { var process: any; }',
    'export {}; void globalThis.process;',
    'export {}; void (globalThis as any).process;',
    'var setImmediate: (callback: () => void) => void;',
  ])('绕过白名单的写法被拒绝：%s', source => {
    expect(parseSource('probe.ts', source).hostEscapes).toHaveLength(1);
  });
});

// ── 覆盖率门禁不能靠跳过统计达成 ──
//
// vitest.core-coverage.config.ts 把 core 的四项覆盖率阈值定为 100。覆盖不到的分支只能补测试或删掉，
// 不能用 ignore 注释把它从分母里拿走。
describe('core 源码不含覆盖率 ignore 注释', () => {
  it('packages/core/src 下没有 v8 / c8 / istanbul 的 ignore 注释', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const source = readFileSync(file, 'utf-8');
      if (/\b(?:v8|c8|istanbul)\s+ignore\b/.test(source)) offenders.push(relToSrc(file));
    }
    expect(offenders).toEqual([]);
  });
});

// ── core 体量上限 ──
//
// 去掉注释与空行后的代码行数。上限按改动后的实测值设定，不留余量；抬高上限的提交要写明理由，不能随别的改动一并抬高。
// 计数方法：逐字符状态机去注释（识别字符串、模板串含嵌套 ${}），再数非空行。
const CORE_CODE_LINE_CEILING = 2597;

/** 去掉注释：字符串与模板串里的 `//` `/*` 不算注释 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const stack: Array<'`' | '{'> = [];
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') {
        out += c + d;
        i += 2;
      } else if (c === '`') {
        stack.pop();
        out += c;
        i++;
      } else if (c === '$' && d === '{') {
        stack.push('{');
        out += '${';
        i += 2;
      } else {
        out += c;
        i++;
      }
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      out += src.slice(i, j + 2).replace(/[^\n]/g, '');
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i] + src[i + 1];
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      out += c;
      i++;
      continue;
    }
    if (c === '`') stack.push('`');
    else if (c === '{' && stack.length) stack.push('{');
    else if (c === '}' && top === '{') stack.pop();
    out += c;
    i++;
  }
  return out;
}

describe('core 体量上限', () => {
  it(`packages/core/src 去注释后的代码行不超过 ${CORE_CODE_LINE_CEILING}`, () => {
    let total = 0;
    for (const file of walk(SRC_DIR)) {
      total += stripComments(readFileSync(file, 'utf-8'))
        .split('\n')
        .filter(line => line.trim() !== '').length;
    }
    expect(total, '抬高上限须在同一提交里写明理由').toBeLessThanOrEqual(CORE_CODE_LINE_CEILING);
    expect(total, '上限应贴着实测值：低于上限太多说明该收紧').toBeGreaterThan(CORE_CODE_LINE_CEILING - 200);
  });
});
