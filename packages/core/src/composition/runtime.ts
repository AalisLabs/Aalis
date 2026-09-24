import type { AalisEvents } from '../types/events.js';

import type { ContributionRegistry } from '../primitives/contributions.js';
import type { EventBus } from '../primitives/events.js';
import type { HookRegistry } from '../primitives/hooks.js';
import type { ServiceContainer } from '../primitives/services.js';

export interface ServiceRuntime {
  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly hooks: HookRegistry;
  readonly contributions: ContributionRegistry;
  readonly devMode: boolean;
  /** 不抛不拒；返回投递落定，调用方按需等待（下线通知据此等跟随者交接） */
  notify<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void>;
}
