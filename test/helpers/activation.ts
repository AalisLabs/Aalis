import {
  ContributionRegistry,
  config,
  contributions,
  DefaultLogger,
  EventBus,
  events,
  HookRegistry,
  hooks,
  type Logger,
  lifecycle,
  logger,
  provide,
  ServiceContainer,
  services,
} from '../../packages/core/src/index.js';
import type { Activation } from '../../packages/core/src/orchestration/activation.js';
import { ActivationHost, notify } from '../../packages/core/src/orchestration/activation-host.js';

/** 真实内置能力装配；激活记录与插件能调用的能力保持分开。 */
export function bindActivationFixture(host: ActivationHost, activation: Activation) {
  return {
    host,
    activation,
    caps: host.bind(activation, { events, hooks, contributions, provide, services, lifecycle, logger, config }),
    ...host.runtime,
  };
}

export function createActivationFixture(options: { id?: string; logger?: Logger; devMode?: boolean } = {}) {
  const log = options.logger ?? new DefaultLogger('test', 'error');
  const bus = new EventBus();
  const host = new ActivationHost(
    {
      events: bus,
      hooks: new HookRegistry(),
      contributions: new ContributionRegistry(),
      services: new ServiceContainer(),
      devMode: options.devMode ?? false,
      notify: notify({ events: bus }, log),
    },
    log,
  );
  const activation = options.id && options.id !== 'root' ? host.create(host.root, options.id) : host.root;
  return bindActivationFixture(host, activation);
}
