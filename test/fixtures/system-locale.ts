import { vi } from 'vitest';

/**
 * 在 run 期间把 Intl 的默认 locale（进程的系统语言）固定成 locale，其余解析结果照真的。
 * create-aalis 的 systemLanguage 在调用时取系统语言：把调用放进 run 里即可
 */
export async function withSystemLocale<T>(locale: string, run: () => Promise<T>): Promise<T> {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
  spy.mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), locale };
  });
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}
