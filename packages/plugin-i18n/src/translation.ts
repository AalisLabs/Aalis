// ============================================================
// translation.ts — 「翻译」页
//
// 按 ns 列出每个字典在各种语言上的情况：已译几条（字典自带的译文，加上语言包里原文指纹相符的）、缺几条、过时几条
// （语言包里有、但原文改过措辞的）、冲突几条（目录记下的同 ns 再登记冲突，与几个语言包给同一条的指纹相符的译文不一样）、
// 坏几条（checkTexts 报的解析失败、参数与原文不合、可疑引号、反引号里的参数）。语言是 languages() 的全部，
// 原文语言那一行不列。选中一行给出具体的键与两种待译骨架：本插件的 locales/<语言>.ts，与语言包的 entries（带 from）。
// ============================================================

import { type BoundWebui, markdownCode } from '@aalis/api-webui';
import {
  type CatalogEntry,
  catalogEntries,
  catalogIssues,
  checkTexts,
  fingerprint,
  type PackIndex,
  TextError,
  type TextRef,
  textLines,
} from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 一个字典在一种语言上的情况：各类问题的键（冲突里整份字典的冲突写成一句） */
interface Coverage {
  entry: CatalogEntry;
  language: string;
  missing: string[];
  stale: string[];
  conflicts: (string | TextRef)[];
  broken: string[];
}

/** 字典自带的这一条译文 */
function ownText(entry: CatalogEntry, language: string, key: string): string | undefined {
  const text = entry.locales[language]?.[key];
  return typeof text === 'string' ? text : undefined;
}

/**
 * 语言包给这一条的译文：同一语言、按交来的先后。fresh 是原文指纹相符的，解析时补缺用其中第一条；其余是过时的，解析时用不上
 */
function packed(packs: PackIndex, entry: CatalogEntry, language: string, key: string) {
  const all = (packs.get(entry.ns)?.get(key) ?? []).filter(candidate => candidate.language === language);
  const from = fingerprint(entry.source[key]);
  return { all, fresh: all.filter(candidate => candidate.from === from) };
}

function coverageOf(entry: CatalogEntry, language: string, packs: PackIndex): Coverage {
  const effective: Record<string, string> = {};
  const stale: string[] = [];
  const conflicts = new Set<string>();
  let whole = false;
  for (const key of Object.keys(entry.source)) {
    const { all, fresh } = packed(packs, entry, language, key);
    if (new Set(fresh.map(({ text }) => text)).size > 1) conflicts.add(key);
    const text = ownText(entry, language, key) ?? fresh[0]?.text;
    if (text !== undefined) effective[key] = text;
    else if (all.length > 0) stale.push(key);
  }
  for (const issue of catalogIssues()) {
    if (issue.ns !== entry.ns || (issue.kind === 'locale' && issue.language !== language)) continue;
    if ('key' in issue) conflicts.add(issue.key);
    else whole = true;
  }
  const issues = checkTexts({ ...entry, locales: { [language]: effective } }).filter(
    issue => issue.language === language,
  );
  return {
    entry,
    language,
    missing: issues.flatMap(issue => (issue.kind === 'missing' ? issue.keys : [])),
    stale,
    conflicts: [...conflicts, ...(whole ? [t('wholeDictionary')] : [])],
    broken: [...new Set(issues.flatMap(issue => (issue.kind === 'missing' ? [] : [issue.key])))],
  };
}

/** 全部字典在各种语言上的情况，按 ns 再按语言排 */
function coverages(packs: PackIndex, languages: readonly string[]): Coverage[] {
  return catalogEntries()
    .sort((a, b) => a.ns.localeCompare(b.ns))
    .flatMap(entry =>
      languages.filter(language => language !== entry.language).map(language => coverageOf(entry, language, packs)),
    );
}

