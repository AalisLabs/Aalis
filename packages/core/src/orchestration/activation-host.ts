import { reportQuietly } from '../kernel/disposable-chain.js';

import { Activation } from './activation.js';
import { createPort } from '../composition/binding.js';
import { coreProviders, provide } from '../composition/core-services.js';
import { type BoundOf, isOptional, optionalNames, requiredNames, type Uses } from '../composition/descriptors.js';
import type { PluginDefinition } from '../composition/plugin-definition.js';
import type { ServiceRuntime } from '../composition/runtime.js';
import type { Logger } from '../infrastructure/logger.js';
import { Resources } from '../infrastructure/resources.js';

/** 装配与挂载协调器。能力实现留在各描述符，资源清理留在 Resources。 */
export class ActivationHost {
  readonly root: Activation;
  private readonly owners = new Map<symbol, Activation>();

  constructor(
    readonly runtime: ServiceRuntime,
    logger: Logger,
  ) {
    this.root = this.create(undefined, 'root', {}, logger);
    const providers = coreProviders(runtime, (identity, name) => {
      const activation = this.owners.get(identity);
      if (!activation?.declared.has(name)) throw new Error(`内置服务 "${name}" 只能由在 uses 里声明了它的激活取用`);
      return activation;
    });
    // 自举：provide 的提供者须先在容器里，根才能经 uses 取到 provide；其余七项与第三方服务同走 provide
    runtime.services.register(provide.name, providers.provide, 'root', this.root.owner, { exclusive: true });
    const root = this.bind(this.root, { provide });
    for (const [descriptor, provider] of providers.rest) root.provide(descriptor, provider, { exclusive: true });
  }

  create(
    parent: Activation | undefined,
    id: string,
    config: Record<string, unknown> = {},
    logger = parent?.logger.child(id),
  ): Activation {
    if (parent?.resources.disposed) throw new Error(`激活 "${parent.id}" 已 dispose，无法创建子激活 "${id}"`);
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
      // 下线通知排在提供者自己的清理之前：跟随者据此撤回，提供者关闭前交接完
      afterWithdraw: () => {
        const names = removed;
        removed = [];
        return names.length === 0
          ? undefined
          : Promise.all(names.map(name => runtime.notify('service:unregistered', name)));
      },
      afterCleanup: () => {
        this.owners.delete(owner);
        parent?.children.delete(activation);
      },
    });
    const activation = new Activation(id, owner, logger, config, resources, runtime.services, this.owners);
    this.owners.set(owner, activation);
    parent?.children.add(activation);
    return activation;
  }

  bind<U extends Uses>(activation: Activation, uses: U): BoundOf<U> {
    // 必须先记依赖：binder 可以当场建立需要保留到撤回落定的绑定。
    for (const name of optionalNames(uses)) if (!activation.declared.has(name)) activation.declared.set(name, false);
    for (const name of requiredNames(uses)) activation.declared.set(name, true);
    const binding = {
      id: activation.id,
      owner: activation.owner,
      logger: activation.logger,
      resources: activation.resources,
      services: this.runtime.services,
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

  mount(activation: Activation, definition: PluginDefinition): void | Promise<void> {
    return definition.apply(this.bind(activation, definition.uses ?? {}));
  }
}

/** Core 的通知型事件单一出口；屏障仍由 App 显式 await。 */
export function notify(runtime: Pick<ServiceRuntime, 'events'>, logger: Logger): ServiceRuntime['notify'] {
  return (event, ...args) => {
    const report = (error: unknown) => reportQuietly(() => logger.warn(`emit ${event} 失败:`, error));
    try {
      return Promise.resolve(runtime.events.emit(event, ...args)).catch(report);
    } catch (error) {
      report(error);
      return Promise.resolve();
    }
  };
}
