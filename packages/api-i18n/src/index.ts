// ============================================================
// @aalis/api-i18n — 多语言契约
//
// 出口（WebUI、会话协议、网关等把文字交给人看的地方）按读者的语言渲染文字对象：i18n 服务在场时交给它的 render
// （读者的语言链、语言包），缺席时按原文语言渲染。出口统一写 localizeFor(caps.i18n, 值, 读者, { skip, escape })。
// 语言包经贡献点 i18n:pack 交付。默认提供者：@aalis/plugin-i18n。
// ============================================================

import type {} from '@aalis/api-contributions'; // declaration merging 锚点（下方 ContributionPointMap 增强）
import { defineService, type ServiceSelection } from '@aalis/core';
import { type LanguagePack, type Localized, type LocalizeSkip, localize, resolveSource } from '@aalis/schema-i18n';

/**
 * 读者：按谁的语言渲染。languages 直接给语言链（如 WebUI 按 cookie 或 Accept-Language 解析出的）；sessionId 取会话
 * 设置的 language（按继承链解析，platform 是入口平台）；host 取全局默认层的设置（access.txt、插件加载后宿主的输出）。
 * timeZone 用于日期与时间，缺省用进程时区
 */
export type Audience =
  | { languages: readonly string[]; timeZone?: string }
  | { sessionId: string; platform?: string; timeZone?: string }
  | { host: true };

/** render 的选项：escape 把字符串参数按 Markdown 转义；skip 为真的属性不进（原样数据，见 schema-i18n 的 localize） */
export interface RenderOptions {
  escape?: 'markdown';
  skip?: LocalizeSkip;
}

/** 一种有文字可用的语言：tag 是规范化的语言标签，name 是该语言的自称（English、日本語），取不到时为 tag */
export interface LanguageInfo {
  tag: string;
  name: string;
}

export interface I18nService {
  /** 把值里的文字对象按读者的语言链渲染成字符串，其余原样，没有文字对象的子树不复制 */
  render<T>(value: T, audience: Audience, opts?: RenderOptions): Localized<T>;
  /** 读者的语言链：规范化、去重，有条数上限；哪一层都没设时按 ['en'] */
  chainOf(audience: Audience): readonly string[];
  /** 有文字可用的语言：目录里各字典的原文语言与译文语言、语言包的语言，按 tag 排序，带自称 */
  languages(): readonly LanguageInfo[];
}

export const i18n = defineService<I18nService>('i18n');

declare module '@aalis/api-contributions' {
  interface ContributionPointMap {
    /** 语言包：给字典补它没有的语言，形状与取舍见 schema-i18n 的 LanguagePack 与 indexPacks */
    'i18n:pack': LanguagePack;
  }
}

/**
 * 出口的统一写法：i18n 在场时交给 render，缺席时按原文语言渲染（schema-i18n 的 resolveSource，带读者的时区与转义），
 * 两支同一个 skip。日志与交给模型的文字不走这里，用 toSource
 */
export function localizeFor<T>(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  value: T,
  audience: Audience,
  opts: RenderOptions = {},
): Localized<T> {
  if (i18n.present) return i18n.use.render(value, audience, opts);
  const timeZone = 'timeZone' in audience ? audience.timeZone : undefined;
  return localize(value, text => resolveSource(text, { escape: opts.escape, timeZone }), opts.skip);
}
