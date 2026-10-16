// 字典自检：第三方在单测里一行调用 `expect(checkTexts(t)).toEqual([])`，第一方由守卫调用
import { entryText } from './catalog.js';
import type { TextDomain } from './define.js';
import { incompatibleParams, type Message, paramKinds, parseMessage } from './message.js';

/**
 * 字典的问题：原文或译文解析失败；原文里同一参数的用法互不相容，或译文用了原文没有的参数、收不下原文交来的值；
 * 引号把原文的参数写成了字面（英文里给参数加引号要用 ‘ ’ 或 “ ”，`'{name}'` 是字面的 {name}）；
 * 反引号里直接写参数（Markdown 出口转义后显出反斜杠，要写成 `{名, code}`）；某种语言缺的键
 */
export type TextIssue =
  | { readonly kind: 'parse'; readonly language: string; readonly key: string }
  | { readonly kind: 'params'; readonly language: string; readonly key: string; readonly params: readonly string[] }
  | { readonly kind: 'quote'; readonly language: string; readonly key: string }
  | { readonly kind: 'code'; readonly language: string; readonly key: string }
  | { readonly kind: 'missing'; readonly language: string; readonly keys: readonly string[] };

/** 引号里形如参数的写法：奇数个撇号接 {名} 或 {名, */
const QUOTED_ARGUMENT = /(?:^|[^'])(?:'')*'\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[},]/g;

/** 会按 Markdown 转义的参数（字符串原样渲染的那几种）紧挨着反引号 */
function argumentInBackticks(message: Message): boolean {
  return message.some((part, i) => {
    if (typeof part === 'string' || part.type === 'pound') return false;
    if (part.type === 'plural' || part.type === 'select') return [...part.branches.values()].some(argumentInBackticks);
    if (part.type !== 'plain' && part.type !== 'list' && part.type !== 'lines') return false;
    const before = message[i - 1];
    const after = message[i + 1];
    return (typeof before === 'string' && before.endsWith('`')) || (typeof after === 'string' && after.startsWith('`'));
  });
}

/** 检查一个字典（defineTexts 返回的 t()，或目录里的条目） */
export function checkTexts(domain: TextDomain): TextIssue[] {
  const issues: TextIssue[] = [];
  const locales = Object.entries(domain.locales);
  for (const [key, template] of Object.entries(domain.source)) {
    const source = parseMessage(template);
    const expected = source && paramKinds(source);
    const check = (language: string, text: string, message: Message) => {
      if (expected && [...text.matchAll(QUOTED_ARGUMENT)].some(match => expected.has(match[1]))) {
        issues.push({ kind: 'quote', language, key });
      }
      if (argumentInBackticks(message)) issues.push({ kind: 'code', language, key });
    };
    if (source && expected) {
      const conflicting = [...expected].filter(([, accepts]) => accepts === 0).map(([name]) => name);
      if (conflicting.length > 0) issues.push({ kind: 'params', language: domain.language, key, params: conflicting });
      check(domain.language, template, source);
    } else {
      issues.push({ kind: 'parse', language: domain.language, key });
    }
    for (const [language, table] of locales) {
      const text = entryText(table, key);
      if (text === undefined) continue;
      const message = parseMessage(text);
      if (!message) {
        issues.push({ kind: 'parse', language, key });
        continue;
      }
      const params = expected ? incompatibleParams(expected, message) : [];
      if (params.length > 0) issues.push({ kind: 'params', language, key, params });
      check(language, text, message);
    }
  }
  for (const [language, table] of locales) {
    const keys = Object.keys(domain.source).filter(key => entryText(table, key) === undefined);
    if (keys.length > 0) issues.push({ kind: 'missing', language, keys });
  }
  return issues;
}
