import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { brief } from '../../packages/plugin-commands/src/help.js';

// ════════════════════════════════════════════════════════════
// 指令描述的第一句就是摘要：/help 概览与子指令列表只显示第一句（到第一个句号、分号、问号、叹号或换行为止），
// 不另设摘要字段。第一方登记的每条指令（连同它们的分组）第一句都写得完整：不空、括号成对（句号没写在括号里）、
// 不被截断，同级之间不重样。
// 描述不是字面量的登记守卫看不见，也算失败。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');

/** 成对的括号：摘要里各自的个数相等 */
const BRACKETS = ['（）', '()', '【】', '「」', '[]', '<>'];

/** 名字与描述不是字面量、却不是登记的 `.command(…)`：文件 → 理由。每个文件都还有这样的调用 */
const FORWARDERS = new Map([['packages/api-commands/src/index.ts', '绑定门面把插件的登记原样转给当前的指令服务']]);

interface Registration {
  file: string;
  line: number;
  /** 点路径名；DSL 不是字面量时为 undefined */
  name: string | undefined;
  /** 描述；不是字面量时为 undefined */
  description: string | undefined;
}

const literalText = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/** packages 下各包源码里的 `.command(DSL, 描述, …)` */
function registrations(): Registration[] {
  const found: Registration[] = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const files = readdirSync(join(ROOT, 'packages', pkg, 'src'), { recursive: true, encoding: 'utf-8' });
    for (const rel of files.filter(f => /\.tsx?$/.test(f))) {
      const file = join('packages', pkg, 'src', rel);
      const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf-8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'command' &&
          node.arguments.length > 0
        ) {
          const dsl = literalText(node.arguments[0]);
          found.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            name: dsl?.trim().split(/\s+/)[0],
            description: literalText(node.arguments[1]),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return found;
}

describe('第一方指令的描述：第一句就是摘要', () => {
  const found = registrations();
  /** 名字 → 描述；分组的点路径一并列进来，没登记的分组描述为空 */
  const described = new Map<string, string>();
  for (const r of found) {
    if (r.name === undefined || r.description === undefined) continue;
    const parts = r.name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const group = parts.slice(0, i).join('.');
      if (!described.has(group)) described.set(group, '');
    }
    described.set(r.name, r.description);
  }

  it('收集到的登记不空，名字与描述都是字面量', () => {
    expect(found.length).toBeGreaterThan(40);
    const unseen = found.filter(r => r.name === undefined || r.description === undefined);
    expect(unseen.filter(r => !FORWARDERS.has(r.file))).toEqual([]);
    expect(new Set(unseen.map(r => r.file))).toEqual(new Set(FORWARDERS.keys()));
  });

  it('每条指令与分组的第一句都不空、括号成对、不被截断', () => {
    const count = (text: string, ch: string) => [...text].filter(c => c === ch).length;
    const bad = [...described]
      .filter(([, description]) => {
        const summary = brief(description);
        return (
          summary === '' ||
          summary.endsWith('…') ||
          BRACKETS.some(([open, close]) => count(summary, open) !== count(summary, close))
        );
      })
      .map(([name, description]) => `${name}「${description}」`);
    expect(bad).toEqual([]);
  });

  it('同级之间摘要不重样', () => {
    const bySibling = new Map<string, Map<string, string>>();
    const clashes: string[] = [];
    for (const [name, description] of described) {
      const parent = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '';
      const siblings = bySibling.get(parent) ?? new Map<string, string>();
      bySibling.set(parent, siblings);
      const summary = brief(description);
      const other = siblings.get(summary);
      if (other) clashes.push(`${other} 与 ${name}：${summary}`);
      siblings.set(summary, name);
    }
    expect(clashes).toEqual([]);
  });
});
