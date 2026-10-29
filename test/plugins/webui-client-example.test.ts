import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 示例前端（plugin-webui-client-example）是一页静态 HTML，没有脚本：中英两段都写在页面里，各带 class，按 webui-server
// 改写的 <html lang> 用样式只显示一段。标签页标题不用翻译。
// ════════════════════════════════════════════════════════════

const html = readFileSync(
  join(import.meta.dirname, '../../packages/plugin-webui-client-example/src/index.html'),
  'utf-8',
);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 带这个 class 的 <div> 里的内容 */
const section = (lang: string) => html.match(new RegExp(`<div class="${lang}"[^>]*>([\\s\\S]*?)</div>`))?.[1] ?? '';

describe('示例前端', () => {
  it('中英两段都在、各带 class，样式按 <html lang> 藏掉另一段：中文段是原文，英文段没有中日韩文字；标题不用翻译', () => {
    expect(section('zh')).toContain('你正在看「第二前端」');
    expect(section('en')).toContain('second frontend');
    expect(CJK.test(section('en'))).toBe(false);
    expect(html).toContain('html:lang(zh) .en, html:not(:lang(zh)) .zh { display: none; }');
    expect(html.match(/<title>(.*)<\/title>/)?.[1]).toBe('Aalis · webui-client-example');
  });
});
