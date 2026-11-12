import type { ServiceContainer } from '../primitives/services.js';

import { Activation } from './activation.js';
import { createSelection } from '../composition/binding.js';
import { coreProviders, provide } from '../composition/core-services.js';
import { type BoundOf, dependencies, type Uses } from '../composition/descriptors.js';
import type { ServiceRuntime } from '../composition/runtime.js';
import type { Logger } from '../infrastructure/logger.js';
import { Resources } from '../infrastructure/resources.js';

/** 激活的创建与装配。能力实现留在各描述符，资源清理留在 Resources。 */
export class ActivationHost {
  readonly runtime: ServiceRuntime;
  readonly root: Activation;
  readonly #owners = new Map<symbol, Activation>();

  constructor(services: ServiceContainer, logger: Logger) {
    const watchers = new Set<(name: string) => void>();
    this.runtime = {
      services,
      serviceChanged: name => {
        for (const watcher of watchers) watcher(name);
      },
      watchServices: watcher => {
        watchers.add(watcher);
        return () => watchers.delete(watcher);
      },
    };
    this.root = this.#make('root', {}, logger);
    const providers = coreProviders(this.runtime, (identity, name) => this.caller(identity, name));
    // 自举：provide 的提供者须先在容器里，根才能经 uses 取到 provide；其余四项与第三方服务同走 provide
    this.runtime.services.register(provide.name, providers.provide, 'root', this.root.owner, { exclusive: true });
    const root = this.bind(this.root, { provide });
    for (const [descriptor, provider] of providers.rest) root.provide.use(descriptor, provider, { exclusive: true });
  }

  /** 按身份认出调用方的激活；认不出就抛错 */
  caller(identity: symbol, name: string): Activation {
    const activation = this.#owners.get(identity);
    if (!activation) throw new Error(`内置服务 "${name}" 收到的身份不属于任何在册的激活`);
    return activation;
  }

  /** 插件激活：一律挂在根激活名下 */
  create(id: string, config: Record<string, unknown> = {}): Activation {
    if (this.root.resources.disposed) throw new Error(`激活 "${this.root.id}" 已关闭，无法创建插件激活 "${id}"`);
    const activation = this.#make(id, config, this.root.logger.child(id));
    this.root.children.add(activation);
    return activation;
  }

  #make(id: string, config: Record<string, unknown>, logger: Logger): Activation {
    const owner = Symbol(id);
    const runtime = this.runtime;
    let removed: string[] = [];
    const resources = new Resources(id, logger, {
      // 提供者自己的清理之前：挂在它上面、还没进关闭计划的跟随者就地交接，落定后提供者才关。服务变更等全部切断项执行完毕才通知：
      // 本激活的原语与归属表条目一并撤掉之后，下游才收敛
      afterCut: (): Promise<unknown> | undefined => {
        const settling = activation.handover();
        for (const name of removed) runtime.serviceChanged(name);
        return settling;
      },
      afterCleanup: () => {
        activation.dropOutbound();
        this.#owners.delete(owner);
        this.root.children.delete(activation);
      },
    });
    // 第一个切断项：服务登记按归属整体切断，不逐条 await 让一半登记仍然对外可用
    resources.onCut(() => {
      removed = runtime.services.unregisterByOwner(owner);
    });
    const activation = new Activation(id, owner, logger, config, resources, runtime.services, this.#owners);
    this.#owners.set(owner, activation);
    return activation;
  }

  bind<U extends Uses>(activation: Activation, uses: U): BoundOf<U> {
    const deps = dependencies(uses);
    // 必须先记依赖：binder 可以当场建立需要保留到撤回落定的绑定。同一服务既 required 又 optional 时记 required
    for (const { descriptor, required } of deps)
      if (required || !activation.declared.has(descriptor.name)) activation.declared.set(descriptor.name, required);
    const binding = {
      id: activation.id,
      owner: activation.owner,
      logger: activation.logger,
      resources: activation.resources,
      services: this.runtime.services,
      watchServices: this.runtime.watchServices,
      retainBinding: (owner: symbol, name: string, pump: () => void) => activation.retainBinding(owner, name, pump),
    };
    const caps: Record<string, unknown> = {};
    for (const { key, descriptor, required } of deps) caps[key] = createSelection(binding, descriptor, required);
    return caps as BoundOf<U>;
  }

  /** 该归属的激活已进关闭计划（容器里的条目都出自仍在册的激活：撤回先于除名） */
  closing(owner: symbol): boolean {
    return this.#owners.get(owner)!.resources.disposed;
  }
}
