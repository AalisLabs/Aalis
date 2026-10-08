import { vi } from 'vitest';

/**
 * jsdom 没有 matchMedia：按给定的窗口宽度（像素，1em 按 16px）回答 min-width、max-width 两种 em 断点、是否触屏
 * （pointer: coarse）与系统深浅（prefers-color-scheme: dark，默认深色）。窗口宽度在用例里改了以后，下一次查询就按新的回答；
 * 系统深浅改了时通知登记了 change 的查询
 */
export function stubViewport(
  width: number,
  options: { coarse?: boolean; dark?: boolean } = {},
): { resize(next: number): void; scheme(dark: boolean): void } {
  let em = width / 16;
  let dark = options.dark ?? true;
  const schemeListeners = new Set<() => void>();
  const evaluate = (query: string) =>
    query.split(/\s+and\s+/).every(part => {
      const min = /^\(min-width:\s*([\d.]+)em\)$/.exec(part);
      if (min) return em >= Number(min[1]);
      const max = /^\(max-width:\s*([\d.]+)em\)$/.exec(part);
      if (max) return em <= Number(max[1]);
      if (part === '(pointer: coarse)') return options.coarse ?? false;
      if (part === '(prefers-color-scheme: dark)') return dark;
      throw new Error(`没有模拟的媒体查询：${part}`);
    });
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return evaluate(query);
    },
    addEventListener(_type: string, listener: () => void) {
      if (query === '(prefers-color-scheme: dark)') schemeListeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      schemeListeners.delete(listener);
    },
  }));
  return {
    resize(next) {
      em = next / 16;
    },
    scheme(next) {
      dark = next;
      for (const listener of [...schemeListeners]) listener();
    },
  };
}

/** 按平台取快捷键：Mac 上是 ⌘，其余是 Ctrl */
export function stubPlatform(platform: 'MacIntel' | 'Win32' | 'Linux x86_64'): void {
  vi.spyOn(Navigator.prototype, 'platform', 'get').mockReturnValue(platform);
}

/** 组件测试里页面的默认地址（vitest 的 jsdom 环境的缺省） */
export const DEFAULT_PAGE_URL = 'http://localhost:3000/';

/** 换掉页面的地址（location）：vitest 把 JSDOM 实例挂在 globalThis.jsdom 上，经它的 reconfigure 换；用完换回 DEFAULT_PAGE_URL */
export function setPageUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom.reconfigure({ url });
}
