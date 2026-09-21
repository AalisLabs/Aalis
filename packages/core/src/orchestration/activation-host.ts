import { reportQuietly } from '../kernel/disposable-chain.js';

import { isScopedProvider } from '../primitives/services.js';

import { Activation } from './activation.js';
import { createPort } from '../composition/binding.js';
import { type ModuleHandle, registerCoreServices } from '../composition/core-services.js';
import { type BoundOf, isOptional, optionalNames, requiredNames, type Uses } from '../composition/descriptors.js';
import { type PluginDefinition, validateDefinition } from '../composition/plugin-definition.js';
import type { ServiceRuntime } from '../composition/runtime.js';
import { instantiateService } from '../composition/service-factory.js';
import type { Logger } from '../infrastructure/logger.js';
import { Resources } from '../infrastructure/resources.js';

const CREATING = Symbol('creating-service');

/** 装配与挂载协调器。能力实现留在各描述符，资源清理留在 Resources。 */
export class ActivationHost {
  readonly root: Activation;
  private readonly owners = new Map<symbol, Activation>();
  private readonly instances = new WeakMap<Activation, WeakMap<object, unknown>>();

  constructor(
    readonly runtime: ServiceRuntime,
    logger: Logger,
  ) {
    this.root = this.create(undefined, 'root', {}, logger);
    registerCoreServices(runtime, this.root.owner, (scope, name, provider) => {
      const activation = this.owners.get(scope.identity);
      return activation ? this.resolve(activation, name, provider) : undefined;
    });
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
        this.instances.delete(activation);
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
    const binding = {
      id: activation.id,
      logger: activation.logger,
      resources: activation.resources,
      services: this.resolver(activation),
      events: this.runtime.events,
      retainBinding: (name: string) => activation.retainBinding(name),
    };
    const caps: Record<string, unknown> = {};
    return activation.resources.run(() => {
      for (const [key, use] of Object.entries(uses)) {
        const descriptor = isOptional(use) ? use.optional : use;
        caps[key] = descriptor.bind(createPort(binding, descriptor.name, !isOptional(use)));
      }
      return caps as BoundOf<U>;
    });
  }

  private resolver(activation: Activation) {
    return {
      get: <T>(name: string): T | undefined =>
        this.resolve(activation, name, this.runtime.services.get(name)) as T | undefined,
      getAll: <T>(name: string) =>
        this.runtime.services
          .getAll(name)
          .map(entry => ({ ...entry, instance: this.resolve(activation, name, entry.instance) as T })),
    };
  }

  private resolve(activation: Activation, name: string, provider: unknown): unknown {
    if (!isScopedProvider(provider)) return provider;
    let cache = this.instances.get(activation);
    if (!cache) {
      cache = new WeakMap();
      this.instances.set(activation, cache);
    }
    if (cache.has(provider)) {
      const value = cache.get(provider);
      if (value === CREATING) throw new Error(`服务工厂 "${name}" 循环构造`);
      return value;
    }
    const resources = activation.resources;
    if (resources.lifecycle.disposed) throw new Error(`激活 "${activation.id}" 已关闭，不能创建服务 "${name}"`);
    cache.set(provider, CREATING);
    try {
      const instance = instantiateService(name, provider, {
        resources,
        release: activation.retainBinding(name, provider),
        scope: {
          id: activation.id,
          identity: activation.owner,
          logger: activation.logger,
          config: activation.config,
          module: (definition, config) => this.module(activation, definition, config),
        },
      });
      cache.set(provider, instance);
      return instance;
    } catch (error) {
      cache.delete(provider);
      throw error;
    }
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
export function notify(runtime: Pick<ServiceRuntime, 'events'>, logger: Logger): ServiceRuntime['notify'] {
  return (event, ...args) => {
    const report = (error: unknown) => reportQuietly(() => logger.warn(`emit ${event} 失败:`, error));
    try {
      Promise.resolve(runtime.events.emit(event, ...args)).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
