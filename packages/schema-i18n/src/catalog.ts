// 进程级目录：各包的原文字典登记在这里，解析时按 ns 查。
//
// 目录放在 globalThis[Symbol.for('aalis.i18n.catalog')]，进程里装了几份本包（第三方插件带的嵌套副本）都共用它，
// 所以目录与条目的形状是跨副本的协议：目录是 { entries: Map<ns, 条目>, issues: 冲突[] }，
// 条目是 { v: 1, ns, language, source, locales }，只放字符串表，不放函数与解析结果。
// 条目结构有破坏性改动时升 v；解析遇到不认识的 v 退回 text.source。

/** 字符串表：键 → 消息模板 */
export type StringTable = Readonly<Record<string, string>>;

/** 译文表：允许缺键 */
export type LocaleTable = { readonly [key: string]: string | undefined };

/** 目录里的一个字典（协议第 1 版）。language 与 locales 的键是规范化后的语言标签 */
export interface CatalogEntry {
  readonly v: 1;
  readonly ns: string;
  readonly language: string;
  readonly source: StringTable;
  readonly locales: Readonly<Record<string, LocaleTable>>;
}

/**
 * 同一 ns 再次登记时的冲突：原文语言不同（整份不合并）、同键原文或译文不同（保留先登记的）、
 * 已有条目的协议版本不认识（不合并）
 */
export type CatalogIssue =
  | { readonly ns: string; readonly kind: 'language'; readonly language: string }
  | { readonly ns: string; readonly kind: 'source'; readonly key: string }
  | { readonly ns: string; readonly kind: 'locale'; readonly language: string; readonly key: string }
  | { readonly ns: string; readonly kind: 'version' };

interface Catalog {
  /** 值可能来自别的副本、是更新的协议版本，读出来先认 v */
  readonly entries: Map<string, unknown>;
  readonly issues: CatalogIssue[];
}

const SLOT = Symbol.for('aalis.i18n.catalog');

function catalog(): Catalog {
  const global = globalThis as { [SLOT]?: Catalog };
  global[SLOT] ??= { entries: new Map(), issues: [] };
  return global[SLOT];
}

function isCurrent(entry: unknown): entry is CatalogEntry {
  return (entry as { v?: unknown } | undefined)?.v === 1;
}

/** 表里的一条：只认自有的字符串值 */
export function entryText(table: LocaleTable, key: string): string | undefined {
  const text = Object.hasOwn(table, key) ? table[key] : undefined;
  return typeof text === 'string' ? text : undefined;
}

/** 本版协议的条目，没登记或版本不认识时 undefined */
export function catalogEntry(ns: string): CatalogEntry | undefined {
  const entry = catalog().entries.get(ns);
  return isCurrent(entry) ? entry : undefined;
}

/** 补入 from 里 into 没有的键；同键不同文记一条冲突。没有新键时返回 into 本身 */
function mergeTable(
  into: LocaleTable,
  from: LocaleTable,
  conflict: (key: string) => CatalogIssue,
  issues: CatalogIssue[],
): LocaleTable {
  let merged: Record<string, string | undefined> | undefined;
  for (const key of Object.keys(from)) {
    const text = entryText(from, key);
    if (text === undefined) continue;
    const existing = entryText(into, key);
    if (existing === undefined) {
      merged ??= { ...into };
      merged[key] = text;
    } else if (existing !== text) {
      issues.push(conflict(key));
    }
  }
  return merged ?? into;
}

/** 登记一个字典。同一 ns 再次登记按键合并：已有键保留先登记的，新键补入，冲突记进目录（库本身不打日志） */
export function registerTexts(entry: Omit<CatalogEntry, 'v'>): void {
  const { entries, issues } = catalog();
  const { ns, language } = entry;
  const existing = entries.get(ns);
  if (existing === undefined) {
    entries.set(ns, { v: 1, ...entry });
    return;
  }
  if (!isCurrent(existing)) {
    issues.push({ ns, kind: 'version' });
    return;
  }
  if (existing.language !== language) {
    issues.push({ ns, kind: 'language', language });
    return;
  }
  const source = mergeTable(existing.source, entry.source, key => ({ ns, kind: 'source', key }), issues);
  const locales: Record<string, LocaleTable> = { ...existing.locales };
  for (const [tag, table] of Object.entries(entry.locales)) {
    locales[tag] = mergeTable(locales[tag] ?? {}, table, key => ({ ns, kind: 'locale', language: tag, key }), issues);
  }
  entries.set(ns, { ...existing, source: source as StringTable, locales });
}

/** 目录里本版协议的全部字典 */
export function catalogEntries(): CatalogEntry[] {
  return [...catalog().entries.values()].filter(isCurrent);
}

/** 目录记下的冲突（副本） */
export function catalogIssues(): CatalogIssue[] {
  return [...catalog().issues];
}
