import type { AalisEvents } from '../types/events.js';

import type { ContributionRegistry } from '../primitives/contributions.js';
import type { EventBus } from '../primitives/events.js';
import type { HookRegistry } from '../primitives/hooks.js';
import type { ServiceContainer } from '../primitives/services.js';

import { defineService, markBuiltin, type ServiceDescriptor } from './binding.js';
import type { ModuleHandle } from './builtins.js';
import type { PluginDefinition } from './definition.js';
import type { Logger } from './logger.js';
import type { Resources } from './resources.js';

/** 按激活绑定的基础设施入口。只在装配时使用，不交给插件或第三方 binder。 */
export interface CapabilityScope {
  readonly id: string;
  readonly owner: symbol;
  readonly logger: Logger;
  readonly resources: Resources;
  readonly config: Readonly<Record<string, unknown>>;
  module(definition: PluginDefinition, config?: Record<string, unknown>): Promise<ModuleHandle>;
}

export interface CapabilityRuntime {
  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly hooks: HookRegistry;
  readonly contributions: ContributionRegistry;
  readonly devMode: boolean;
  notify<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): void;
}

const FACTORY = Symbol('aalis.builtin-factory');
type Factory<B> = (scope: CapabilityScope, runtime: CapabilityRuntime) => B;

export function builtinService<B>(name: string, factory: Factory<B>): ServiceDescriptor<never, B> {
  return Object.assign(
    markBuiltin(
      defineService<never, B>(name, () => {
        throw new Error('内置能力须由同一份 @aalis/core 装配（@aalis/core 必须是单副本 peer 依赖）');
      }),
    ),
    { [FACTORY]: factory },
  );
}

export function bindBuiltin<B>(
  descriptor: ServiceDescriptor<never, B>,
  scope: CapabilityScope,
  runtime: CapabilityRuntime,
): B {
  const factory = (descriptor as ServiceDescriptor<never, B> & { [FACTORY]?: Factory<B> })[FACTORY];
  if (!factory) throw new Error('内置能力不属于本 core 副本（@aalis/core 必须是单副本 peer 依赖）');
  return factory(scope, runtime);
}
