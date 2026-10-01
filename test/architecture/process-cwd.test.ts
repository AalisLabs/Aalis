import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 进程的 cwd 不带语义
//
// 家目录与安装集由宿主在启动时解析一次，经 host-paths 交给插件（见 @aalis/api-host-paths）。
// 除了 runtime（命令行与环境变量里的相对路径按启动时的 cwd 解析一次）和两个脚手架（在用户当前目录生成项目），
// 任何包都不读 cwd：`process.cwd()`、从 node:process 导入的 cwd、命名空间导入后的 `.cwd()` 都算。
//
// 扫描面是 packages/*/src 与根 src，测试不在其列。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 允许读 cwd 的包：目录名 → 理由 */
const EXEMPT = new Map([
  ['runtime', '宿主入口：命令行与环境变量里的相对路径按启动时的 cwd 解析一次，respawn 时新进程继承同一个 cwd'],
  ['create-aalis', '脚手架：在用户当前目录生成项目'],
  ['create-aalis-plugin', '脚手架：在用户当前目录生成插件'],
]);

/** 一个源文件里读 cwd 的位置（`行:列`）。 */
function findCwdReads(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const processModules = new Set(['node:process', 'process']);
  const cwdBindings = new Set<string>();
  const processNamespaces = new Set<string>(['process']);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!processModules.has(stmt.moduleSpecifier.text)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) processNamespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) processNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if ((el.propertyName ?? el.name).text === 'cwd') cwdBindings.add(el.name.text);
      }
    }
  }
  const hits: string[] = [];
  const at = (node: ts.Node) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    hits.push(`${line + 1}:${character + 1}`);
  };
  /** 剥掉括号、`as` / `satisfies` / 非空断言与尖括号断言：`(process as any).cwd()` 也算 */
  const unwrap = (expr: ts.Expression): ts.Expression => {
    let e = expr;
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e)
    ) {
      e = e.expression;
    }
    return e;
  };
  const isProcessRef = (raw: ts.Expression): boolean => {
    const expr = unwrap(raw);
    if (ts.isIdentifier(expr)) return processNamespaces.has(expr.text);
    if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'process')
      return ts.isIdentifier(unwrap(expr.expression));
    // require('node:process') / require('process')
    return (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'require' &&
      expr.arguments.length === 1 &&
      ts.isStringLiteral(expr.arguments[0]!) &&
      processModules.has(expr.arguments[0].text)
    );
  };
  /** `process.env.PWD` / `INIT_CWD`：shell 与 npm 记下的启动目录，同样是在读 cwd */
  const isCwdEnvRead = (node: ts.PropertyAccessExpression): boolean => {
    if (node.name.text !== 'PWD' && node.name.text !== 'INIT_CWD') return false;
    const env = unwrap(node.expression);
    return ts.isPropertyAccessExpression(env) && env.name.text === 'env' && isProcessRef(env.expression);
  };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'cwd' && isProcessRef(node.expression)) at(node);
    else if (ts.isPropertyAccessExpression(node) && isCwdEnvRead(node)) at(node);
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'cwd' &&
      isProcessRef(node.expression)
    )
      at(node);
    else if (ts.isIdentifier(node) && cwdBindings.has(node.text) && !ts.isImportSpecifier(node.parent)) at(node);
    else if (
      ts.isObjectBindingPattern(node) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer &&
      isProcessRef(node.parent.initializer) &&
      node.elements.some(el => (el.propertyName ?? el.name).getText(sf) === 'cwd')
    )
      at(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('进程 cwd 守卫', () => {
  it.each([
    ['process.cwd()', 'const x = process.cwd();'],
    ['globalThis.process.cwd()', 'const x = globalThis.process.cwd();'],
    ['方括号', "const x = process['cwd']();"],
    ['具名导入', "import { cwd } from 'node:process';\nconst x = cwd();"],
    ['改名导入', "import { cwd as here } from 'process';\nconst x = here();"],
    ['命名空间导入', "import * as proc from 'node:process';\nconst x = proc.cwd();"],
    ['默认导入', "import proc from 'node:process';\nconst x = proc.cwd();"],
    ['解构', 'const { cwd } = process;\nconst x = cwd();'],
    ['当默认参数', 'function f(dir = process.cwd()) { return dir; }'],
    ['类型断言', 'const x = (process as any).cwd();'],
    ['非空断言', 'const x = process!.cwd();'],
    ['globalThis 断言', 'const x = (globalThis as any).process.cwd();'],
    ['断言后解构', 'const { cwd } = process as NodeJS.Process;'],
    ['require', "const x = require('node:process').cwd();"],
    ['PWD', 'const x = process.env.PWD;'],
    ['INIT_CWD', 'const x = process.env.INIT_CWD;'],
  ])('认出%s', (_label, code) => {
    expect(findCwdReads('fixture.ts', code).length).toBeGreaterThan(0);
  });

  it('同名的别的东西不算', () => {
    const code = [
      'const opts = { cwd: "/x" };',
      'spawn("ls", [], { cwd: opts.cwd });',
      'function f(cwd: string) { return cwd; }',
      'const info = { cwd() { return "/x"; } };',
      'info.cwd();',
    ].join('\n');
    expect(findCwdReads('fixture.ts', code)).toEqual([]);
  });

  it('runtime 与脚手架之外的包、根 src 都不读 cwd', () => {
    const packages = join(ROOT, 'packages');
    const offenders: string[] = [];
    const scanned: string[] = [];
    const dirs = readdirSync(packages, { withFileTypes: true })
      .filter(d => d.isDirectory() && !EXEMPT.has(d.name))
      .map(d => join(packages, d.name, 'src'));
    for (const file of [...dirs, join(ROOT, 'src')].flatMap(sourceFiles)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      scanned.push(file);
      for (const hit of findCwdReads(file, readFileSync(file, 'utf-8'))) {
        offenders.push(`${relative(ROOT, file)}:${hit}`);
      }
    }
    expect(scanned.length).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });

  it('豁免名单里的包都还在：删了包就删豁免', () => {
    for (const name of EXEMPT.keys()) expect(existsSync(join(ROOT, 'packages', name, 'src'))).toBe(true);
  });
});
