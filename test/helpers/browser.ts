import { vi } from 'vitest';

/**
 * jsdom 没有 matchMedia：按给定的窗口宽度（像素，1em 按 16px）回答 min-width、max-width 两种 em 断点，
 * 以及是否触屏（pointer: coarse）。窗口宽度在用例里改了以后，下一次查询就按新的回答
 */
export function stubViewport(width: number, options: { coarse?: boolean } = {}): { resize(next: number): void } {
  let em = width / 16;
  const evaluate = (query: string) =>
    query.split(/\s+and\s+/).every(part => {
      const min = /^\(min-width:\s*([\d.]+)em\)$/.exec(part);
      if (min) return em >= Number(min[1]);
      const max = /^\(max-width:\s*([\d.]+)em\)$/.exec(part);
      if (max) return em <= Number(max[1]);
      if (part === '(pointer: coarse)') return options.coarse ?? false;
      throw new Error(`没有模拟的媒体查询：${part}`);
    });
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return evaluate(query);
    },
    addEventListener() {},
    removeEventListener() {},
  }));
  return {
    resize(next) {
      em = next / 16;
    },
  };
}

/** 按平台取快捷键：Mac 上是 ⌘，其余是 Ctrl */
export function stubPlatform(platform: 'MacIntel' | 'Win32' | 'Linux x86_64'): void {
  vi.spyOn(Navigator.prototype, 'platform', 'get').mockReturnValue(platform);
}
