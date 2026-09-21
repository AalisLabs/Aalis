import type { AalisEvents } from '../types/events.js';

import type { ContributionRegistry } from '../primitives/contributions.js';
import type { EventBus } from '../primitives/events.js';
import type { HookRegistry } from '../primitives/hooks.js';
import type { ServiceContainer } from '../primitives/services.js';

export interface CapabilityRuntime {
  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly hooks: HookRegistry;
  readonly contributions: ContributionRegistry;
  readonly devMode: boolean;
  notify<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): void;
}
