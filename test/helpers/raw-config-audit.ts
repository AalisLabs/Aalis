import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export interface RawConfigAudit {
  files: number;
  rawSites: number;
  parseCalls: number;
  violations: string[];
}

/** 只做绑定与类型解析，不检查诊断、不输出构建产物。virtual 供守卫的正反例使用。 */
export function auditRawConfig(
  root: string,
  files: string[],
  virtual: ReadonlyMap<string, string> = new Map(),
): RawConfigAudit {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    baseUrl: root,
    paths: { '@aalis/*': ['packages/*/src/index.ts'] },
    skipLibCheck: true,
    noEmit: true,
    strict: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = file => virtual.get(resolve(file)) ?? read(file);
  host.fileExists = file => virtual.has(resolve(file)) || exists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = virtual.get(resolve(file));
    return source === undefined
      ? getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, source, languageVersion, true);
  };
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();
  const result: RawConfigAudit = { files: 0, rawSites: 0, parseCalls: 0, violations: [] };

  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    result.files++;
    const parseSymbols = new Set<ts.Symbol>();
    const parseNamespaces = new Set<ts.Symbol>();
    const coreConfigSymbols = new Set<ts.Symbol>();
    const definePluginSymbols = new Set<ts.Symbol>();
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const moduleName = stmt.moduleSpecifier.getText(sf).slice(1, -1);
      if (moduleName !== '@aalis/schema-config' && moduleName !== '@aalis/core') continue;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          if (moduleName === '@aalis/core' && (item.propertyName ?? item.name).text === 'config') {
            const symbol = checker.getSymbolAtLocation(item.name);
            if (symbol) coreConfigSymbols.add(checker.getAliasedSymbol(symbol));
          }
          if (moduleName === '@aalis/core' && (item.propertyName ?? item.name).text === 'definePlugin') {
            const symbol = checker.getSymbolAtLocation(item.name);
            if (symbol) definePluginSymbols.add(symbol);
          }
          if (moduleName !== '@aalis/schema-config') continue;
          if ((item.propertyName ?? item.name).text !== 'parseConfig') continue;
          const symbol = checker.getSymbolAtLocation(item.name);
          if (symbol) parseSymbols.add(symbol);
        }
      } else if (moduleName === '@aalis/schema-config' && bindings && ts.isNamespaceImport(bindings)) {
        const symbol = checker.getSymbolAtLocation(bindings.name);
        if (symbol) parseNamespaces.add(symbol);
      }
    }
    const isParse = (call: ts.CallExpression): boolean => {
      const callee = call.expression;
      return (
        (ts.isIdentifier(callee) && parseSymbols.has(checker.getSymbolAtLocation(callee)!)) ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'parseConfig' &&
          ts.isIdentifier(callee.expression) &&
          parseNamespaces.has(checker.getSymbolAtLocation(callee.expression)!))
      );
    };
    const boundCapsAliases = new Set<ts.Symbol>();
    const boundCapsParameters = new Set<ts.ParameterDeclaration>();
    const isBoundCaps = (node: ts.Node): boolean =>
      checker.typeToString(checker.getTypeAtLocation(node)).startsWith('BoundOf<') ||
      (ts.isParameter(node) && boundCapsParameters.has(node)) ||
      (ts.isIdentifier(node) && boundCapsAliases.has(checker.getSymbolAtLocation(node)!));
    const isRawType = (node: ts.Node): boolean =>
      checker.typeToString(checker.getTypeAtLocation(node)) === 'Readonly<Record<string, unknown>>';
    const isCoreSymbol = (symbol: ts.Symbol | undefined, seen = new Set<ts.Symbol>()): boolean => {
      if (!symbol || seen.has(symbol)) return false;
      if (symbol.flags & ts.SymbolFlags.Alias) return coreConfigSymbols.has(checker.getAliasedSymbol(symbol));
      seen.add(symbol);
      return (symbol.declarations ?? []).some(
        decl =>
          ts.isVariableDeclaration(decl) &&
          !!decl.initializer &&
          isCoreSymbol(checker.getSymbolAtLocation(decl.initializer), seen),
      );
    };
    const isRawMember = (receiver: ts.Node, name: string, value: ts.Node): boolean => {
      if (!isBoundCaps(receiver)) return false;
      const member = checker.getPropertyOfType(checker.getTypeAtLocation(receiver), name);
      const fromCore = member?.declarations?.some(decl => {
        if (ts.isPropertyAssignment(decl)) return isCoreSymbol(checker.getSymbolAtLocation(decl.initializer));
        if (ts.isShorthandPropertyAssignment(decl))
          return isCoreSymbol(checker.getShorthandAssignmentValueSymbol(decl));
        return false;
      });
      // 显式结构签名 helper 的参数来源已由上游 BoundOf 实参确认。
      return (
        !!fromCore ||
        (ts.isIdentifier(receiver) && boundCapsAliases.has(checker.getSymbolAtLocation(receiver)!) && isRawType(value))
      );
    };
    // 本文件 helper 即使显式写结构类型，收到 BoundOf 实参后仍要按 Core 绑定检查。
    const markCapsParameter = (param: ts.ParameterDeclaration): boolean => {
      if (boundCapsParameters.has(param)) return false;
      boundCapsParameters.add(param);
      if (ts.isIdentifier(param.name)) {
        const symbol = checker.getSymbolAtLocation(param.name);
        if (symbol) boundCapsAliases.add(symbol);
      }
      return true;
    };
    let added: boolean;
    do {
      added = false;
      const collect = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          // 显式 Caps 接口也可能作为 definePlugin.apply 的形参（例如 MCP client）。
          if (definePluginSymbols.has(checker.getSymbolAtLocation(node.expression)!)) {
            const plugin = node.arguments[0];
            if (plugin && ts.isObjectLiteralExpression(plugin)) {
              const uses = plugin.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'uses') as
                | ts.PropertyAssignment
                | undefined;
              const apply = plugin.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'apply') as
                | ts.PropertyAssignment
                | undefined;
              if (uses && apply && ts.isObjectLiteralExpression(uses.initializer)) {
                const hasCoreConfig = uses.initializer.properties.some(
                  p =>
                    (ts.isPropertyAssignment(p) && isCoreSymbol(checker.getSymbolAtLocation(p.initializer))) ||
                    (ts.isShorthandPropertyAssignment(p) && isCoreSymbol(checker.getShorthandAssignmentValueSymbol(p))),
                );
                if (hasCoreConfig) {
                  const applySymbol = checker.getSymbolAtLocation(apply.initializer);
                  for (const decl of applySymbol?.declarations ?? []) {
                    const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
                    if (fn && ts.isFunctionLike(fn) && fn.parameters[0] && markCapsParameter(fn.parameters[0]))
                      added = true;
                  }
                }
              }
            }
          }
          const callee = checker.getSymbolAtLocation(node.expression);
          for (const decl of callee?.declarations ?? []) {
            const fn = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
            if (!fn || !ts.isFunctionLike(fn)) continue;
            node.arguments.forEach((arg, i) => {
              const param = fn.parameters[i];
              if (param && isBoundCaps(arg) && markCapsParameter(param)) added = true;
            });
          }
        }
        ts.forEachChild(node, collect);
      };
      collect(sf);
    } while (added);
    const isRaw = (node: ts.Expression, seen = new Set<ts.Symbol>()): boolean => {
      if (ts.isPropertyAccessExpression(node)) return isRawMember(node.expression, node.name.text, node);
      if (ts.isElementAccessExpression(node)) {
        return (
          ts.isStringLiteralLike(node.argumentExpression) &&
          isRawMember(node.expression, node.argumentExpression.text, node)
        );
      }
      if (!ts.isIdentifier(node)) return false;
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return false;
      seen.add(symbol);
      return (symbol.declarations ?? []).some(decl => {
        if (ts.isVariableDeclaration(decl) && decl.initializer) return isRaw(decl.initializer, seen);
        if (!ts.isBindingElement(decl)) return false;
        const owner = decl.parent.parent;
        const name = (decl.propertyName ?? decl.name).getText(sf);
        if (ts.isVariableDeclaration(owner))
          return !!owner.initializer && isRawMember(owner.initializer, name, decl.name);
        if (ts.isParameter(owner)) return isRawMember(owner, name, decl.name);
        return false;
      });
    };
    const allowed = (node: ts.Expression): boolean => {
      const parent = node.parent;
      return ts.isCallExpression(parent) && isParse(parent) && parent.arguments[1] === node;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isParse(node)) result.parseCalls++;
      // 标识符仅统计表达式位置；声明、属性名和调用名不算读取。
      const candidate =
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        (ts.isIdentifier(node) &&
          ts.isExpression(node) &&
          !(ts.isBindingElement(node.parent) && (node.parent.name === node || node.parent.propertyName === node)) &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node));
      if (candidate && isRaw(node as ts.Expression)) {
        result.rawSites++;
        if (!allowed(node as ts.Expression)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          result.violations.push(`${relative(root, sf.fileName)}:${line} 原始 config 只能直接传给 parseConfig 第二参`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return result;
}

/** 只纳入第一方插件的源码，包目录与 src 缺席时不会悄悄当作零通过。 */
export function readPluginSources(root: string): string[] {
  const packages = resolve(root, 'packages');
  const files: string[] = [];
  for (const name of readdirSync(packages) ?? []) {
    if (!name.startsWith('plugin-')) continue;
    const manifest = resolve(packages, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const meta = JSON.parse(readFileSync(manifest, 'utf8')) as { keywords?: string[] };
    if (!meta.keywords?.includes('aalis-plugin')) continue;
    const src = resolve(packages, name, 'src');
    if (!existsSync(src)) continue;
    files.push(
      ...ts.sys.readDirectory(src, ['.ts', '.tsx'], undefined, ['**/*']).filter(file => !file.endsWith('.d.ts')),
    );
  }
  return files;
}
