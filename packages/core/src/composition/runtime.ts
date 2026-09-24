import type { AalisEvents } from '../types/events.js';

import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer } from '../primitives/services.js';

export interface ServiceRuntime {
  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly devMode: boolean;
  notify<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): void;
}
