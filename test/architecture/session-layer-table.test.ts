import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SESSION_LAYERS } from '../../packages/api-session-manager/src/index.js';

// ════════════════════════════════════════════════════════════
// 会话设置的层表只在 api-session-manager 一处：会话服务经 session/config/layers 把它交给客户端，来源文字、先后说明与
// 选层的称呼都按它写。会话服务与 WebUI 客户端不另存一份：源码里不出现层的称呼，也不出现层名的列表（两个以上层名的
// 数组、三个以上层名作键的对象）。引用单个层名（如判断「这一层是不是场所」）不算列表。按语法树查，测试不在其列。
// ════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCANNED = ['plugin-session-server', 'plugin-webui-client'];
const NAMES = new Set<string>(SESSION_LAYERS.map(layer => layer.name));
const LABELS = new Set<string>(SESSION_LAYERS.map(layer => layer.label));

/** 一个源文件里另存的层表：`行 写法` */
function layerTables(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const hit = (node: ts.Node, what: string) =>
    hits.push(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${what}`);
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && LABELS.has(node.text)) {
      hit(node, `层的称呼「${node.text}」`);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const names = new Set(node.elements.flatMap(e => (ts.isStringLiteral(e) && NAMES.has(e.text) ? [e.text] : [])));
      if (names.size >= 2) hit(node, `层名的数组 ${[...names].join('、')}`);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(
        node.properties.flatMap(p =>
          p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && NAMES.has(p.name.text)
            ? [p.name.text]
            : [],
        ),
      );
      if (names.size >= 3) hit(node, `以层名作键的对象 ${[...names].join('、')}`);
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

describe('会话设置的层表只在 api-session-manager 一处', () => {
  it('判据本身：称呼、两个以上层名的数组、三个以上层名作键的对象算；单个层名与只有两个层名键的对象不算', () => {
    const text = [
      "const SOURCES = { defaults: '全局默认', platform: '平台档', session: '本会话' };",
      "const ORDER = ['session', 'place', 'defaults'];",
      "if (layer.scope !== 'place') return;",
      "const layer = { scope: 'type', platform: 'onebot', type: 'group' };",
      "const label = '默认（模型）';",
    ].join('\n');
    expect(layerTables('probe.tsx', text)).toEqual([
      '1 以层名作键的对象 defaults、platform、session',
      '1 层的称呼「全局默认」',
      '1 层的称呼「平台档」',
      '1 层的称呼「本会话」',
      '2 层名的数组 session、place、defaults',
    ]);
  });

  it('会话服务与 WebUI 客户端里没有另存的层表', () => {
    const found: string[] = [];
    let scanned = 0;
    for (const pkg of SCANNED) {
      for (const file of sourceFiles(join(ROOT, 'packages', pkg, 'src'))) {
        scanned++;
        for (const hit of layerTables(file, readFileSync(file, 'utf8'))) found.push(`${relative(ROOT, file)}:${hit}`);
      }
    }
    expect(scanned, '扫描范围不能是空的').toBeGreaterThan(50);
    expect(found).toEqual([]);
  });
});
