// ============================================================
// @aalis/plugin-i18n — i18n 服务的默认提供者
//
// 按读者的语言链渲染文字对象：host 读者与 owner 会话的读者取全局默认层，其余 sessionId 读者（房间、子会话，不在会话表里的）
// 取会话设置的 language（本插件登记），哪一层都没设时按 en；列表里的 auto（跟随系统）换成服务进程的系统语言。日期与时间按
// 服务进程的时区。
// 语言包取自贡献点 i18n:pack，用时与贡献点对照，变了才重建索引。
// 另给 WebUI 两样：可选项来源 i18n-languages（贡献点 webui:options，值是语言标签、标签是自称，第一项是跟随系统），
// 与「翻译」页（translation.ts）。诊断 i18n.languages 提示各层的语言列表里没有任何插件提供的语言，同一份结论进 WebUI 的
// 「需要处理」。
// ============================================================

import { contributions } from '@aalis/api-contributions';
import { type CheckResult, doctor } from '@aalis/api-doctor';
import { type Audience, i18n, type LanguageInfo } from '@aalis/api-i18n';
import {
  placeKind,
  placeLabel,
  SESSION_LAYERS,
  type SessionConfigLayer,
  type SessionInfo,
  type SessionManagerService,
  type SessionSetting,
  sessionManager,
} from '@aalis/api-session-manager';
import { type NoticeHandle, webuiServer } from '@aalis/api-webui';
import { type BoundOf, definePlugin, events, optional, provide } from '@aalis/core';
import {
  catalogEntries,
  indexPacks,
  type LanguagePack,
  localize,
  matchLanguage,
  normalizeLanguages,
  type PackIndex,
  pickLanguage,
  resolveText,
  selfName,
  type TextRef,
} from '@aalis/schema-i18n';
import { t } from './texts.js';
import { defineTranslationPage } from './translation.js';

declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    /** 读者的语言链：语言标签或 auto（跟随系统），靠前的优先 */
    language?: string[];
  }
}

/** 跟随系统：服务进程的系统语言（{@link systemLanguage}），插件激活时取一次。跟的是服务所在的机器，不是读者 */
const AUTO = 'auto';

const CHECK_ID = 'i18n.languages';

