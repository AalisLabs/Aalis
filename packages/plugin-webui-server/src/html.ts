// ============================================================
// html.ts — 服务端直出的页面（登录页、换前端的恢复页）共用的几样
//
// 两页都按读者语言输出：文字在服务端渲染好写进 HTML，外链脚本要的文字放进 texts 块（type 为 application/json，
// 不执行，文档级 CSP 不用动）。可用语言不止一种时右上角给语言切换：脚本把选中的语言排到 cookie aalis-lang 的最前面，
// 刷新页面，不加 ?lang=。
// ============================================================

import type { LanguageInfo } from '@aalis/api-i18n';
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
 * 页面实际用的语言，写进 `<html lang>`，语言切换据它选中：取字典键 pageLanguage 渲染出的译文。第三方语言包可以把它译成
 * 任意字符串，规范化不了时用读者语言链的第一项，链也是空的（i18n 缺席）用原文语言 zh-CN
 */
export function pageLanguageOf(rendered: string, chain: readonly string[]): string {
  return normalizeLanguages([rendered])[0] ?? chain[0] ?? 'zh-CN';
}

/** 语言切换：可用语言不到两种时不给；current 是页面实际用的语言 */
export function languageSwitch(languages: readonly LanguageInfo[], current: string, label: string): string {
  if (languages.length < 2) return '';
  const options = languages.map(
    ({ tag, name }) =>
      `<option value="${escapeHtml(tag)}"${tag === current ? ' selected' : ''}>${escapeHtml(name)}</option>`,
  );
  return `<select id="lang" aria-label="${escapeHtml(label)}">${options.join('')}</select>`;
}

/**
 * 语言切换的脚本，拼在两页的脚本前面：选中的语言排到 cookie aalis-lang 的最前面，其余照原来的先后（与 WebUI 前端同一条规则：
 * Path=/、一年、SameSite=Lax、不加 HttpOnly，https 下加 Secure），再刷新。cookie 的值解不开时当作空链，与服务端一致
 */
export const LANGUAGE_SWITCH_SCRIPT = `(function () {
  var select = document.getElementById('lang');
  if (!select) return;
  select.addEventListener('change', function () {
    var match = /(?:^|;\\s*)aalis-lang=([^;]*)/.exec(document.cookie);
    var chain = [];
    try {
      if (match) chain = decodeURIComponent(match[1]).split('|');
    } catch (e) {}
    var value = [select.value].concat(chain.filter(function (tag) { return tag && tag !== select.value; })).join('|');
    document.cookie = 'aalis-lang=' + encodeURIComponent(value) + '; Path=/; Max-Age=31536000; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
    location.reload();
  });
})();
`;
