import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// core 发布面：package.json 的 exports 只开放包根与 package.json
//
// 包根是版本承诺面，dist 里的内部模块不是；不封 exports 时 `@aalis/core/dist/…` 深路径
// 照样能导入，内部文件一挪就断消费者。package.json 子路径必须开放：runtime 启动 banner、
// WebUI 系统组件页与插件加载器都按 `<包名>/package.json` 解析版本。
// files 带上 src，发布的 source map 与 declaration map 指向的 ../src 才随包在场。
//
// 解析行为由真实 Node 在临时目录里验证：装入本仓 core 的 package.json 原件，dist 用桩文件，
// 不依赖先 build。子进程跑，避开 vitest 对 `@aalis/*` 的源码别名。
//
// 封住深路径后，公开签名里出现的具名类型都必须从包根导出：消费方开 declaration（第一方各包与
// 脚手架都开）时，推断类型里的 core 类型要写成 `import("@aalis/core").X`，只从内部模块导出的
// 类型只能写成 dist 深路径，tsc 报 TS2742。这部分从源码产出声明文件到临时目录再核对。
// ════════════════════════════════════════════════════════════

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../packages/core');
const TSC = join(CORE_DIR, '../../node_modules/.bin/tsc');

interface CoreManifest {
  version: string;
  main?: string;
  types?: string;
  files?: string[];
  exports?: Record<string, unknown>;
}

const manifest = JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf-8')) as CoreManifest;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 临时目录里装一份 @aalis/core：本仓 package.json 原件，返回包目录 */
function installCore(): { root: string; pkgDir: string } {
  // realpath：macOS 的 tmpdir 经符号链接，tsc 解析出的文件名是真实路径
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-core-exports-')));
  tempDirs.push(root);
  const pkgDir = join(root, 'node_modules', '@aalis', 'core');
  mkdirSync(pkgDir, { recursive: true });
  copyFileSync(join(CORE_DIR, 'package.json'), join(pkgDir, 'package.json'));
  return { root, pkgDir };
}

describe('core package.json 发布面', () => {
  it('exports 只有包根与 package.json 两项，包根条件依次为 types、default', () => {
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './package.json': './package.json',
    });
    expect(Object.keys(manifest.exports ?? {})).toEqual(['.', './package.json']);
    // types 须排在 default 前：条件按书写顺序匹配，default 在前时 TypeScript 永远走不到 types
    expect(Object.keys(manifest.exports?.['.'] as object)).toEqual(['types', 'default']);
  });

  it('保留 main / types 且与 exports 指向同一文件；files 为 dist 与 src', () => {
    expect(manifest.main).toBe('dist/index.js');
    expect(manifest.types).toBe('dist/index.d.ts');
    expect(manifest.files).toEqual(['dist', 'src']);
  });

  it('Node 实测：包根可导入、package.json 可读，dist / src 深路径报 ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
    const { root, pkgDir } = installCore();
    mkdirSync(join(pkgDir, 'dist'));
    mkdirSync(join(pkgDir, 'src'));
    writeFileSync(join(pkgDir, 'dist', 'index.js'), "export const marker = 'root';\n");
    writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(
      join(root, 'probe.mjs'),
      `import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const codeOf = async load => { try { await load(); return 'ok'; } catch (e) { return e.code; } };
const out = {
  root: (await import('@aalis/core')).marker,
  version: require('@aalis/core/package.json').version,
  deepImport: await codeOf(() => import('@aalis/core/dist/index.js')),
  deepRequire: await codeOf(() => require.resolve('@aalis/core/dist/index.js')),
  srcImport: await codeOf(() => import('@aalis/core/src/index.ts')),
};
process.stdout.write(JSON.stringify(out));
`,
    );
    const res = spawnSync(process.execPath, ['probe.mjs'], { cwd: root, encoding: 'utf-8' });
    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout)).toEqual({
      root: 'root',
      version: manifest.version,
      deepImport: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      deepRequire: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      srcImport: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  });
});

/**
 * 从包根导出出发，沿声明文件里的类型引用走遍公开签名，返回走到却不能从包根命名的类型，
 * 以及走到过的全部名字（防空转）。模块内未导出的类型别名不算：声明产出会把它就地展开。
 */
