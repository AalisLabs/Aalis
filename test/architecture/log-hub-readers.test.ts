import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 日志中枢只给 core 与宿主
//
// 写日志是 core 发给每个插件的 logger；读整个日志流是宿主的管理能力，插件在 uses 里声明 host-logs
// （@aalis/api-host-logs）才拿得到，订阅归本次激活。除了 core（定义它）与 runtime（宿主：控制台、文件日志与
// host-logs 的提供都接在中枢上），packages 下的源码不引用 LogHub：导入、命名空间访问与方括号都算。
//
// 扫描面是 packages/*/src，测试不在其列。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXEMPT = new Set(['core', 'runtime']);

/** 一个源文件里引用 LogHub 的位置（`行:列`） */
function findLogHub(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    const named = ts.isIdentifier(node) && node.text === 'LogHub';
    const indexed =
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'LogHub';
    if (named || indexed) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${line + 1}:${character + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter(file => /\.(ts|tsx|mts)$/.test(file) && !file.endsWith('.d.ts') && !/\.test\.tsx?$/.test(file))
    .map(file => join(dir, file));
}

describe('日志中枢守卫', () => {
  it.each([
    ['具名导入', "import { LogHub } from '@aalis/core';"],
    ['改名导入', "import { LogHub as Hub } from '@aalis/core';"],
    ['命名空间访问', "import * as core from '@aalis/core';\ncore.LogHub.default.onEntry(() => {});"],
    ['方括号', "import * as core from '@aalis/core';\ncore['LogHub'].default;"],
  ])('认出%s', (_label, code) => {
    expect(findLogHub('fixture.ts', code).length).toBeGreaterThan(0);
  });

  it('注释与普通字符串不算', () => {
    expect(findLogHub('fixture.ts', "// LogHub\nconst s = 'LogHub';")).toEqual([]);
  });

  it('core 与 runtime 之外的包不引用 LogHub', () => {
    const packages = join(ROOT, 'packages');
    const files = readdirSync(packages, { withFileTypes: true })
      .filter(d => d.isDirectory() && !EXEMPT.has(d.name))
      .flatMap(d => sourceFiles(join(packages, d.name, 'src')));
    const offenders = files.flatMap(file =>
      findLogHub(file, readFileSync(file, 'utf-8')).map(hit => `${relative(ROOT, file)}:${hit}`),
    );
    expect(files.length).toBeGreaterThan(300);
    expect(offenders).toEqual([]);
  });
});
