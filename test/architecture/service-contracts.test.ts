import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 服务契约的归属
//
// 1. 每个服务名全仓只有一处 defineService。同名描述符在容器里就是同一个服务，
//    第二处定义等于把契约抄了一份：类型各写各的，改一边另一边不报错。消费方要的是
//    契约包导出的那一个描述符。
// 2. 包的发布依赖（dependencies / optionalDependencies / peerDependencies）里
//    不出现插件实现包。消费方依赖契约包；依赖实现包会把实现连同它的依赖树一起装进来，
//    也让「换一个提供者」在包管理层面做不到。确有需要的（如打包一整套插件的发行包）
//    进 ALLOWED_PLUGIN_DEPS 并写明理由。devDependencies 不发布，不在此列。
//
// 扫描面是 packages/*/src 与根 src；测试里为替身随手定义的描述符不算。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGES = join(ROOT, 'packages');

/**
 * 服务名不是字面量的 defineService 只允许出现在这里：文件 → 包装函数名。
 * core 的六项内置服务经同文件的 `builtin('<名>')` 定义，包装函数的字面量实参视同 defineService。
 */
const NAME_WRAPPERS = new Map([['packages/core/src/composition/core-services.ts', 'builtin']]);

/** 发布依赖里允许出现的插件实现包：`<依赖方目录> → <被依赖包名>` → 理由。新增必须写理由。 */
const ALLOWED_PLUGIN_DEPS = new Map<string, string>();

interface Definition {
  name: string;
  site: string;
}

/**
 * 一个源文件里的服务定义。defineService 按导入绑定识别（含 `as` 改名）与命名空间访问（`core.defineService`）；
 * 服务名须是字面量，否则记进 `dynamic`——守卫看不见的名字不许存在。
 */
function collectDefinitions(
  file: string,
  source: string,
  wrapper?: string,
): { definitions: Definition[]; dynamic: string[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const locals = new Set<string>(['defineService']);
  for (const stmt of sf.statements) {
    const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      if ((spec.propertyName ?? spec.name).text === 'defineService') locals.add(spec.name.text);
    }
  }
  const definitions: Definition[] = [];
  const dynamic: string[] = [];
  const site = (node: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const direct =
        (ts.isIdentifier(callee) && locals.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'defineService');
      const wrapped = wrapper !== undefined && ts.isIdentifier(callee) && callee.text === wrapper;
      if (direct || wrapped) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) definitions.push({ name: arg.text, site: site(node) });
        else if (!(direct && wrapper !== undefined)) dynamic.push(site(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { definitions, dynamic };
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter(name => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
    .map(name => join(dir, name));
}

function scanDefinitions(): { byName: Map<string, string[]>; dynamic: string[] } {
  const roots = [
    join(ROOT, 'src'),
    ...readdirSync(PACKAGES)
      .map(dir => join(PACKAGES, dir, 'src'))
      .filter(existsSync),
  ];
  const byName = new Map<string, string[]>();
  const dynamic: string[] = [];
  for (const file of roots.flatMap(sourceFiles)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const found = collectDefinitions(rel, readFileSync(file, 'utf8'), NAME_WRAPPERS.get(rel));
    for (const def of found.definitions) byName.set(def.name, [...(byName.get(def.name) ?? []), def.site]);
    dynamic.push(...found.dynamic);
  }
  return { byName, dynamic };
}

interface Manifest {
  name: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** 发布依赖里指向插件实现包（keywords 含 aalis-plugin）的边，已按 ALLOWED_PLUGIN_DEPS 豁免。 */
function pluginImplementationDeps(manifests: Map<string, Manifest>, allowed: Map<string, string>): string[] {
  const plugins = new Set([...manifests.values()].filter(m => m.keywords?.includes('aalis-plugin')).map(m => m.name));
  const edges: string[] = [];
  for (const [dir, m] of manifests) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const dep of Object.keys(m[field] ?? {})) {
        const edge = `${dir} → ${dep}`;
        if (plugins.has(dep) && !allowed.has(edge)) edges.push(`${edge}（${field}）`);
      }
    }
  }
  return edges;
}

function readManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const dir of readdirSync(PACKAGES)) {
    const fp = join(PACKAGES, dir, 'package.json');
    if (existsSync(fp)) manifests.set(dir, JSON.parse(readFileSync(fp, 'utf8')) as Manifest);
  }
  return manifests;
}

