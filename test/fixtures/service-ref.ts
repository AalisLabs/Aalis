import type { BoundDoctor, DoctorService } from '../../packages/api-doctor/src/index.js';
import type { Logger, ServiceSelection, ServiceView } from '../../packages/core/src/index.js';
import type { MediaServiceCaps } from '../../packages/plugin-media/src/service.js';

/** 缺席的业务句柄：访问成员即抛错，与真实句柄选不到提供者时一样（then 不转发，可以 await） */
function absent<P>(): P {
  return new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === 'then' || typeof key === 'symbol') return undefined;
        throw Object.assign(new Error('无提供者'), { name: 'ServiceUnavailableError' });
      },
    },
  ) as P;
}

/** 选择层桩：entries 里第一家是选中的那一家，业务句柄就是实例本身；不传即无提供者 */
export function ref<P>(
  entries: (Omit<ServiceView<P>, 'priority'> & { priority?: number })[] = [],
): ServiceSelection<P> {
  return {
    list: () =>
      entries.map((e, i) => ({
        id: e.contextId,
        label: e.label,
        priority: e.priority ?? 0,
        selected: i === 0,
        basis: i === 0 ? 'rank' : undefined,
        use: e.instance,
      })),
    use: entries[0]?.instance ?? absent<P>(),
    of: id => entries.find(e => e.contextId === id)?.instance ?? absent<P>(),
    present: entries.length > 0,
    follow: () => () => {},
  };
}

/** MediaServiceImpl 的能力桩：各服务一律无提供者 */
export function emptyMediaCaps(logger: Logger): MediaServiceCaps {
  return { logger: fixedRef(logger), llm: ref(), asr: ref(), sessionManager: ref(), memory: ref() };
}

/** 只有一家（或缺席）的选择层 */
export function fixedRef<P>(current: P | undefined): ServiceSelection<P> {
  return ref(current === undefined ? [] : [{ instance: current, contextId: 'fixed' }]);
}

/** doctor 选择层替身：没有 doctor，登记的检查项只收下（要验检查项得经真实 App 装上 plugin-doctor） */
export function absentDoctor(): ServiceSelection<BoundDoctor> {
  const bound = Object.assign(Object.create(absent<DoctorService>()) as BoundDoctor, { registerCheck: () => () => {} });
  return { ...ref<BoundDoctor>(), use: bound };
}
