// 进程级目录：各包的原文字典登记在这里，解析时按 ns 查。
//
// 目录放在 globalThis[Symbol.for('aalis.i18n.catalog')]，进程里装了几份本包（第三方插件带的嵌套副本）都共用它，
// 所以目录与条目的形状是跨副本的协议：目录是 { entries: Map<ns, 条目>, issues: 冲突[] }，
// 条目是 { v: 1, ns, language, source, locales }，只放字符串表，不放函数与解析结果。
// 条目结构有破坏性改动时升 v；解析遇到不认识的 v 退回 text.source。

import { canonicalLanguage } from './locale.js';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringTable = (value: unknown): value is StringTable =>
  isRecord(value) && Object.values(value).every(text => typeof text === 'string');

/**
 * 登记外来的目录条目（前端构建时写下的、插件前端随 init 收到的，都是 {@link CatalogEntry} 写成的 JSON）：按本版协议核形状——
 * v 为 1，ns 是非空字符串，语言标签合法、规范化后不重复，原文与各语言译文表的值都是字符串——语言标签规范化；不合的整条
 * 不登记，回 false。同一 ns 已登记时与 defineTexts 一样按键合并
 */
export function registerCatalogEntry(value: unknown): boolean {
  if (!isRecord(value) || value.v !== 1 || typeof value.ns !== 'string' || value.ns === '') return false;
  const language = typeof value.language === 'string' ? canonicalLanguage(value.language) : undefined;
  const { source, locales } = value;
  if (language === undefined || !isStringTable(source) || !isRecord(locales)) return false;
  const tables: Record<string, StringTable> = {};
  for (const [tag, table] of Object.entries(locales)) {
    const canonical = canonicalLanguage(tag);
    if (canonical === undefined || Object.hasOwn(tables, canonical) || !isStringTable(table)) return false;
    tables[canonical] = table;
  }
  registerTexts({ ns: value.ns, language, source, locales: tables });
  return true;
}

/** 目录里本版协议的全部字典 */
export function catalogEntries(): CatalogEntry[] {
  return [...catalog().entries.values()].filter(isCurrent);
}

/** 目录记下的冲突（副本） */
export function catalogIssues(): CatalogIssue[] {
  return [...catalog().issues];
}
