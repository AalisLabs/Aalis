import { vi } from 'vitest';
import { App, type AppOptions } from '../../packages/core/src/index.js';
import type { Activation } from '../../packages/core/src/orchestration/activation.js';
import { ActivationHost } from '../../packages/core/src/orchestration/activation-host.js';

const hosts = new WeakMap<App, ActivationHost>();

/** 白盒测试观察真实 App 的装配器；生产 App 无测试读口，也不另造一套激活树。 */
export function createInspectableApp(options: AppOptions): App {
  let host: ActivationHost | undefined;
  const create = ActivationHost.prototype.create;
  const spy = vi.spyOn(ActivationHost.prototype, 'create').mockImplementation(function (this: ActivationHost, ...args) {
    host ??= this;
    return create.apply(this, args);
  });
  try {
    // App 构造为同步调用；捕获与恢复之间没有 await，不跨测试持有 spy。
    const app = new App(options);
    if (!host) throw new Error('App 未创建 ActivationHost');
    hosts.set(app, host);
    return app;
  } finally {
    spy.mockRestore();
  }
}

export function activationHost(app: App): ActivationHost {
  const host = hosts.get(app);
  if (!host) throw new Error('白盒观测需要 createInspectableApp 创建的 App');
  return host;
}

export function rootActivation(app: App): Activation {
  return activationHost(app).root;
}
