import { reportQuietly } from '../kernel/disposable-chain.js';

import {
  type BoundOf,
  createPort,
  isBuiltin,
  isOptional,
  optionalNames,
  requiredNames,
  type Uses,
} from '../context/binding.js';
import type { ModuleHandle } from '../context/builtins.js';
import { bindBuiltin, type CapabilityRuntime, type CapabilityScope } from '../context/capabilities.js';
import { type PluginDefinition, validateDefinition } from '../context/definition.js';
import type { Logger } from '../context/logger.js';
import { Resources } from '../context/resources.js';

import { Activation } from './activation.js';

/** 装配与挂载协调器。能力实现留在各描述符，资源清理留在 Resources。 */
export class ActivationHost {
  readonly root: Activation;
  private readonly owners = new Map<symbol, Activation>();
  private readonly bound = new WeakMap<Activation, Map<object, unknown>>();

  constructor(
    readonly runtime: CapabilityRuntime,
    logger: Logger,
  ) {
    this.root = this.create(undefined, 'root', {}, logger);
  }

  create(
    parent: Activation | undefined,
    id: string,
    config: Record<string, unknown> = {},
    logger = parent?.logger.child(id),
  ): Activation {
    if (parent?.resources.lifecycle.disposed) throw new Error(`激活 "${parent.id}" 已 dispose，无法创建子激活 "${id}"`);
    if (!logger) throw new Error('根激活需要 logger');
    const owner = Symbol(id);
    const runtime = this.runtime;
    let removed: string[] = [];
    const resources = new Resources(id, logger, {
      beforeCleanup: () => {
        // 原语切断保持同栈，不能逐条 await 时让一半监听仍然对外可用。
        removed = runtime.services.unregisterByOwner(owner);
        runtime.hooks.unregisterByOwner(owner);
        runtime.contributions.unregisterByOwner(owner);
        runtime.events.unregisterByOwner(owner);
      },
      afterCleanup: () => {
        for (const name of removed) runtime.notify('service:unregistered', name);
        removed = [];
        this.owners.delete(owner);
        parent?.children.delete(activation);
        this.bound.delete(activation);
      },
    });
    const activation = new Activation(id, owner, logger, config, resources, runtime.services, this.owners);
    this.owners.set(owner, activation);
    if (parent) {
      parent.children.add(activation);
      parent.resources.lifecycle.adopt(resources.lifecycle);
    }
    return activation;
  }

  bind<U extends Uses>(activation: Activation, uses: U): BoundOf<U> {
    // 必须先记依赖：binder 可以当场建立需要保留到撤回落定的绑定。
    for (const name of optionalNames(uses)) if (!activation.declared.has(name)) activation.declared.set(name, false);
    for (const name of requiredNames(uses)) activation.declared.set(name, true);
    const scope: CapabilityScope = {
      id: activation.id,
      owner: activation.owner,
      logger: activation.logger,
      resources: activation.resources,
      config: activation.config,
      module: (definition, config) => this.module(activation, definition, config),
    };
    const binding = {
      id: activation.id,
      logger: activation.logger,
      resources: activation.resources,
      services: this.runtime.services,
      events: this.runtime.events,
      retainBinding: (name: string) => activation.retainBinding(name),
    };
    let cache = this.bound.get(activation);
    if (!cache) {
      cache = new Map();
      this.bound.set(activation, cache);
    }
    const caps: Record<string, unknown> = {};
    return activation.resources.run(() => {
      for (const [key, use] of Object.entries(uses)) {
        const descriptor = isOptional(use) ? use.optional : use;
        if (isBuiltin(descriptor)) {
          if (!cache.has(descriptor)) cache.set(descriptor, bindBuiltin(descriptor, scope, this.runtime));
          caps[key] = cache.get(descriptor);
        } else {
          caps[key] = descriptor.bind(createPort(binding, descriptor.name));
        }
      }
      return caps as BoundOf<U>;
    });
  }

  mount(activation: Activation, definition: PluginDefinition): void | Promise<void> {
    return definition.apply(this.bind(activation, definition.uses ?? {}));
  }

  async module(
    parent: Activation,
    definition: PluginDefinition,
    config: Record<string, unknown> = {},
  ): Promise<ModuleHandle> {
    validateDefinition(definition);
    const missing = requiredNames(definition.uses ?? {}).filter(name => this.runtime.services.get(name) === undefined);
    if (missing.length)
      throw new Error(`子模块 "${definition.name}" 缺少 required 服务 [${missing.join(', ')}]，未挂载`);
    const base = `${parent.id}#${definition.name}`;
    let id = base;
    for (let n = 2; [...parent.children].some(child => child.id === id); n++) id = `${base}~${n}`;
    const child = this.create(parent, id, config);
    try {
      const applying = Promise.resolve(this.mount(child, definition));
      child.resources.lifecycle.trackInitialization(applying);
      await applying;
    } catch (error) {
      await child.disposeAsync();
      throw error;
    }
    return { id, dispose: () => child.dispose(), disposeAsync: timeout => child.disposeAsync(timeout) };
  }
}

/** Core 的通知型事件单一出口；屏障仍由 App 显式 await。 */
export function notify(runtime: Pick<CapabilityRuntime, 'events'>, logger: Logger): CapabilityRuntime['notify'] {
  return (event, ...args) => {
    const report = (error: unknown) => reportQuietly(() => logger.warn(`emit ${event} 失败:`, error));
    try {
      Promise.resolve(runtime.events.emit(event, ...args)).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
