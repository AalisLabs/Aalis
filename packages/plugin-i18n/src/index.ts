// ============================================================
// @aalis/plugin-i18n — i18n 服务的默认提供者
//
// 按读者的语言链渲染文字对象：languages 读者直接给链（规范化后为空时按全局默认层），sessionId 读者取会话设置的 language
// （本插件登记），host 读者取全局默认层，哪一层都没设时按 en。语言包取自贡献点 i18n:pack，用时与贡献点对照，变了才重建索引。
// 另给 WebUI 两样：可选项来源 i18n-languages（贡献点 webui:options，值是语言标签、标签是自称），与「翻译」页（translation.ts）。
// ============================================================

import { contributions } from '@aalis/api-contributions';
import { type Audience, i18n, type LanguageInfo } from '@aalis/api-i18n';
import { type SessionSetting, sessionManager } from '@aalis/api-session-manager';
import { webuiServer } from '@aalis/api-webui';
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
import { defineTranslationPage } from './translation.js';

declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    /** 读者的语言链：语言标签，靠前的优先 */
    language?: string[];
  }
}

/**
 * 会话设置 language：有序的语言列表，可选项是有文字可用的语言。规范化（同读的一侧，zh_CN 收下、读时整理成 zh-CN）
 * 之后不合法的标签拒收，完全相同的重复项由字段的 ordered 去掉；哪一层都没设时按 en（chainOf）
 */
const LANGUAGE_SETTING: SessionSetting = {
  key: 'language',
  field: {
    type: 'multiselect',
    label: t('settingLabel'),
    description: t('settingDescription'),
    ordered: true,
    dynamicOptions: 'i18n-languages',
  },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'common',
  unset: t('settingUnset'),
  validate(value) {
    // 不是数组的交给字段校验
    if (!Array.isArray(value)) return undefined;
    const bad = value.findIndex(tag => normalizeLanguages([tag]).length === 0);
    return bad < 0 ? undefined : t('badLanguage', { tag: String(value[bad]) });
  },
};

const uses = {
  provide,
  /** 语言包的来源，交可选项来源；缺席时没有语言包 */
  contributions: optional(contributions),
  /** 登记会话设置 language，sessionId 与 host 读者（含链为空的 languages 读者）取它；缺席时按 en */
  sessionManager: optional(sessionManager),
  /** 「翻译」页 */
  webui: optional(webuiServer),
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
      const chain = normalizeLanguages(settingOf(caps, audience));
      if (chain.length > 0) return chain;
      return 'languages' in audience ? chainOf({ host: true }) : ['en'];
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
    caps.sessionManager.use.registerSetting(LANGUAGE_SETTING);
    caps.contributions.use.contribute('webui:options', {
      id: 'i18n-languages',
      list: () => languagesOf(packs()).map(({ tag, name }) => ({ value: tag, label: name })),
    });
    defineTranslationPage(caps.webui.use, packs, () => languagesOf(packs()).map(({ tag }) => tag));
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
    value = config.language;
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
