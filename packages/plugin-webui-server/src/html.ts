// ============================================================
// html.ts — 服务端直出的页面（登录页、换前端的恢复页）与前端入口共用的几样
//
// 两页都按全局层的语言输出：文字在服务端渲染好写进 HTML，外链脚本要的文字放进 texts 块（type 为 application/json，
// 不执行，文档级 CSP 不用动）。页面上不设语言切换：登录之前改不了全局设置。前端的入口同样在服务端写好 <html lang>，首帧的
// 字体就按全局层的语言选；界面的语言（语言链与服务进程的时区）照 texts 块的写法放进语言块，前端首帧按它画、不等往返。
// ============================================================

import { PAGE_LANGUAGE_ID, type PageLanguage } from '@aalis/api-webui';
import { normalizeLanguages } from '@aalis/schema-i18n';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 给页面里的脚本读的数据块：`<` 写成 `\u003c`，值里的 `</script>` 结束不了这个块 */
function jsonBlock(id: string, value: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
}

/** 外链脚本要的文字 */
export const textsBlock = (texts: Readonly<Record<string, string>>): string => jsonBlock('texts', texts);

/**
 * 前端入口写上界面的语言：`<html>` 写页面的语言 lang（入口文件里写的 lang 换掉，没写的加上），`</head>` 前放语言块。
 * 没有 `<html>` 或 `</head>` 时那一样不写（没有语言块的前端取 GET /api/i18n/languages）
 */
export function withPageLanguage(html: string, lang: string, language: PageLanguage): string {
  return html
    .replace(/<html\b([^>]*)>/i, (_tag, attributes: string) => {
      const rest = attributes.replace(/\s+lang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i, '');
      return `<html lang="${escapeHtml(lang)}"${rest}>`;
    })
    .replace(/<\/head>/i, tag => jsonBlock(PAGE_LANGUAGE_ID, language) + tag);
}

/**
 * 页面实际用的语言，写进 `<html lang>`：取字典键 pageLanguage 渲染出的译文。第三方语言包可以把它译成任意字符串，规范化
 * 不了时用全局层语言链的第一项；链为空（i18n 缺席）时渲染的是原文 zh-CN，本来就规范化得了
 */
export function pageLanguageOf(rendered: string, chain: readonly string[]): string {
  return normalizeLanguages([rendered])[0] ?? chain[0];
}