/**
 * 会话设置 language：有序的语言列表，可选项是跟随系统与有文字可用的语言。规范化（同读的一侧，zh_CN 收下、
 * 读时整理成 zh-CN）之后不合法的标签拒收，完全相同的重复项由字段的 ordered 去掉；哪一层都没设时按 en（chainOf）。
 * 只适用于房间：owner 会话（WebUI 与终端）的读者是 owner 自己、按全局默认层，子会话跟根会话，所以不随建子会话复制
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
  appliesTo: ['room'],
  liveOnly: true,
  prominence: 'common',
  unset: t('settingUnset'),
  validate(value) {
    // 不是数组的交给字段校验
    if (!Array.isArray(value)) return undefined;
    const bad = value.findIndex(tag => tag !== AUTO && normalizeLanguages([tag]).length === 0);
    return bad < 0 ? undefined : t('badLanguage', { tag: String(value[bad]) });
  },
};

const uses = {
  provide,
  /** 语言诊断随会话设置与插件的变化重算 */
  events,
  /** 语言包的来源，交可选项来源；缺席时没有语言包 */
  contributions: optional(contributions),
  /** 登记会话设置 language，读者的语言取它；缺席时按 en */
  sessionManager: optional(sessionManager),
  /** 「翻译」页，「需要处理」里的语言诊断 */
  webui: optional(webuiServer),
  /** 诊断：各层的语言列表里有没有任何插件提供的语言 */
  doctor: optional(doctor),
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
    const system = systemLanguage();
    const chainOf = (audience: Audience) => chainFrom(settingOf(caps, audience), system);
    caps.provide.use(i18n, {
      chainOf,
      render: (value, audience, opts = {}) => {
        const chain = chainOf(audience);
        const options = { packs: packs(), escape: opts.escape };
        return localize(value, text => resolveText(text, chain, options), opts.skip);
      },
      languages: () => languagesOf(packs()),
    });
    caps.sessionManager.use.registerSetting(LANGUAGE_SETTING);
    caps.contributions.use.contribute('webui:options', {
      id: 'i18n-languages',
      list: () => [
        { value: AUTO, label: t('followSystem', { current: selfName(system) }) },
        ...languagesOf(packs()).map(({ tag, name }) => ({ value: tag, label: name })),
      ],
    });
    defineTranslationPage(caps.webui.use, packs, () => languagesOf(packs()).map(({ tag }) => tag));
    const check = () =>
      checkLanguages(
        layerSettings(caps),
        system,
        languagesOf(packs()).map(({ tag }) => tag),
      );
    caps.doctor.use.registerCheck({ id: CHECK_ID, category: 'config', run: check });
    // 「需要处理」：诊断的 warn 每条一项，按序编号、同号替换，少了的撤回。会话设置变了、插件变了（语言包与字典随插件交付
    // 与撤回）时重算，本插件激活所在的那一轮收敛时的 plugins:changed 就是激活时的一次；系统语言激活时取定。运行中不随插件
    // 变动的交付与撤回没有通知，下次重算时跟上
    let notices: NoticeHandle[] = [];
    const notify = () => {
      const warnings = check().filter(({ level }) => level === 'warn');
      for (const notice of notices.slice(warnings.length)) notice.clear();
      notices = warnings.map(({ message, detail }, i) =>
        caps.webui.use.notify({ id: `${CHECK_ID}.${i}`, level: 'action', title: message, detail }),
      );
    };
    caps.events.use.on('session:config:changed', notify);
    caps.events.use.on('plugins:changed', notify);
  },
});

/** 设的语言列表（未整理）换成语言链：auto 换成系统语言，规范化后一种都没有时按 en */
function chainFrom(setting: readonly unknown[], system: string): readonly string[] {
  const chain = normalizeLanguages(setting.map(tag => (tag === AUTO ? system : tag)));
  return chain.length > 0 ? chain : ['en'];
}

/** 一层自己写的语言列表（未整理）与这一层的称呼 */
interface LayerSetting {
  layer: SessionConfigLayer;
  name: TextRef;
  setting: readonly unknown[];
}

/**
 * 诊断：各层的语言链里，没有任何字典或语言包提供的语言（与渲染同一判法：语言与文字相同的，再语言相同的）每种一条 warn，
 * 写明是哪一层（全局默认层不写）、实际用的语言（按这一层的链在全部可用语言里选，同渲染的选法）与怎么办；都有提供时一条 ok。
 * 只提示，渲染照常按链往后找。跟随系统解析出的语言（列表里有 auto 时）结论另写一句
 */
function checkLanguages(layers: readonly LayerSetting[], system: string, available: readonly string[]): CheckResult[] {
  const base = { id: CHECK_ID, category: 'config' } as const;
  const warnings = layers.flatMap(({ layer, name, setting }) => {
    const chain = chainFrom(setting, system);
    const missing = chain.filter(tag => matchLanguage([tag], available) === undefined);
    if (missing.length === 0) return [];
    // 本插件自己的字典带 en，链里的语言都选不中时总有 en
    const used = selfName(available[pickLanguage(chain, available)!]);
    return missing.map((tag): CheckResult => {
      const language = selfName(tag);
      const followed = tag === system && setting.includes(AUTO);
      let message: TextRef;
      if (layer.scope === 'defaults') {
        message = followed ? t('followedUnprovided', { language, used }) : t('languageUnprovided', { language, used });
      } else {
        const params = { layer: name, language, used };
        message = followed ? t('layerFollowedUnprovided', params) : t('layerLanguageUnprovided', params);
      }
      return {
        ...base,
        level: 'warn',
        message,
        detail: t('installPack', { keywords: packKeywords(tag), layer: name }),
      };
    });
  });
  return warnings.length > 0 ? warnings : [{ ...base, level: 'ok', message: t('languagesProvided') }];
}

