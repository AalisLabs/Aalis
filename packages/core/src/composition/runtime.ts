import type { AalisEvents } from '../types/events.js';

import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer } from '../primitives/services.js';

export interface ServiceRuntime {
  readonly events: EventBus;
  readonly services: ServiceContainer;
  readonly devMode: boolean;
  notify<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): void;
  /**
   * 某服务的选择可能变了（登记、撤回、扣下、放出、改偏好）：先同步调用 core 自己的观察者（跟随收敛、重算），
   * 再发公开的 service:changed。core 不订阅公开总线：总线逐个等监听器，排在异步监听器后面的跟随会晚于 idle() 放行
   */
  serviceChanged(name: string): void;
  /** core 内部订阅服务变更：在 {@link serviceChanged} 里同步调用；返回退订 */
  watchServices(watcher: (name: string) => void): () => void;
}
