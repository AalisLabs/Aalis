// ============================================================
// html.ts — 服务端直出的页面（登录页、换前端的恢复页）共用的几样
//
// 两页都按全局默认层的语言输出：文字在服务端渲染好写进 HTML，外链脚本要的文字放进 texts 块（type 为 application/json，
// 不执行，文档级 CSP 不用动）。页面上不设语言切换：登录之前改不了全局设置。
// ============================================================

import { normalizeLanguages } from '@aalis/schema-i18n';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 外链脚本要的文字：`<` 写成 `\u003c`，文字里的 `</script>` 结束不了这个块 */
export function textsBlock(texts: Readonly<Record<string, string>>): string {
  const json = JSON.stringify(texts).replace(/</g, '\\u003c');
  return `<script type="application/json" id="texts">${json}</script>`;
}

/**
 * 页面实际用的语言，写进 `<html lang>`：取字典键 pageLanguage 渲染出的译文。第三方语言包可以把它译成任意字符串，规范化
 * 不了时用全局默认层语言链的第一项，链也是空的（i18n 缺席）用原文语言 zh-CN
 */
export function pageLanguageOf(rendered: string, chain: readonly string[]): string {
  return normalizeLanguages([rendered])[0] ?? chain[0] ?? 'zh-CN';
}