/**
 * 写了语言列表的层：会话管理能枚举的各层（全局默认、平台档、平台类型档、场所），按层表的先后；场所只看收这一项的（窗口，
 * 工作区按 owner 的会话、不收），写在那里也改不了的不报。会话管理缺席时没有
 */
function layerSettings(caps: Caps): LayerSetting[] {
  if (!caps.sessionManager.present) return [];
  const sessions = caps.sessionManager.use;
  return sessions.listLayers().flatMap(layer => {
    if (layer.scope === 'place') {
      const place = sessions.getPlace(layer.key);
      if (!place || !LANGUAGE_SETTING.appliesTo.includes(placeKind(place))) return [];
    }
    const setting = listOf(sessions.getLayer(layer).language);
    return setting.length > 0 ? [{ layer, name: layerName(sessions, layer), setting }] : [];
  });
}

/** 层的称呼：层表里的称呼，平台档、平台类型档与场所另写是哪一份（「平台档 onebot」「平台类型档 onebot · group」「场所『…』」） */
function layerName(sessions: SessionManagerService, layer: SessionConfigLayer): TextRef {
  const label = SESSION_LAYERS.find(({ name }) => name === layer.scope)!.label;
  if (layer.scope === 'platform') return t('layerPlatform', { layer: label, platform: layer.platform });
  if (layer.scope === 'type') return t('layerType', { layer: label, platform: layer.platform, type: layer.type });
  if (layer.scope === 'place') {
    const place = sessions.getPlace(layer.key);
    return t('layerPlace', { layer: label, place: place ? placeLabel(place) : layer.key });
  }
  return label;
}

/** 找语言包用的 npm 关键词：先完整标签、再基础语言（ja-JP 是 aalis-lang-ja-jp、aalis-lang-ja） */
function packKeywords(tag: string): string[] {
  const tags = new Set([tag, new Intl.Locale(tag).language]);
  return [...tags].map(each => `aalis-lang-${each.toLowerCase()}`);
}

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

/**
 * 服务进程的系统语言（Node 的 Intl 默认 locale，跟 LANG），规范化过。环境里没有语言信息时（Docker 里没设 LANG、C、POSIX）
 * Node 报 en-US，就是英语；LANG 或 LC_ALL 设成空串时报 und（语言未定），同样当作 en-US
 */
function systemLanguage(): string {
  const [tag] = normalizeLanguages([Intl.DateTimeFormat().resolvedOptions().locale]);
  return tag.split('-')[0] === 'und' ? 'en-US' : tag;
}

/**
 * 读者设的语言（未整理）：子会话跟根会话。根是 owner 会话的与 host 读者一样取全局默认层（会话上存着的旧值不算），根是房间的
 * 按房间的继承链解析，会话不存在的按会话 id 与入口平台解析；会话管理缺席与不是数组的当作没设，元素交给 normalizeLanguages 筛
 */
function settingOf(caps: Caps, audience: Audience): readonly unknown[] {
  if (!caps.sessionManager.present) return [];
  const sessions = caps.sessionManager.use;
  const root = 'sessionId' in audience ? rootOf(sessions, audience.sessionId) : undefined;
  const { language } =
    'sessionId' in audience && root?.kind !== 'owner'
      ? sessions.resolveConfig(root?.id ?? audience.sessionId, audience.platform)
      : sessions.getLayer({ scope: 'defaults' });
  return listOf(language);
}

/** 根会话：沿父会话往上找，父会话已经不在的停在最后一个找得到的；会话不存在时为 undefined */
function rootOf(sessions: SessionManagerService, id: string): SessionInfo | undefined {
  let session = sessions.getSession(id);
  while (session?.parentId) {
    const parent = sessions.getSession(session.parentId);
    if (!parent) break;
    session = parent;
  }
  return session;
}

/** 设置里的语言列表：不是数组的当作没设 */
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

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
