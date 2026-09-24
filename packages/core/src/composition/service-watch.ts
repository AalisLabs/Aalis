import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer } from '../primitives/services.js';

import type { Resources } from '../infrastructure/resources.js';

/**
 * 只观察胜者变化；资源交接、异步撤回全部由 binding 管理。`changed` 返回本次换人发起的清理的落定，
 * 汇总后交回事件投递方等待——提供者据此在自己清理之前等到跟随者交接完。
 */
export function watchService<P>(
  services: Pick<ServiceContainer, 'get'>,
  events: EventBus,
  resources: Resources,
  name: string,
  changed: (provider: P | undefined) => PromiseLike<unknown> | undefined,
): void {
  if (resources.disposed) return;
  let current: P | undefined;
  let syncing = false;
  let closed = false;
  const sync = (): Promise<void> | undefined => {
    if (syncing || closed || resources.disposed) return;
    syncing = true;
    const pending: PromiseLike<unknown>[] = [];
    try {
      for (;;) {
        const next = services.get<P>(name);
        if (next === current || closed || resources.disposed) break;
        current = next;
        const settling = changed(next);
        if (settling) pending.push(settling);
      }
    } finally {
      syncing = false;
    }
    return pending.length === 0 ? undefined : Promise.all(pending).then(() => undefined);
  };
  const offs = (['service:registered', 'service:unregistered', 'service:preference-changed'] as const).map(event =>
    events.on(event, service => (service === name ? sync() : undefined)),
  );
  resources.trackWithdrawal(() => {
    closed = true;
    for (const off of offs) off();
    current = undefined;
    changed(undefined);
  }, `watch:${name}`);
  sync();
}
