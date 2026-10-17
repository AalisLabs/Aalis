// ============================================================
// @aalis/api-i18n — 多语言契约
//
// 出口（WebUI、会话协议、网关等把文字交给人看的地方）按读者的语言渲染文字对象：i18n 服务在场时交给它的 render
// （读者的语言链、语言包），缺席时与 render 抛错时按原文语言渲染。出口统一写
// localizeFor(caps.i18n, 值, 读者, { skip, escape, onError })。模型生成、给人看的文字（会话标题、摘要等）的输出语言写进
// 提示词，统一取 outputLanguageFor(caps.i18n, 读者, 原文语言)。
// 语言包经贡献点 i18n:pack 交付。默认提供者：@aalis/plugin-i18n。
// ============================================================

import type {} from '@aalis/api-contributions'; // declaration merging 锚点（下方 ContributionPointMap 增强）
import { defineService, type ServiceSelection } from '@aalis/core';
import {
  type LanguagePack,
  type Localized,
  type LocalizeSkip,
  localize,
  resolveSource,
  selfName,
} from '@aalis/schema-i18n';

/**
 * 读者：按谁的语言渲染。sessionId 取会话设置的 language（按继承链解析，platform 是入口平台），聊天平台上的读者用它；会话种类
 * 是 owner 的（WebUI 与终端的会话）与 host 一样。host 取全局默认层的设置，owner 自己看的出口（WebUI、会话协议、终端、
 * access.txt）用它。语言只从这里来，出口不自己找语言来源；日期与时间一律按服务进程的时区
 */
export type Audience = { sessionId: string; platform?: string } | { host: true };

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
  /**
   * 读者的语言链：规范化、去重，有条数上限；哪一层都没设时按 ['en']。给人看的文字交文字对象即可，不必看它；按语言生成文字以外的
   * 东西（出图、调外部接口）时用，WebUI 页面的读者是 { host: true }
   */
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

/** {@link localizeFor} 的选项：渲染选项之外，出口自己接 render 抛出的错 */
export interface LocalizeOptions extends RenderOptions {
  /**
   * i18n 在场但 render 抛错时调用，收到抛出的错；这次按原文语言渲染，同缺席。出口在这里告警（一个出口告警一次就够），
   * 要发出的文字不因此丢失
   */
  onError(err: unknown): void;
}

/**
 * 出口的统一写法：i18n 在场时交给 render，缺席时与 render 抛错时按原文语言渲染（schema-i18n 的 resolveSource，带转义），
 * 各支同一个 skip。日志与交给模型的文字不走这里，用 toSource
 */
export function localizeFor<T>(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  value: T,
  audience: Audience,
  { onError, ...opts }: LocalizeOptions,
): Localized<T> {
  if (i18n.present) {
    try {
      return i18n.use.render(value, audience, opts);
    } catch (err) {
      onError(err);
    }
  }
  return localize(value, text => resolveSource(text, { escape: opts.escape }), opts.skip);
}

/**
 * 写给模型的输出语言：模型生成、给人看的文字（会话标题、摘要、档案事实）用哪种语言写，写成「自称（标签）」，如
 * 「日本語 (日本)（ja-JP）」。i18n 在场时取读者语言链的第一项（可以是跟随系统解析出的、没有语言包的语言，模型照样能写），
 * 缺席时用 source（调用方提示词原文的语言）。提示词里不写死语言，也不让模型跟对话所用的语言
 */
export function outputLanguageFor(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  audience: Audience,
  source: string,
): string {
  const [tag = source] = i18n.present ? i18n.use.chainOf(audience) : [];
  return `${selfName(tag)}（${tag}）`;
}
