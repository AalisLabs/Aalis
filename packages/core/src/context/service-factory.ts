import { type ScopedProvider, scopedProvider } from '../primitives/services.js';

import type { ModuleHandle } from './builtins.js';
import type { PluginDefinition } from './definition.js';
import type { Logger } from './logger.js';

/** Factory input for one consumer activation; contains no registry or activation implementation. */
export interface ServiceScope {
  readonly id: string;
  /** Opaque resource identity; display ids may be reused. */
  readonly identity: symbol;
  readonly logger: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly closed: boolean;
  track(off: () => unknown, label?: string): () => void;
  onDrain(fn: () => void | Promise<void>, label?: string): () => void;
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
  module(definition: PluginDefinition, config?: Record<string, unknown>): Promise<ModuleHandle>;
}
export type ServiceFactory<T> = ScopedProvider<T, ServiceScope>;

/** Synchronously create one provider instance per consumer activation and registration. */
export function serviceFactory<T>(
  create: (scope: ServiceScope) => T & (T extends PromiseLike<unknown> ? never : unknown),
): ServiceFactory<T> {
  return scopedProvider(create);
}
