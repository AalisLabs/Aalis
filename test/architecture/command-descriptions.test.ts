import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { brief } from '../../packages/plugin-commands/src/help.js';
import { catalogEntries, isTextRef, resolveText, type TextRef } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 指令描述的第一句就是摘要：/help 概览与子指令列表只显示第一句（按句子切分，分号与换行另算句末，见 plugin-commands 的
// brief），不另设摘要字段。第一方登记的每条指令（连同它们的分组）在每种语言下第一句都写得完整：不空、括号成对（句末标点
// 没写在括号里）、不被截断，同级之间不重样。
// 描述可以是字面量，也可以是本包字典的 `t('键')`（不带参数）：守卫导入那份字典，原文与各语言的译文逐个核；字面量在每种语言
// 下都是它本身。描述两样都不是的登记守卫看不见，也算失败。
// ════════════════════════════════════════════════════════════

const ROOT = join(import.meta.dirname, '../..');
/** 夹具：两条用本包字典登记说明的指令，其中一条英文的第一句超过 48 列 */
const FIXTURE = join(ROOT, 'test/fixtures/command-descriptions');
/** 第一方原文的语言：没有字典的描述只按它核一遍 */
const SOURCE_LANGUAGE = 'zh-CN';

/** 名字与描述不是字面量、却不是登记的 `.command(…)`：文件 → 理由。每个文件都还有这样的调用 */
const FORWARDERS = new Map([['packages/api-commands/src/index.ts', '绑定门面把插件的登记原样转给当前的指令服务']]);

interface Registration {
  file: string;
  line: number;
  /** 点路径名；DSL 不是字面量时为 undefined */
  name: string | undefined;
  /** 描述：字面量，或本包字典 `t('键')` 给的文字对象；两样都不是时为 undefined */
  description: string | TextRef | undefined;
}

const literalText = (node: ts.Node | undefined) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/**
 * 描述写成 `t('键')` 时的文字对象：t 从本包（pkgDir 下）的模块具名导入，只给一个字面量的键。导入那个模块（字典随之登记进
 * 目录）调用它；别的写法、键不在字典里时为 undefined
 */
