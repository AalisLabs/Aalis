import {
  config,
  DefaultLogger,
  events,
  type Logger,
  lifecycle,
  logger,
  provide,
  services,
} from '../../packages/core/src/index.js';
import type { Activation } from '../../packages/core/src/orchestration/activation.js';
import { ActivationHost, notify } from '../../packages/core/src/orchestration/activation-host.js';
import { EventBus } from '../../packages/core/src/primitives/events.js';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

/** 真实内置能力装配；激活记录与插件能调用的能力保持分开。 */
export function bindActivationFixture(host: ActivationHost, activation: Activation) {
  return {
    host,
    activation,
    caps: host.bind(activation, { events, provide, services, lifecycle, logger, config }),
    ...host.runtime,
  };
}

export function createActivationFixture(options: { id?: string; logger?: Logger; devMode?: boolean } = {}) {
  const log = options.logger ?? new DefaultLogger('test', 'error');
  const bus = new EventBus();
  const host = new ActivationHost(
    {
      events: bus,
      services: new ServiceContainer(),
      devMode: options.devMode ?? false,
      notify: notify({ events: bus }, log),
    },
    log,
  );
  const activation = options.id && options.id !== 'root' ? host.create(host.root, options.id) : host.root;
  return bindActivationFixture(host, activation);
}
