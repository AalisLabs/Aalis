// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGE_SWITCH_SCRIPT, languageSwitch } from '../../packages/plugin-webui-server/src/html.js';

// 登录页与恢复页上的语言切换：选中的语言排到 cookie aalis-lang 的最前面，其余照原来的先后，再刷新。
// jsdom 不支持整页加载，刷新以「Not implemented: navigation」的报错看出

const LANGUAGES = [
  { tag: 'en', name: 'English' },
  { tag: 'ja', name: '日本語' },
  { tag: 'zh-CN', name: '中文（中国）' },
];

describe('语言切换', () => {
  it('选中的语言排到 cookie 的最前面，其余照原来的先后，再刷新', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom 没有 Cookie Store，先放一个已有的语言链
    document.cookie = `aalis-lang=${encodeURIComponent('zh-CN|en|ja')}; Path=/`;
    document.body.innerHTML = languageSwitch(LANGUAGES, 'zh-CN', '语言');
    new Function(LANGUAGE_SWITCH_SCRIPT)();
    const select = document.getElementById('lang') as HTMLSelectElement;
    expect(select.value).toBe('zh-CN');
    select.value = 'en';
    select.dispatchEvent(new Event('change'));
    expect(decodeURIComponent(/aalis-lang=([^;]*)/.exec(document.cookie)?.[1] ?? '')).toBe('en|zh-CN|ja');
    expect(errors.mock.calls.some(call => String(call[0]).includes('navigation'))).toBe(true);
  });

  it('cookie 的值解不开时当作空链，与服务端一致：照样写入选中的语言并刷新', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom 没有 Cookie Store，放一个编码坏了的值
    document.cookie = 'aalis-lang=%E0; Path=/';
    document.body.innerHTML = languageSwitch(LANGUAGES, 'zh-CN', '语言');
    new Function(LANGUAGE_SWITCH_SCRIPT)();
    const select = document.getElementById('lang') as HTMLSelectElement;
    select.value = 'ja';
    select.dispatchEvent(new Event('change'));
    expect(/aalis-lang=([^;]*)/.exec(document.cookie)?.[1]).toBe('ja');
    expect(errors.mock.calls.some(call => String(call[0]).includes('navigation'))).toBe(true);
  });
});
