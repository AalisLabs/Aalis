import { vi } from 'vitest';

/**
 * 在 run 期间把 Intl 的默认 locale（服务进程的系统语言）固定成 locale，其余解析结果照真的。
 * plugin-i18n 的「跟随系统」在激活时取一次系统语言：把启动放进 run 里即可
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
