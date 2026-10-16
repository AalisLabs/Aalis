// ============================================================
// @aalis/plugin-i18n — i18n 服务的默认提供者
//
// 按读者的语言链渲染文字对象：languages 读者直接给链，sessionId 读者取会话设置的 language，host 读者取全局默认层，
// 哪一层都没设时按 en。语言包取自贡献点 i18n:pack，用时与贡献点对照，变了才重建索引。
// ============================================================

import { contributions } from '@aalis/api-contributions';
import { type Audience, i18n, type LanguageInfo } from '@aalis/api-i18n';
import { sessionManager } from '@aalis/api-session-manager';
import { type BoundOf, definePlugin, optional, provide } from '@aalis/core';
import {
  catalogEntries,
  indexPacks,
  type LanguagePack,
  localize,
  normalizeLanguages,
  type PackIndex,
  resolveText,
} from '@aalis/schema-i18n';
import { t } from './texts.js';

/** 语言链最多几种：再多也轮不到 */
const MAX_CHAIN = 8;
/** 读者给的列表只看前几项：超长的列表不逐项规范化 */
const MAX_INPUT = 32;

const uses = {
  provide,
  /** 语言包的来源；缺席时没有语言包 */
  contributions: optional(contributions),
  /** sessionId 与 host 读者的语言设置；缺席时这两种读者按 en */
  sessionManager: optional(sessionManager),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-i18n',
  displayName: t('displayName'),
  subsystem: 'core',
  provides: [i18n],
  uses,
  apply(caps) {
    const packs = packIndex(caps);
    const chainOf = (audience: Audience): readonly string[] => {
      const chain = normalizeLanguages(settingOf(caps, audience).slice(0, MAX_INPUT)).slice(0, MAX_CHAIN);
      return chain.length > 0 ? chain : ['en'];
    };
    caps.provide.use(i18n, {
      chainOf,
      render: (value, audience, opts = {}) => {
        const chain = chainOf(audience);
        const timeZone = 'timeZone' in audience ? audience.timeZone : undefined;
        const options = { packs: packs(), timeZone, escape: opts.escape };
        return localize(value, text => resolveText(text, chain, options), opts.skip);
      },
      languages: () => languagesOf(packs()),
    });
  },
});

/**
 * 语言包索引的取用：每次先取贡献点的快照（按全局键排好的序），交付与上次相同就沿用，变了才重建，
 * 运行中的交付与撤回立即生效。贡献点缺席时为空
 */
function packIndex(caps: Caps): () => PackIndex {
  let specs: readonly LanguagePack[] = [];
  let index: PackIndex = new Map();
  return () => {
    const current = caps.contributions.present
      ? caps.contributions.use.collect('i18n:pack').map(handle => handle.spec)
      : [];
    if (current.length !== specs.length || current.some((spec, i) => spec !== specs[i])) {
      specs = current;
      index = indexPacks(current);
    }
    return index;
  };
}

/** 读者设的语言（未整理）：不是数组的当作没设，元素交给 normalizeLanguages 筛 */
function settingOf(caps: Caps, audience: Audience): readonly unknown[] {
  let value: unknown;
  if ('languages' in audience) value = audience.languages;
  else if (caps.sessionManager.present) {
    const sessions = caps.sessionManager.use;
    const config =
      'sessionId' in audience
        ? sessions.resolveConfig(audience.sessionId, audience.platform)
        : sessions.getLayer({ scope: 'defaults' });
    value = (config as { language?: unknown }).language;
  }
  return Array.isArray(value) ? value : [];
}

/** 有文字可用的语言：目录里各字典的原文语言与译文语言、语言包的语言（都已规范化） */
function languagesOf(packs: PackIndex): LanguageInfo[] {
  const tags = new Set<string>();
  for (const entry of catalogEntries()) {
    tags.add(entry.language);
    for (const tag of Object.keys(entry.locales)) tags.add(tag);
  }
  for (const keys of packs.values()) {
    for (const candidates of keys.values()) for (const { language } of candidates) tags.add(language);
  }
  return [...tags].sort().map(tag => ({ tag, name: selfName(tag) }));
}

/** 该语言的自称（English、日本語）；带扩展的标签这类 DisplayNames 不收的，用标签本身 */
function selfName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
