// ============================================================
// localize.ts — 回应里的文字按全局层的语言渲染
//
// WebUI 的读者是 owner 自己：一律按全局层的语言（i18n 的 { host: true } 读者），日期与时间按服务进程的时区，不看浏览器的
// 语言与时区（会话与场所的语言设置管的是聊天平台上的读者）。
// 最早挂的中间件包住 res.json：值里的文字对象渲染后再发，i18n 缺席或渲染抛错时按原文（抛错只告警一次）。路由里外的 JSON 回应
// （认证的 401 与 403、闸门、未知 API、错误处理）都经过它；不经 res.json 的文字（纯文本的错误、登录页与恢复页、access.txt）
// 用 render。原样数据（插件配置值、schema 的默认值、插件前端的数据）要跳过、Markdown 正文要转义时，路由在 res.json 之前经
// renderWith 交代。
// ============================================================

import { type I18nService, localizeFor, type RenderOptions } from '@aalis/api-i18n';
import type { Logger, ServiceSelection } from '@aalis/core';
import type { Localized, LocalizeSkip } from '@aalis/schema-i18n';
import type express from 'express';

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
  /** 把值里的文字对象按全局层的语言渲染 */
  render<T>(value: T, options?: RenderOptions): Localized<T>;
  /**
   * 全局层的语言链（i18n 的 chainOf），/api/i18n/messages 与页面的 lang 用它。i18n 缺席时为空，取链出错时告警
   * （与渲染共用一次）并为空
   */
  languages(): readonly string[];
}

export function createLocalizer(
  i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>,
  logger: Logger,
): Localizer {
  let warned = false;
  const onError = (err: unknown) => {
    if (warned) return;
    warned = true;
    logger.warn('按全局层的语言渲染出错，按原文发出（之后再出错不再告警）:', err);
  };
  const render = <T>(value: T, options?: RenderOptions) =>
    localizeFor(i18n, value, { host: true }, { ...options, onError });
  return {
    middleware: (_req, res, next) => {
      const send = res.json.bind(res);
      res.json = body => send(render(body, optionsOf.get(res)));
      next();
    },
    render,
    languages: () => {
      if (!i18n.present) return [];
      try {
        return i18n.use.chainOf({ host: true });
      } catch (err) {
        onError(err);
        return [];
      }
    },
  };
}