async function dictionaryText(
  node: ts.Node | undefined,
  source: ts.SourceFile,
  pkgDir: string,
): Promise<TextRef | undefined> {
  if (!node || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.arguments.length !== 1) {
    return undefined;
  }
  const key = literalText(node.arguments[0]);
  const local = node.expression.text;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    const binding =
      bindings && ts.isNamedImports(bindings) ? bindings.elements.find(e => e.name.text === local) : undefined;
    if (!binding) continue;
    const specifier = statement.moduleSpecifier.text;
    const target = resolve(dirname(source.fileName), specifier.replace(/\.js$/, '.ts'));
    if (key === undefined || !specifier.startsWith('.') || relative(pkgDir, target).startsWith('..')) return undefined;
    const factory = (await import(pathToFileURL(target).href))[(binding.propertyName ?? binding.name).text];
    try {
      const text: unknown = factory(key);
      return isTextRef(text) ? text : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 这些包目录的 src 里的 `.command(DSL, 描述, …)` */
async function registrations(pkgDirs: readonly string[]): Promise<Registration[]> {
  const found: Registration[] = [];
  for (const pkgDir of pkgDirs) {
    const files = readdirSync(join(pkgDir, 'src'), { recursive: true, encoding: 'utf-8' });
    for (const rel of files.filter(f => /\.tsx?$/.test(f))) {
      const path = join(pkgDir, 'src', rel);
      const source = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true);
      const calls: ts.CallExpression[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'command' &&
          node.arguments.length > 0
        ) {
          calls.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const call of calls) {
        const [dsl, described] = call.arguments;
        found.push({
          file: relative(ROOT, path),
          line: source.getLineAndCharacterOfPosition(call.getStart()).line + 1,
          name: literalText(dsl)?.trim().split(/\s+/)[0],
          description: literalText(described) ?? (await dictionaryText(described, source, pkgDir)),
        });
      }
    }
  }
  return found;
}

/**
 * 每种语言下各指令与分组的描述：语言 → 名字 → 描述。语言是第一方原文的语言与用到的字典的原文、译文语言；文字对象按
 * 只有这种语言的读者渲染。分组的点路径一并列进来，没登记的分组描述为空
 */
function describedByLanguage(found: readonly Registration[]): Map<string, Map<string, string>> {
  const used = new Set(found.flatMap(r => (isTextRef(r.description) ? [r.description.i18n] : [])));
  const languages = new Set([SOURCE_LANGUAGE]);
  for (const entry of catalogEntries()) {
    if (!used.has(entry.ns)) continue;
    languages.add(entry.language);
    for (const language of Object.keys(entry.locales)) languages.add(language);
  }
  return new Map(
    [...languages].map(language => {
      const described = new Map<string, string>();
      for (const { name, description } of found) {
        if (name === undefined || description === undefined) continue;
        const parts = name.split('.');
        for (let i = 1; i < parts.length; i++) {
          const group = parts.slice(0, i).join('.');
          if (!described.has(group)) described.set(group, '');
        }
        described.set(name, typeof description === 'string' ? description : resolveText(description, [language]));
      }
      return [language, described];
    }),
  );
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** 第一句有毛病的描述（`语言 名字「描述」`）：空、括号不成对（Unicode 的开括号与闭括号各自计数，尖括号另算）、被截断 */
function badSummaries(byLanguage: Map<string, Map<string, string>>): string[] {
  return [...byLanguage].flatMap(([language, described]) =>
    [...described]
      .filter(([, description]) => {
        const summary = brief(description);
        return (
          summary === '' ||
          summary.endsWith('…') ||
          count(summary, /\p{Ps}/gu) !== count(summary, /\p{Pe}/gu) ||
          count(summary, /</g) !== count(summary, />/g)
        );
      })
      .map(([name, description]) => `${language} ${name}「${description}」`),
  );
}

/** 同级之间摘要重样的（`语言 甲 与 乙：摘要`） */
function clashes(byLanguage: Map<string, Map<string, string>>): string[] {
  return [...byLanguage].flatMap(([language, described]) => {
    const bySibling = new Map<string, Map<string, string>>();
    const hits: string[] = [];
    for (const [name, description] of described) {
      const parent = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '';
      const siblings = bySibling.get(parent) ?? new Map<string, string>();
      bySibling.set(parent, siblings);
      const summary = brief(description);
      const other = siblings.get(summary);
      if (other) hits.push(`${language} ${other} 与 ${name}：${summary}`);
      siblings.set(summary, name);
    }
    return hits;
  });
}

const found = await registrations(readdirSync(join(ROOT, 'packages')).map(pkg => join(ROOT, 'packages', pkg)));

describe('第一方指令的描述：第一句就是摘要', () => {
  const byLanguage = describedByLanguage(found);

  it('收集到的登记不空，名字是字面量，描述是字面量或本包字典的 t(键)', () => {
    expect(found.length).toBeGreaterThan(40);
    const unseen = found.filter(r => r.name === undefined || r.description === undefined);
    expect(unseen.filter(r => !FORWARDERS.has(r.file))).toEqual([]);
    expect(new Set(unseen.map(r => r.file))).toEqual(new Set(FORWARDERS.keys()));
  });

  it('每种语言下，每条指令与分组的第一句都不空、括号成对、不被截断', () => {
    expect(badSummaries(byLanguage)).toEqual([]);
  });

  it('每种语言下，同级之间摘要不重样', () => {
    expect(clashes(byLanguage)).toEqual([]);
  });
});

describe('守卫对本包字典的描述按各语言核', () => {
  it('英文的第一句超过 48 列的被拦下，原文与另一条不受影响', async () => {
    const fixture = await registrations([FIXTURE]);
    expect(fixture.map(r => isTextRef(r.description))).toEqual([true, true]);
    expect(badSummaries(describedByLanguage(fixture))).toEqual([
      'en zz-long「A first sentence that keeps going well past the forty-eight column limit. Details follow」',
    ]);
  });
});
