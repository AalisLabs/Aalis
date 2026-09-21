import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer } from '../primitives/services.js';

import type { Resources } from './resources.js';

/** 只观察胜者变化；资源交接、异步撤回全部由 binding 管理。 */
export function watchService<P>(
  services: ServiceContainer,
  events: EventBus,
  resources: Resources,
  name: string,
  changed: (provider: P | undefined) => void,
): void {
  if (resources.lifecycle.disposed) return;
  let current: P | undefined;
  let syncing = false;
  let closed = false;
  const sync = (): void => {
    if (syncing || closed || resources.lifecycle.disposed) return;
    syncing = true;
    try {
      for (;;) {
        const next = services.get<P>(name);
        if (next === current || closed || resources.lifecycle.disposed) break;
        current = next;
        changed(next);
      }
    } finally {
      syncing = false;
    }
  };
  const offs = (['service:registered', 'service:unregistered', 'service:preference-changed'] as const).map(event =>
    events.on(event, service => {
      if (service === name) sync();
    }),
  );
  resources.trackWithdrawal(() => {
    closed = true;
    for (const off of offs) off();
    current = undefined;
    changed(undefined);
  }, `watch:${name}`);
  sync();
}