/** 选中的那一行：rowKey 是 [ns, 语言] 的 JSON */
function selected(rowKey: string, packs: PackIndex): Coverage {
  const [ns, language] = JSON.parse(rowKey) as [string, string];
  const entry = catalogEntries().find(candidate => candidate.ns === ns);
  if (!entry) throw new TextError(t('dictionaryGone', { ns }));
  return coverageOf(entry, language, packs);
}

function issuesText(coverage: Coverage): TextRef {
  const lines = (
    [
      [t('missing'), coverage.missing],
      [t('stale'), coverage.stale],
      [t('conflicts'), coverage.conflicts],
      [t('broken'), coverage.broken],
    ] as const
  )
    .filter(([, keys]) => keys.length > 0)
    .map(([kind, keys]) => t('issueLine', { kind, keys }));
  return lines.length > 0 ? textLines(lines) : t('noIssues');
}

/** 本插件的 locales/<语言>.ts：字典自带的译文照旧，缺的先填原文 */
function localeSkeleton({ entry, language }: Coverage): string {
  const lines = Object.entries(entry.source).map(
    ([key, template]) => `  ${JSON.stringify(key)}: ${JSON.stringify(ownText(entry, language, key) ?? template)},`,
  );
  return [
    "import { defineLocale } from '@aalis/schema-i18n';",
    "import type { Source } from '../texts.js';",
    '',
    'export default defineLocale<Source>()({',
    ...lines,
    '});',
  ].join('\n');
}

/** 语言包的 entries：字典自带译文的键不列（语言包只补缺），指纹相符的译文照旧，缺的与过时的先填原文 */
function packSkeleton({ entry, language }: Coverage, packs: PackIndex): string {
  const table = Object.fromEntries(
    Object.entries(entry.source)
      .filter(([key]) => ownText(entry, language, key) === undefined)
      .map(([key, template]) => [
        key,
        { text: packed(packs, entry, language, key).fresh[0]?.text ?? template, from: fingerprint(template) },
      ]),
  );
  return JSON.stringify({ [entry.ns]: table }, null, 2);
}

/** 登记「翻译」页：packs 现取语言包索引，languages 现取有文字可用的语言 */
export function defineTranslationPage(
  webui: BoundWebui,
  packs: () => PackIndex,
  languages: () => readonly string[],
): void {
  webui.definePage({
    key: 'translation',
    title: t('pageTitle'),
    icon: 'languages',
    content: [
      {
        type: 'table',
        id: 'dictionaries',
        description: t('dictionariesDescription'),
        rowKey: 'id',
        columns: [
          { key: 'ns', label: t('dictionary'), kind: 'code', primary: true },
          { key: 'language', label: t('language'), primary: true },
          { key: 'translated', label: t('translated') },
          { key: 'missing', label: t('missing') },
          { key: 'stale', label: t('stale') },
          { key: 'conflicts', label: t('conflicts') },
          { key: 'broken', label: t('broken') },
        ],
        data: () =>
          coverages(packs(), languages()).map(({ entry, language, missing, stale, conflicts, broken }) => {
            const total = Object.keys(entry.source).length;
            return {
              id: JSON.stringify([entry.ns, language]),
              ns: entry.ns,
              language,
              translated: `${total - missing.length}/${total}`,
              missing: missing.length,
              stale: stale.length,
              conflicts: conflicts.length,
              broken: broken.length,
            };
          }),
        detail: [
          {
            type: 'markdown',
            id: 'issues',
            label: t('issues'),
            data: ({ rowKey }) => issuesText(selected(rowKey, packs())),
          },
          {
            type: 'markdown',
            id: 'locale',
            label: t('localeSkeleton'),
            description: t('localeSkeletonDescription'),
            data: ({ rowKey }) => markdownCode(localeSkeleton(selected(rowKey, packs())), 'ts'),
          },
          {
            type: 'markdown',
            id: 'pack',
            label: t('packSkeleton'),
            description: t('packSkeletonDescription'),
            data: ({ rowKey }) => {
              const current = packs();
              return markdownCode(packSkeleton(selected(rowKey, current), current), 'json');
            },
          },
        ],
      },
    ],
  });
}
