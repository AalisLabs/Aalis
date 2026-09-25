import type { Logger, ServiceRef, ServiceView } from '../../packages/core/src/index.js';
import type { MediaServiceCaps } from '../../packages/plugin-media/src/service.js';

/** 按激活绑定的服务桩：按 entries 解析当前胜者（取首个）与全量提供者；不传即无提供者 */
export function ref<P>(entries: ServiceView<P>[] = []): ServiceRef<P> {
  return {
    current: entries[0]?.instance,
    require: () => {
      const provider = entries[0]?.instance;
      if (provider === undefined) throw new Error('无提供者');
      return provider;
    },
    all: () => entries,
    follow: () => () => {},
  };
}

/** MediaServiceImpl 的能力桩：各服务一律无提供者 */
export function emptyMediaCaps(logger: Logger): MediaServiceCaps {
  return { logger, llm: ref(), asr: ref(), sessionManager: ref(), memory: ref() };
}

/** 固定提供者（或缺席）的服务引用：只给 `.current`，没有提供者列表 */
export function fixedRef<P>(current: P | undefined): ServiceRef<P> {
  return {
    current,
    require: () => {
      if (!current) throw new Error('本夹具未提供该服务');
      return current;
    },
    all: () => [],
    follow: () => () => {},
  };
}
