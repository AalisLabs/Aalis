import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer } from '../primitives/services.js';

export interface ServiceRuntime {
  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly devMode: boolean;
  /** 某服务的选择可能变了（登记、撤回、扣下、放出、改偏好）：同步调用各观察者（重算、跟随收敛、选择层的 watch） */
  serviceChanged(name: string): void;
  /** 订阅服务变更：在 {@link serviceChanged} 里同步调用；返回退订 */
  watchServices(watcher: (name: string) => void): () => void;
}
