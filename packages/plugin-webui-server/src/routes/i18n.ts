// ============================================================
// routes/i18n.ts — 多语言的两条路由
//
// GET /api/i18n/languages 给有文字可用的语言，前端据此决定显不显示语言切换；GET /api/i18n/messages 给前端自带的字典
// （外壳、契约包、插件前端）补语言包的译文：取贡献点 i18n:pack 建索引，按 ns 与全局默认层的语言链筛，取舍（只补缺、指纹）
// 由前端的 resolveText 做。i18n 缺席时前端按原文显示，两条都回空。
// ============================================================

import type { Contributions } from '@aalis/api-contributions';
import type { I18nService } from '@aalis/api-i18n';
import type { PackedText } from '@aalis/api-webui';
import type { ServiceSelection } from '@aalis/core';
import { indexPacks } from '@aalis/schema-i18n';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import type { Localizer } from '../localize.js';
import { route } from '../route.js';

/** 语言标签的语言部分（zh-Hant-TW → zh）。收的都已规范化（语言链、语言包的语言），不会抛 */
const baseLanguage = (tag: string) => new Intl.Locale(tag).language;

export function registerI18nRoutes(
  expressApp: express.Express,
  deps: {
    i18n: Pick<ServiceSelection<I18nService>, 'present' | 'use'>;
    /** 语言包的来源 */
    contributions: Pick<ServiceSelection<Contributions>, 'present' | 'use'>;
    localizer: Pick<Localizer, 'languages'>;
  },
  gate: RouteGate,
): void {
  route(expressApp, 'GET /api/i18n/languages', gate(), (_req, res) => {
    res.json({ languages: deps.i18n.present ? [...deps.i18n.use.languages()] : [] });
  });

  route(expressApp, 'GET /api/i18n/messages', gate(), (req, res) => {
    const { ns } = req.query;
    if (!deps.i18n.present || typeof ns !== 'string') {
      res.json({ entries: {} });
      return;
    }
    // 链里某种的语言相同的才用得上（zh-TW 读者遇到只有简体时用简体），另留 en：链里都没有时按 en
    const wanted = new Set([...deps.localizer.languages(), 'en'].map(baseLanguage));
    const packs = deps.contributions.present ? deps.contributions.use.collect('i18n:pack').map(({ spec }) => spec) : [];
    const index = indexPacks(packs);
    const entries: Record<string, Record<string, PackedText[]>> = {};
    for (const name of new Set(ns.split(','))) {
      const keys: Record<string, PackedText[]> = {};
      for (const [key, candidates] of index.get(name) ?? []) {
        const kept = candidates.filter(({ language }) => wanted.has(baseLanguage(language)));
        if (kept.length > 0) keys[key] = kept;
      }
      if (Object.keys(keys).length > 0) entries[name] = keys;
    }
    res.json({ entries });
  });
}
