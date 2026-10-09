import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 会话一律按会话记录里的字段判（出生平台、聊天窗口、所属工作区），不按 id 的写法：别的包里不按 `:` 拆会话 id 取平台、
// 类型或目标。会话 id 的写法归适配器自己，只有它们为路由解析自己写的 id：两个 onebot 包，与 api-platform 按 id
// 找适配器的路由兜底。
//
// 按语法树查 packages/*/src：接收者的写法里带 session（如 `sessionId`、`msg.sessionId`）的 `split`、`indexOf`、
// `lastIndexOf` 以 `:` 为参数的调用。测试不在其列。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ALLOWED = new Set(['plugin-adapter-onebot', 'plugin-tool-onebot', 'api-platform']);
const SPLITTERS = new Set(['split', 'indexOf', 'lastIndexOf']);

/** 一个源文件里按 `:` 拆会话 id 的调用：`行 写法` */
function sessionIdSplits(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { name, expression: receiver } = node.expression;
      const [arg] = node.arguments;
      if (
        SPLITTERS.has(name.text) &&
        arg &&
        ts.isStringLiteral(arg) &&
        arg.text === ':' &&
        /session/i.test(receiver.getText(sf))
      ) {
        hits.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${node.getText(sf)}`);
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

describe('不按 : 拆会话 id', () => {
  it('判据本身：接收者带 session 的按 : 拆算，别的分隔符与别的字符串不算', () => {
    const text = [
      "const [platform] = sessionId.split(':');",
      "const at = msg.sessionId.indexOf(':');",
      "const parts = scope.split(':');",
      "const segments = sessionId.split('::');",
    ].join('\n');
    expect(sessionIdSplits('probe.ts', text)).toEqual(["1 sessionId.split(':')", "2 msg.sessionId.indexOf(':')"]);
  });

  it('只有适配器与路由兜底拆自己写的会话 id', () => {
    const found = new Map<string, string[]>();
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      const src = join(ROOT, 'packages', pkg, 'src');
      if (!existsSync(src)) continue;
      for (const file of sourceFiles(src)) {
        const hits = sessionIdSplits(file, readFileSync(file, 'utf8'));
        if (hits.length > 0) found.set(relative(ROOT, file), hits);
      }
    }
    const packageOf = (file: string) => file.split('/')[1] ?? '';
    const outside = [...found].filter(([file]) => !ALLOWED.has(packageOf(file)));
    expect(outside.map(([file, hits]) => `${file}: ${hits.join('、')}`)).toEqual([]);
    // 守卫没扫空：准许的包确实在拆
    expect(new Set([...found.keys()].map(packageOf))).toEqual(ALLOWED);
  });
});
