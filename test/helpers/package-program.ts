import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// 三道守卫（文字对象的拼接、写死的中文，语言来源）共用：packages 源码的扫描面与编译选项、内存夹具的小程序；按结构认文字对象的
// 判法（holdsTextRef）只有两道文字守卫在用；扫描面另有经 owner 审批的注入方登记在用

export const ROOT = join(import.meta.dirname, '../..');
const PACKAGES = join(ROOT, 'packages');

/** 编译选项（含路径映射、DOM 与 jsx）取 tsconfig.test.json，与测试看到的是同一份代码 */
export function compilerOptions(): ts.CompilerOptions {
  const file = join(ROOT, 'tsconfig.test.json');
  const { config } = ts.readConfigFile(file, ts.sys.readFile);
  return { ...ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, file).options, noEmit: true };
}

/** 扫描面：packages 下每个包 src 里的全部 .ts / .tsx（不含声明文件） */
export function sourceFiles(): string[] {
  return readdirSync(PACKAGES).flatMap(dir => {
    const src = join(PACKAGES, dir, 'src');
    if (!existsSync(src)) return [];
    return (readdirSync(src, { recursive: true }) as string[])
      .filter(name => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
      .map(name => join(src, name));
  });
}

/**
 * 只含一个夹具的小程序：夹具（绝对路径与源码）不落盘，经编译宿主从内存交给编译器，@aalis 包照路径映射取源码。
 * 编译宿主收到的文件名一律用 / 分隔，夹具的路径也要这样写
 */
export function fixtureProgram(file: string, source: string): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists } = host;
  host.getSourceFile = (name, language, ...rest) =>
    name === file ? ts.createSourceFile(name, source, language) : getSourceFile(name, language, ...rest);
  host.fileExists = name => name === file || fileExists(name);
  return ts.createProgram([file], options, host);
}

/**
 * 类型里有没有文字对象：按结构认（有 i18n、key、source 三个属性，派生与 Readonly 的也认），联合与交叉看成员，
 * 数组与元组看元素，类型参数看约束
 */
export function holdsTextRef(checker: ts.TypeChecker, type: ts.Type): boolean {
  // seen 防递归类型（如 type Json = string | Json[]）
  const seen = new Set<ts.Type>();
  const holds = (type: ts.Type): boolean => {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.isUnionOrIntersection()) return type.types.some(holds);
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && holds(constraint);
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      return checker.getTypeArguments(type as ts.TypeReference).some(holds);
    }
    return ['i18n', 'key', 'source'].every(name => checker.getPropertyOfType(type, name) !== undefined);
  };
  return holds(type);
}
