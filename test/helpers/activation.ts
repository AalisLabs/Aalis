import {
  config,
  DefaultLogger,
  type Logger,
  lifecycle,
  logger,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { quietLogger } from '../../packages/core/src/infrastructure/logger.js';
import type { Activation } from '../../packages/core/src/orchestration/activation.js';
import { ActivationHost } from '../../packages/core/src/orchestration/activation-host.js';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';

/** 真实内置能力装配；激活记录与插件能调用的能力保持分开。 */
export function bindActivationFixture(host: ActivationHost, activation: Activation) {
  return {
    host,
    activation,
    caps: host.bind(activation, { provide, services, lifecycle, logger, config }),
    ...host.runtime,
  };
}

export function createActivationFixture(options: { id?: string; logger?: Logger } = {}) {
  // 与 App 构造同一包法：注入的 logger 出错不传进 core
  const log = quietLogger(options.logger ?? new DefaultLogger('test', 'error'));
  const host = new ActivationHost(new ServiceContainer(), log);
  const activation = options.id && options.id !== 'root' ? host.create(options.id) : host.root;
  return bindActivationFixture(host, activation);
}