describe('每个服务名只有一处 defineService', () => {
  const { byName, dynamic } = scanDefinitions();

  it('扫描面覆盖契约包、插件就地定义、core 内置六项与宿主两项', () => {
    expect(byName.size).toBeGreaterThan(40);
    for (const name of ['events', 'lifecycle', 'logger', 'config', 'provide', 'services', 'app', 'plugins']) {
      expect(byName.has(name), `core 的 ${name} 应被识别`).toBe(true);
    }
    expect(byName.get('user-relation')).toEqual([expect.stringMatching(/^packages\/api-user-relation\/src\//)]);
    expect(byName.get('package-manager')).toEqual([expect.stringMatching(/^packages\/api-package-manager\/src\//)]);
    expect(byName.get('session-history')).toEqual([expect.stringMatching(/^packages\/api-session-history\/src\//)]);
  });

  it('没有重复定义的服务名', () => {
    const duplicated = [...byName]
      .filter(([, sites]) => sites.length > 1)
      .map(([name, s]) => `${name}: ${s.join('、')}`);
    expect(
      duplicated,
      '同一服务名只能有一处 defineService。消费方从契约包导入描述符，没有契约包的先建契约包：\n' +
        duplicated.join('\n'),
    ).toEqual([]);
  });

  it('服务名都是字面量', () => {
    expect(dynamic, '服务名须写成字面量，守卫才看得见；包装函数须登记进 NAME_WRAPPERS').toEqual([]);
  });

  it('识别改名导入、命名空间访问与包装函数；非字面量服务名单独报出', () => {
    const src = [
      "import { defineService as ds } from '@aalis/core';",
      "import * as core from '@aalis/core';",
      "export const a = ds<number>('dup');",
      "export const b = core.defineService('dup');",
      "export const c = builtin('wrapped');",
      'export const d = ds(nameVar);',
    ].join('\n');
    const plain = collectDefinitions('x.ts', src);
    expect(plain.definitions.map(d => d.name)).toEqual(['dup', 'dup']);
    expect(plain.dynamic).toEqual(['x.ts:6']);
    expect(collectDefinitions('x.ts', src, 'builtin').definitions.map(d => d.name)).toEqual(['dup', 'dup', 'wrapped']);
  });
});

describe('发布依赖里没有插件实现包', () => {
  const manifests = readManifests();

  it('扫描面覆盖全部插件包', () => {
    const plugins = [...manifests.values()].filter(m => m.keywords?.includes('aalis-plugin'));
    expect(plugins.length).toBeGreaterThan(50);
  });

  it('dependencies / optionalDependencies / peerDependencies 不含插件实现包', () => {
    const edges = pluginImplementationDeps(manifests, ALLOWED_PLUGIN_DEPS);
    expect(
      edges,
      '改依赖对应的契约包（@aalis/api-*）；需要的类型或描述符还在实现包里的，先移进契约包。确属例外的进 ALLOWED_PLUGIN_DEPS 并写理由',
    ).toEqual([]);
  });

  it('判定能认出插件实现包，并按名单豁免', () => {
    const sample = new Map<string, Manifest>([
      ['plugin-a', { name: '@x/plugin-a', keywords: ['aalis-plugin'] }],
      ['api-a', { name: '@x/api-a', keywords: ['aalis-api'] }],
      [
        'plugin-b',
        { name: '@x/plugin-b', keywords: ['aalis-plugin'], dependencies: { '@x/plugin-a': '1', '@x/api-a': '1' } },
      ],
      ['dist', { name: '@x/dist', peerDependencies: { '@x/plugin-a': '1' } }],
    ]);
    expect(pluginImplementationDeps(sample, new Map())).toEqual([
      'plugin-b → @x/plugin-a（dependencies）',
      'dist → @x/plugin-a（peerDependencies）',
    ]);
    expect(pluginImplementationDeps(sample, new Map([['dist → @x/plugin-a', '发行包']]))).toEqual([
      'plugin-b → @x/plugin-a（dependencies）',
    ]);
  });
});
