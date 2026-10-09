import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 会话的创建来源只有两个写入方：会话服务在 owner 连接调用 session/create 时写这条连接所在审批面的登记名，终端在发出入站
// 之前给它配置的会话建档时写 cli。会话管理给它们的建档专用参数（createSession 的第二个参数、ensureSession 的第三个参数）
// 只在这两个包里传；别的包传了，创建来源（由此定的房间类别）就成了谁都能声称的东西。
//
// 扫描面是 packages/*/src，测试不在其列。按语法树找调用：`x.createSession(a, b)`、`ensureSession(a, b, c)` 都算。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 准许传专用参数的包 */
const ALLOWED = new Set(['plugin-session-server', 'plugin-cli']);

/** 方法名 → 专用参数是第几个参数（从 1 数） */
const CREATION_ARG: Record<string, number> = { createSession: 2, ensureSession: 3 };

/** 一个源文件里传了专用参数的调用（`行:列 方法名`） */
function creationCalls(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      const position = name === undefined ? undefined : CREATION_ARG[name];
      if (position !== undefined && node.arguments.length >= position) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${line + 1}:${character + 1} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('创建来源的专用参数', () => {
  it('只有会话服务与终端在建档时传', () => {
    const found = new Map<string, string[]>();
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      if (!existsSync(src)) continue;
      for (const file of sourceFiles(src)) {
        const hits = creationCalls(file, readFileSync(file, 'utf8'));
        if (hits.length > 0) found.set(relative(ROOT, file), hits);
      }
    }
    const packageOf = (file: string) => file.split('/')[1] ?? '';
    const outside = [...found].filter(([file]) => !ALLOWED.has(packageOf(file)));
    expect(outside.map(([file, hits]) => `${file}: ${hits.join('、')}`)).toEqual([]);
    // 守卫没扫空：两个准许的包确实在传
    expect(new Set([...found.keys()].map(packageOf))).toEqual(ALLOWED);
  });

  it('按语法树认调用：属性访问、直接调用都算，参数不够的不算', () => {
    const text = [
      'await sm.createSession({ name }, { createdFrom: name });',
      'await createSession({ name });',
      'await this.caps.sm.ensureSession(id, {}, creation);',
      'await sm.ensureSession(id, {});',
    ].join('\n');
    expect(creationCalls('probe.ts', text)).toEqual(['1:7 createSession', '3:7 ensureSession']);
  });
});
