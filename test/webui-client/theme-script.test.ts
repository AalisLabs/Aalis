// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES, DEFAULT_THEMES } from '../../packages/api-webui/src/index.js';

// 首帧主题脚本：在打包的脚本之前同步执行，按存着的外观选择写上 <html data-theme>；跟随系统时系统切换深浅，
// 页面跟着换。读不到存储、存着的主题不在了或没写主题时按默认：深色用偏中性深色，浅色用偏中性浅色。
// 页面头部在它之前内联了各内置主题的规则，这里照样摆上（只要有颜色令牌）

const SCRIPT = readFileSync(join(import.meta.dirname, '../../packages/plugin-webui-client/public/theme.js'), 'utf-8');

/** 假的系统深浅：change 时通知脚本登记的监听 */
function systemScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => {
      expect(media).toBe('(prefers-color-scheme: dark)');
      return query;
    }),
  );
  return {
    set(next: boolean) {
      dark = next;
      for (const listener of listeners) listener();
    },
  };
}

const run = () => new Function(SCRIPT)();
const theme = () => document.documentElement.dataset.theme;

const rules = document.createElement('style');
rules.textContent = Object.keys(BUILTIN_THEMES)
  .map(id => `:root[data-theme="${id}"]{--color-bg:#000}`)
  .join('\n');
document.head.append(rules);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('首帧主题脚本', () => {
  it('没存过时跟随系统，用默认的深浅主题；系统切换时跟着换', () => {
    const scheme = systemScheme(true);
    run();
    expect(theme()).toBe(DEFAULT_THEMES.dark);
    scheme.set(false);
    expect(theme()).toBe(DEFAULT_THEMES.light);
    expect(Object.keys(BUILTIN_THEMES)).toEqual(expect.arrayContaining([theme()]));
  });

  it('跟随系统时按存着的「深色用哪个」「浅色用哪个」取', () => {
    localStorage.setItem(
      'aalis.appearance',
      JSON.stringify({ follow: true, dark: 'aalis-dark', light: 'brand-light' }),
    );
    const scheme = systemScheme(false);
    run();
    expect(theme()).toBe('brand-light');
    scheme.set(true);
    expect(theme()).toBe('aalis-dark');
  });

  it('关掉跟随系统时直接用选定的主题，系统切换不影响', () => {
    localStorage.setItem('aalis.appearance', JSON.stringify({ follow: false, theme: 'neutral-light' }));
    const scheme = systemScheme(true);
    run();
    expect(theme()).toBe('neutral-light');
    scheme.set(false);
    expect(theme()).toBe('neutral-light');
  });

  it('存着的主题不在了，或关掉跟随却没写主题：按系统深浅用默认的', () => {
    localStorage.setItem('aalis.appearance', JSON.stringify({ follow: false, theme: 'old-name' }));
    systemScheme(true);
    run();
    expect(theme()).toBe(DEFAULT_THEMES.dark);

    localStorage.setItem('aalis.appearance', JSON.stringify({ follow: false }));
    systemScheme(false);
    run();
    expect(theme()).toBe(DEFAULT_THEMES.light);

    localStorage.setItem('aalis.appearance', JSON.stringify({ follow: true, dark: 'gone-dark' }));
    systemScheme(true);
    run();
    expect(theme()).toBe(DEFAULT_THEMES.dark);
  });

  it('存坏了或存储不可用时按默认', () => {
    systemScheme(false);
    localStorage.setItem('aalis.appearance', '{坏');
    run();
    expect(theme()).toBe(DEFAULT_THEMES.light);

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    systemScheme(true);
    run();
    expect(theme()).toBe(DEFAULT_THEMES.dark);
  });
});
