import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compilerOptions, fixtureProgram, holdsTextRef, ROOT, sourceFiles } from '../helpers/package-program.js';

// ════════════════════════════════════════════════════════════
// 文字对象不进字符串拼接
//
// 文字对象（@aalis/schema-i18n 的 TextRef）是给出口按读者语言渲染的数据，拼进字符串只会得到
// "[object Object]"。TypeScript 不拦模板字符串、加号、join、toString 与 String() 里的对象，所以这里用类型检查器扫：
// 模板字符串的插值、`+` 与 `+=` 的操作数、String() 的实参、join 与 toString 的调用方，类型会转出 [object Object] 即违例
// ——类型按结构认文字对象（有 i18n、key、source 三个属性，派生与 Readonly 的也认），数组与元组看元素，类型参数看约束。
// 要拼进句子就把它作为另一条文字对象的参数，或者在出口渲染之后再拼；给日志与模型的先 toSource。
//
// 扫描面是 packages/*/src 的全部 .ts / .tsx，编译选项（含路径映射、DOM 与 jsx）取 tsconfig.test.json，
// 与测试看到的是同一份代码。全仓扫描只建一次程序，类型只对上面几种写法现取。
// ════════════════════════════════════════════════════════════

const TEXT_REF_FILE = join(ROOT, 'packages/schema-i18n/src/text-ref.ts');

/** 程序里所有拼接 TextRef 的位置（`文件:行`，文件相对仓根），只看 `files` 里的源文件 */
function textConcatenations(program: ts.Program, files: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const holds = (node: ts.Expression) => holdsTextRef(checker, checker.getTypeAtLocation(node));

  const hits: string[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`程序里没有 ${file}`);
    const report = (node: ts.Node) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      hits.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${line}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
        for (const span of node.templateSpans) if (holds(span.expression)) report(span.expression);
      } else if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
        (holds(node.left) || holds(node.right))
      ) {
        report(node);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const method =
          ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'join' || callee.name.text === 'toString') &&
          holds(callee.expression);
        const stringified = ts.isIdentifier(callee) && callee.text === 'String' && node.arguments.some(holds);
        if (method || stringified) report(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

// 编译宿主收到的文件名一律用 / 分隔
const FIXTURE = join(ROOT, 'test/architecture/text-concat.fixture.ts').replace(/\\/g, '/');
const FIXTURE_SOURCE = `import { type TextRef, textLines, toSource } from '@aalis/schema-i18n';
declare const label: TextRef;
declare const maybe: string | TextRef;
declare const parts: readonly (string | TextRef)[];
declare const ro: Readonly<TextRef>;
interface Labelled extends TextRef { readonly extra: number }
declare const ext: Labelled;
declare const grid: TextRef[][];
declare const plain: string[];
declare const loose: any;
declare const opaque: unknown;
declare const either: string | number;
type Json = string | Json[];
declare const json: Json;
export const a = \`名称：\${label}\`;
export const b = '名称：' + maybe;
export const c = parts.join('\\n');
export const d = String(label);
let e = '';
e += label;
export const f = <T extends TextRef>(value: T) => \`\${value}\`;
export const g = [\`清单：\${parts}\`, '清单：' + parts, String(parts), \`\${[label]}\`];
export const h = [\`\${ro}\`, \`\${ext}\`, grid.join(';'), label.toString(), parts.toString()];
export const ok = [\`\${label.source}\`, '名称：' + toSource(maybe), plain.join('\\n'), String(1), textLines(parts), e];
export const ok2 = [\`\${loose}\${opaque}\${either}\${json}\`, String(plain), plain.toString(), <T>(v: T) => \`\${v}\`];
`;

describe('文字对象不进字符串拼接', () => {
  it('认出模板插值、加号与 +=、String()、join 与 toString，数组看元素、类型参数看约束；合法写法不报', () => {
    const program = fixtureProgram(FIXTURE, FIXTURE_SOURCE);
    expect(
      program.getSourceFile(TEXT_REF_FILE),
      'schema-i18n 的源码应经路径映射进程序，否则 TextRef 认不出来',
    ).toBeDefined();
    const at = (line: number) => `test/architecture/text-concat.fixture.ts:${line}`;
    expect(textConcatenations(program, [FIXTURE])).toEqual([
      at(15),
      at(16),
      at(17),
      at(18),
      at(20),
      at(21),
      ...[22, 22, 22, 22].map(at),
      ...[23, 23, 23, 23, 23].map(at),
    ]);
  });

  it('packages 源码里没有拼接文字对象的写法', () => {
    const files = sourceFiles();
    const hits = textConcatenations(ts.createProgram(files, compilerOptions()), files);
    expect(files.length, '扫描面应覆盖全部包的源码').toBeGreaterThan(400);
    expect(files).toContain(TEXT_REF_FILE);
    expect(hits, `${hits.length} 处拼接了文字对象：\n${hits.join('\n')}`).toEqual([]);
  }, 120_000);
});
