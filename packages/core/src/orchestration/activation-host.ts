import { reportQuietly } from '../kernel/disposable-chain.js';

import { isScopedProvider } from '../primitives/services.js';

import { type BoundOf, createPort, isOptional, optionalNames, requiredNames, type Uses } from '../context/binding.js';
import { type ModuleHandle, registerCoreServices } from '../context/builtins.js';
import type { CapabilityRuntime } from '../context/capabilities.js';
import { type PluginDefinition, validateDefinition } from '../context/definition.js';
import type { Logger } from '../context/logger.js';
import { Resources } from '../context/resources.js';
import type { ServiceScope } from '../context/service-factory.js';

import { Activation } from './activation.js';

const CREATING = Symbol('creating-service');

/** 装配与挂载协调器。能力实现留在各描述符，资源清理留在 Resources。 */
export class ActivationHost {
  readonly root: Activation;
  private readonly owners = new Map<symbol, Activation>();
  private readonly instances = new WeakMap<Activation, WeakMap<object, unknown>>();

  constructor(
    readonly runtime: CapabilityRuntime,
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
    // Only live during construction; successful factories use the existing consumer resource ledger.
    let rollback: Set<() => unknown> | undefined = new Set();
    let failed = false;
    const release = activation.retainBinding(name, provider);
    const cancelRelease = resources.onDispose(release, `factory:${name}`);
    const scope: ServiceScope = {
      id: activation.id,
      identity: activation.owner,
      logger: activation.logger,
      config: activation.config,
      get closed() {
        return failed || resources.lifecycle.disposed;
      },
      track(off, label) {
        if (!rollback && !failed) return resources.track(off, label);
        let result: unknown;
        const dispose = resources.track(() => (result = off()), label);
        const undo = () => {
          dispose();
          // Resources.track already reports rejection; preserve waiting without reporting it twice.
          return result && typeof (result as PromiseLike<unknown>).then === 'function'
            ? Promise.resolve(result).then(
                () => undefined,
                () => undefined,
              )
            : undefined;
        };
        if (failed) dispose();
        else rollback?.add(undo);
        return () => {
          rollback?.delete(undo);
          dispose();
        };
      },
      onDrain(fn, label) {
        if (failed) return () => {};
        if (!rollback) return resources.onDrain(fn, label);
        const cancel = resources.onDrain(fn, label);
        rollback?.add(cancel);
        return () => {
          rollback?.delete(cancel);
          cancel();
        };
      },
      onDispose(fn, label) {
        if (failed) {
          resources.track(fn, label)();
          return () => {};
        }
        if (!rollback) return resources.onDispose(fn, label);
        const cancel = resources.onDispose(fn, label);
        const undo = () => {
          cancel();
          return fn();
        };
        rollback?.add(undo);
        return () => {
          rollback?.delete(undo);
          cancel();
        };
      },
      module: (definition, config) => {
        if (failed) return Promise.reject(new Error(`服务工厂 "${name}" 已失败，不能挂载子模块`));
        const mounting = this.module(activation, definition, config);
        rollback?.add(() => mounting.then(handle => handle.disposeAsync()));
        return mounting;
      },
    };
    cache.set(provider, CREATING);
    try {
      const instance = resources.run(() => provider.create(scope));
      if (instance === undefined || instance === null) throw new Error(`服务工厂 "${name}" 的实现不能为空`);
      if (typeof (instance as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(instance).catch(error =>
          reportQuietly(() => activation.logger.warn(`异步服务工厂 "${name}" 拒绝:`, error)),
        );
        throw new Error(`服务工厂 "${name}" 必须同步返回实例`);
      }
      rollback = undefined;
      cache.set(provider, instance);
      return instance;
    } catch (error) {
      failed = true;
      cache.delete(provider);
      cancelRelease();
      const pending: Promise<unknown>[] = [];
      for (const undo of [...rollback!].reverse()) {
        const report = (error: unknown) =>
          reportQuietly(() => activation.logger.warn(`服务工厂 "${name}" 回滚失败:`, error));
        try {
          const result = resources.run(undo);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function')
            pending.push(Promise.resolve(result).catch(report));
        } catch (error) {
          report(error);
        }
      }
      rollback = undefined;
      if (pending.length) resources.holdInflight(Promise.allSettled(pending).then(release), `factory:${name}:rollback`);
      else release();
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
