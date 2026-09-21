import { reportQuietly } from '../kernel/disposable-chain.js';

import { type ScopedProvider, scopedProvider } from '../primitives/services.js';

import type { ModuleHandle } from './core-services.js';
import type { PluginDefinition } from './plugin-definition.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

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

/** Construction rollback is local; successful instances use the consumer's existing resource ledger. */
export function instantiateService(
  name: string,
  provider: ScopedProvider<unknown, unknown>,
  context: {
    scope: Pick<ServiceScope, 'id' | 'identity' | 'logger' | 'config' | 'module'>;
    resources: Resources;
    release: () => void;
  },
): unknown {
  // Only live during construction; successful factories use the existing consumer resource ledger.
  let rollback: Set<() => unknown> | undefined = new Set();
  let failed = false;
  const { resources, release, scope: base } = context;
  const cancelRelease = resources.onDispose(release, `factory:${name}`);
  const scope: ServiceScope = {
    id: base.id,
    identity: base.identity,
    logger: base.logger,
    config: base.config,
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
      const mounting = base.module(definition, config);
      rollback?.add(() => mounting.then(handle => handle.disposeAsync()));
      return mounting;
    },
  };
  try {
    const instance = resources.run(() => provider.create(scope));
    if (instance === undefined || instance === null) throw new Error(`服务工厂 "${name}" 的实现不能为空`);
    if (typeof (instance as PromiseLike<unknown>).then === 'function') {
      Promise.resolve(instance).catch(error =>
        reportQuietly(() => base.logger.warn(`异步服务工厂 "${name}" 拒绝:`, error)),
      );
      throw new Error(`服务工厂 "${name}" 必须同步返回实例`);
    }
    rollback = undefined;
    return instance;
  } catch (error) {
    failed = true;
    cancelRelease();
    const pending: Promise<unknown>[] = [];
    for (const undo of [...rollback!].reverse()) {
      const report = (error: unknown) => reportQuietly(() => base.logger.warn(`服务工厂 "${name}" 回滚失败:`, error));
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
