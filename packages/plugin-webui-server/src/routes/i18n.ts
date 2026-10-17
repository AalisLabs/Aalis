// ============================================================
// routes/i18n.ts — 多语言的两条路由
//
// GET /api/i18n/languages 给有文字可用的语言（供可选项与第三方客户端用；第一方前端只读后两样）、全局默认层的语言链与服务
// 进程的时区（前端的文字、格式与时间按它们，不读浏览器的语言与时区；后两样另写进前端入口的页面，见 interfaceLanguage）；
// GET /api/i18n/messages 给前端自带的字典
// （外壳、契约包、插件前端）补语言包的译文：取贡献点 i18n:pack 建索引，按 ns 与全局默认层的语言链筛，取舍（只补缺、指纹）
// 由前端的 resolveText 做。i18n 缺席时前端按原文显示，语言、语言链与补充都是空的，时区照给。
// ============================================================

import type { Contributions } from '@aalis/api-contributions';
import type { I18nService } from '@aalis/api-i18n';
import type { PackedText, PageLanguage } from '@aalis/api-webui';
import type { ServiceSelection } from '@aalis/core';
import { indexPacks } from '@aalis/schema-i18n';
import type express from 'express';
import type { RouteGate } from '../gate.js';
import type { Localizer } from '../localize.js';
import { route } from '../route.js';

/** 语言标签的语言部分（zh-Hant-TW → zh）。收的都已规范化（语言链、语言包的语言），不会抛 */
const baseLanguage = (tag: string) => new Intl.Locale(tag).language;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 服务进程的时区。环境变量 TZ 写成 POSIX 串（CST-8）或文件路径（:/etc/localtime）时 Node 取不到时区名（undefined，也见过
 * Etc/Unknown），进程的本地时间照样带着那个偏移：按现在的偏移写成 IANA 的 Etc/GMT±N（这一组的符号与偏移相反，东八区是
 * Etc/GMT-8），不是整点时写 ±HH:MM，偏移为 0 是 UTC。这样写不含夏令时的切换，只与进程现在的偏移一致
 */
function processTimeZone(): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (name !== undefined && name !== 'Etc/Unknown') return name;
  const east = -new Date().getTimezoneOffset();
  if (east === 0) return 'UTC';
  const minutes = Math.abs(east);
  if (minutes % 60 === 0) return `Etc/GMT${east > 0 ? '-' : '+'}${minutes / 60}`;
  return `${east > 0 ? '+' : '-'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** 界面的语言：全局默认层的语言链与服务进程的时区。GET /api/i18n/languages 回它，SPA 兜底也写进前端入口的页面 */
export const interfaceLanguage = (localizer: Pick<Localizer, 'languages'>): PageLanguage => ({
  chain: [...localizer.languages()],
  timeZone: processTimeZone(),
});

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
    res.json({
      languages: deps.i18n.present ? [...deps.i18n.use.languages()] : [],
      ...interfaceLanguage(deps.localizer),
    });
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