function walkPublicTypes(distDir: string): { unnamed: string[]; reached: Set<string> } {
  const entry = join(distDir, 'index.d.ts');
  const program = ts.createProgram([entry], { noEmit: true, types: [] });
  const checker = program.getTypeChecker();
  const resolve = (s: ts.Symbol) => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
  const exportsOf = (file: ts.SourceFile) => {
    const moduleSymbol = checker.getSymbolAtLocation(file);
    return new Set(moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map(resolve) : []);
  };
  const entryFile = program.getSourceFile(entry);
  if (!entryFile) throw new Error(`没有产出 ${entry}`);
  const root = exportsOf(entryFile);
  const unnamed = new Set<string>();
  const reached = new Set<string>();
  const seen = new Set<ts.Symbol>();
  const queue = [...root];
  const referenceOf = (node: ts.Node): ts.EntityName | ts.Expression | undefined => {
    if (ts.isTypeReferenceNode(node)) return node.typeName;
    if (ts.isExpressionWithTypeArguments(node)) return node.expression;
    if (ts.isTypeQueryNode(node)) return node.exprName;
    if (ts.isImportTypeNode(node)) return node.qualifier;
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    const ref = referenceOf(node);
    const raw = ref && checker.getSymbolAtLocation(ts.isQualifiedName(ref) ? ref.right : ref);
    const target = raw && resolve(raw);
    const decl = target?.declarations?.[0];
    if (
      target &&
      decl?.getSourceFile().fileName.startsWith(distDir) &&
      !(target.flags & ts.SymbolFlags.TypeParameter)
    ) {
      reached.add(target.name);
      const localAlias = target.flags & ts.SymbolFlags.TypeAlias && !exportsOf(decl.getSourceFile()).has(target);
      if (!root.has(target) && !localAlias) {
        unnamed.add(`${target.name}（${decl.getSourceFile().fileName.slice(distDir.length + 1)}）`);
      }
      queue.push(target);
    }
    ts.forEachChild(node, visit);
  };
  for (let sym = queue.pop(); sym; sym = queue.pop()) {
    if (seen.has(sym)) continue;
    seen.add(sym);
    for (const d of sym.declarations ?? []) if (d.getSourceFile().fileName.startsWith(distDir)) visit(d);
  }
  return { unnamed: [...unnamed].sort(), reached };
}

describe('exports 下包根类型面可命名', () => {
  let root = '';
  let distDir = '';

  beforeAll(() => {
    const installed = installCore();
    root = installed.root;
    distDir = join(installed.pkgDir, 'dist');
    const res = spawnSync(
      TSC,
      [
        '-p',
        join(CORE_DIR, 'tsconfig.json'),
        '--emitDeclarationOnly',
        '--declarationMap',
        'false',
        '--outDir',
        distDir,
      ],
      { encoding: 'utf-8' },
    );
    if (res.status !== 0) throw new Error(`core 声明产出失败：${res.stdout}${res.stderr}`);
  }, 60_000);

  it('公开签名引用的具名类型都从包根导出', () => {
    const { unnamed, reached } = walkPublicTypes(distDir);
    // 三处各代表一种位置：函数返回值、接口方法的回调返回值、类方法参数
    expect([...reached]).toEqual(expect.arrayContaining(['OptionalUse', 'FollowCleanup', 'PluginRegistration']));
    expect(unnamed, '这些类型出现在公开签名里却只能经 dist 深路径命名，须从 packages/core/src/index.ts 导出').toEqual(
      [],
    );
  });

  it('按脚手架的 tsconfig 编一个消费方：推断类型都能写成包根引用', () => {
    const consumer = join(root, 'consumer');
    mkdirSync(join(consumer, 'src'), { recursive: true });
    // create-aalis-plugin 生成的 tsconfig 里与本项相关的几项：bundler 解析、产出声明
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          declaration: true,
          noEmit: true,
        },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(consumer, 'src', 'index.ts'),
      `import { type App, definePlugin, defineService, optional, type ServiceRef } from '@aalis/core';
const dep = defineService<{ ping(): void }>('probe-dep');
declare const ref: ServiceRef<number>;
declare const app: App;
export default definePlugin({ name: 'probe', uses: { dep: optional(dep) }, apply() {} });
export const follow = ref.follow;
export const pluginAll = app.pluginAll;
`,
    );
    const res = spawnSync(TSC, ['-p', consumer, '--pretty', 'false'], { encoding: 'utf-8' });
    const output = `${res.stdout}${res.stderr}`;
    expect(output.split('\n').filter(l => l.includes('error TS'))).toEqual([]);
    expect(res.status, output).toBe(0);
  }, 30_000);
});
