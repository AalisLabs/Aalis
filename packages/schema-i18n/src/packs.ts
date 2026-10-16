// 语言包：给字典补它没有的语言。条目带翻译时原文的指纹，原文改了措辞的条目当作缺失
import { normalizeLanguages } from './locale.js';

/** 语言包里的一条译文；`from` 是翻译时原文模板的 {@link fingerprint} */
export interface PackText {
  readonly text: string;
  readonly from: string;
}

/** 一个语言包：一种语言，按 ns 与键给译文 */
export interface LanguagePack {
  readonly id: string;
  readonly language: string;
  readonly entries: Readonly<Record<string, Readonly<Record<string, PackText>>>>;
}

/** 索引里的一条：语言已规范化 */
interface PackCandidate extends PackText {
  readonly language: string;
}

/** 语言包索引：ns → 键 → 各包给的译文，按包 id 排序（同一语言取先）。用 {@link indexPacks} 建 */
export type PackIndex = ReadonlyMap<string, ReadonlyMap<string, readonly PackCandidate[]>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 建语言包索引。语言包来自第三方：形状不对的包、语言标签不合法的包、形状不对的表与条目都跳过，不影响别的包；
 * 取舍（只补缺、指纹、解析失败与参数不兼容、同语言取先）在解析时做
 */
export function indexPacks(packs: readonly LanguagePack[]): PackIndex {
  const index = new Map<string, Map<string, PackCandidate[]>>();
  const sorted = packs
    .filter(pack => isRecord(pack) && typeof pack.id === 'string' && isRecord(pack.entries))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const pack of sorted) {
    const [language] = normalizeLanguages([pack.language]);
    if (language === undefined) continue;
    for (const [ns, table] of Object.entries(pack.entries)) {
      if (!isRecord(table)) continue;
      for (const [key, entry] of Object.entries(table)) {
        if (typeof entry?.text !== 'string' || typeof entry.from !== 'string') continue;
        const keys = index.get(ns) ?? new Map<string, PackCandidate[]>();
        const candidates = keys.get(key) ?? [];
        candidates.push({ language, text: entry.text, from: entry.from });
        keys.set(key, candidates);
        index.set(ns, keys);
      }
    }
  }
  return index;
}

/** 原文模板的指纹：FNV-1a 32 位，按 UTF-16 码元，写成 8 位十六进制 */
export function fingerprint(template: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < template.length; i++) {
    hash ^= template.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
