// ============================================================
// localize.ts — 回应里的文字按读者语言渲染
//
// 读者的语言先看 cookie aalis-lang（`|` 分隔，靠前的优先）：链里要有一项按语言部分对得上有文字可用的语言（zh 命中 zh-CN），
// 都对不上（选过的语言包卸了）当作没给；没给再看 Accept-Language，它也给不出语言（没有或全不合法）时链为空，i18n 按全局
// 默认层。两处经同一个解析：按 q 排，再经 normalizeLanguages 剔除无效的标签、规范化、限条数，不按可用语言筛（匹配交给
// 渲染）；时区取 cookie aalis-tz。
// 最早挂的中间件包住 res.json：值里的文字对象按读者渲染后再发，i18n 缺席或渲染抛错时按原文（抛错只告警一次）。路由里外的
// JSON 回应（认证的 401 与 403、闸门、未知 API、错误处理）都经过它；不经 res.json 的文字（纯文本的错误、登录页与恢复页）用
// render，宿主自己写出的（access.txt）用 host，按全局默认层。渲染过的回应都带 Vary: Cookie, Accept-Language。原样数据（插件
// 配置值、schema 的默认值、插件前端的数据）要跳过、Markdown 正文要转义时，路由在 res.json 之前经 renderWith 交代。
// ============================================================

import type { IncomingMessage } from 'node:http';
import { type I18nService, type LanguageInfo, localizeFor, type RenderOptions } from '@aalis/api-i18n';
import type { Logger, ServiceSelection } from '@aalis/core';
import { type Localized, type LocalizeSkip, normalizeLanguages } from '@aalis/schema-i18n';
import type express from 'express';
import { parseCookieValue } from './auth.js';

const LANGUAGE_COOKIE = 'aalis-lang';
const TIME_ZONE_COOKIE = 'aalis-tz';

type Request = Pick<IncomingMessage, 'headers'>;

/**
 * cookie 的 `zh-CN|en` 与 Accept-Language 的 `zh-CN,en;q=0.9` 同一个解析：q 不是正数的去掉（q=0 是明确不要），按 q 从高到低
 * 稳定地排（cookie 不带 q，照写的先后），再经 normalizeLanguages（剔除不合法的标签，规范化、去重，限条数）
 */
function parseLanguages(raw: string | undefined): string[] {
  const items = (raw ?? '').split(/[|,]/).map(part => {
    const [tag, ...params] = part.split(';').map(piece => piece.trim());
    const q = params.find(param => param.startsWith('q='));
    return { tag, weight: q === undefined ? 1 : Number(q.slice(2)) };
  });
  const tags = items
    .filter(({ weight }) => weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map(({ tag }) => tag);
  return normalizeLanguages(tags);
}

/** 语言标签的语言部分（zh-Hant-TW → zh）。收的都已规范化（读者的链、有文字可用的语言、语言包的语言），不会抛 */
export const baseLanguage = (tag: string) => new Intl.Locale(tag).language;

const optionsOf = new WeakMap<express.Response, RenderOptions>();

/** 交代这次回应的渲染选项：要跳过的原样数据、Markdown 正文的转义。在 res.json 之前调 */
export function renderWith(res: express.Response, options: RenderOptions): void {
  optionsOf.set(res, options);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * schema（插件配置、核心配置、动作的输入字段）里的 default 是取值，不是文字：跳过它们，形如文字对象的默认值原样交出，表单读回
 * 再保存时不被改写成字符串。字段、分组、数组与元素字段按对象身份认，不按键名（配置里可能有名叫 default 的字段）
 */
export function skipSchemaDefaults(schemas: Iterable<unknown>): LocalizeSkip {
  const entries = new Set<object>();
  const collect = (schema: unknown) => {
    if (!isRecord(schema)) return;
    for (const entry of Object.values(schema)) {
      if (!isRecord(entry) || entries.has(entry)) continue;
      entries.add(entry);
      collect(entry.fields);
      collect(entry.items);
    }
  };
  for (const schema of schemas) collect(schema);
  return (key, parent) => key === 'default' && entries.has(parent);
}

export interface Localizer {
  /** 最早挂上：包住 res.json，渲染后再发 */
  middleware: express.RequestHandler;
  /** 把值里的文字对象按这次请求的读者渲染，回应带上 Vary */
  render<T>(req: Request, res: express.Response, value: T, options?: RenderOptions): Localized<T>;
  /** 按全局默认层渲染：宿主自己写出的文字（access.txt） */
  host<T>(value: T): Localized<T>;
  /**
   * 读者的语言链（i18n 的 chainOf），交给插件的 PageContext；chain 是另给的链（写法同 cookie），不给时按这次请求的读者。
   * i18n 缺席时为空，取链出错时告警（与渲染共用一次）并为空
   */
  languages(req: Request, chain?: string): readonly string[];
  /** 有文字可用的语言，页面上的语言切换列它们；i18n 缺席时为空 */
  offered(): readonly LanguageInfo[];
}

export function createLocalizer(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  logger: Logger,
): Localizer {
  const offered = () => (i18n.present ? i18n.use.languages() : []);
  let warned = false;
  const onError = (err: unknown) => {
    if (warned) return;
    warned = true;
    logger.warn('按读者语言渲染出错，按原文发出（之后再出错不再告警）:', err);
  };

  /** cookie 的链里有一项按语言部分对得上有文字可用的语言才算给了；i18n 缺席时读者的链用不上，看哪一处都一样 */
  const usable = (chain: readonly string[]) => {
    if (chain.length === 0) return false;
    const bases = new Set(offered().map(({ tag }) => baseLanguage(tag)));
    return chain.some(tag => bases.has(baseLanguage(tag)));
  };

  /** 这次请求的读者：cookie 给不出能用的语言时看 Accept-Language，它也给不出语言时链为空（按全局默认层） */
  const readerOf = (req: Request): { languages: string[]; timeZone?: string } => {
    const { cookie } = req.headers;
    const chosen = parseLanguages(parseCookieValue(cookie, LANGUAGE_COOKIE));
    const languages = usable(chosen) ? chosen : parseLanguages(req.headers['accept-language']);
    return { languages, timeZone: parseCookieValue(cookie, TIME_ZONE_COOKIE) };
  };

  const render = <T>(req: Request, res: express.Response, value: T, options?: RenderOptions) => {
    res.vary('Cookie').vary('Accept-Language');
    return localizeFor(i18n, value, readerOf(req), { ...options, onError });
  };
  return {
    middleware: (req, res, next) => {
      const send = res.json.bind(res);
      res.json = body => send(render(req, res, body, optionsOf.get(res)));
      next();
    },
    render,
    host: value => localizeFor(i18n, value, { host: true }, { onError }),
    languages: (req, chain) => {
      if (!i18n.present) return [];
      try {
        return i18n.use.chainOf(chain === undefined ? readerOf(req) : { languages: parseLanguages(chain) });
      } catch (err) {
        onError(err);
        return [];
      }
    },
    offered,
  };
}
