// ============================================================
// core-services.ts — 宿主默认服务的描述符与提供者
//
// 所有服务都在容器中登记，并经描述符 bind 装配。默认服务使用公开的 serviceFactory，
// 按消费者激活生成门面；exclusive 是所有提供者都能使用的登记策略，不是描述符特权。
// 不声明 lifecycle / logger 不影响框架对本次激活的资源管理。
// ============================================================

import type { ContributionPointMap } from '../types/contributions.js';
import type { AalisEvents } from '../types/events.js';
import type { HookContextMap, MiddlewareFn } from '../types/hooks.js';

import type { ContributionHandle, ContributionSpec } from '../primitives/contributions.js';
import type { ServiceInfo, ServiceView } from '../primitives/services.js';

import { defineService, type ProviderOf, type ServiceDescriptor } from './descriptors.js';
import { validateProvide } from './provide-validation.js';
import type { ServiceRuntime } from './runtime.js';
import { type ServiceFactory, type ServiceScope, serviceFactory } from './service-factory.js';
import type { Logger } from '../infrastructure/logger.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** `provide` 的登记选项 */
export interface ProvideOptions {
  priority?: number;
  /** Reject other providers of this name while this registration exists. */
  exclusive?: boolean;
  /** 展示名（服务页下拉等） */
  label?: string;
  /** 一个激活登记多条时的子粒度 id，须以本激活 id 为前缀（`${id}/${子粒度}`） */
  entryId?: string;
  /**
   * 代为登记：条目的逻辑身份取这个 id（而非本激活的），用于托管自己不运行代码的包——如 WebUI 服务端
   * 替扫描到的静态前端包登记，偏好与展示认的是前端包名。清理仍归本激活。与 entryId 二选一。
   */
  onBehalfOf?: string;
}

function accepts(scope: ServiceScope, operation: string): boolean {
  if (!scope.closed) return true;
  scope.logger.warn(`激活 "${scope.id}" 已 dispose，忽略 ${operation}`);
  return false;
}

// ----- events -----

export interface Events {
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void;
  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void>;
}

export const events = defineService<Events, Events>('events', port => port.require());
const createEvents = factory<Events>(events, (scope, { events: bus }) => ({
  on: (event, handler) =>
    accepts(scope, `on("${event}")`) ? scope.track(bus.on(event, handler, scope.identity), `on:${event}`) : () => {},
  emit: (event, ...args) => bus.emit(event, ...args),
}));

// ----- hooks -----

export interface Hooks {
  /** 注册中间件（洋葱模型，按注册顺序）；返回退订，随这次激活撤回 */
  middleware<K extends string & keyof HookContextMap>(hook: K, fn: MiddlewareFn<HookContextMap[K]>): () => void;
  /** 驱动一条钩子链；返回 false 表示被某个中间件截停 */
  run<K extends string & keyof HookContextMap>(
    hook: K,
    data: HookContextMap[K],
    defaultAction?: () => Promise<void>,
    opts?: { warnOnStall?: boolean },
  ): Promise<boolean>;
}

export const hooks = defineService<Hooks, Hooks>('hooks', port => port.require());
const createHooks = factory<Hooks>(hooks, (scope, { hooks: registry }) => ({
  middleware: (hook, fn) =>
    accepts(scope, `middleware("${hook}")`)
      ? scope.track(registry.register(hook, fn, scope.id, scope.identity), `middleware:${hook}`)
      : () => {},
  run: (hook, data, defaultAction, opts) => registry.run(hook, data, defaultAction, opts),
}));

// ----- contributions -----

export interface Contributions {
  /** 向贡献点交付一份 spec（局部 id 自动冠本激活的前缀，同 id 重复交付为替换）；返回退订 */
  contribute<K extends string & keyof ContributionPointMap>(
    point: K,
    spec: ContributionPointMap[K] & ContributionSpec,
  ): () => void;
  /** 收集某贡献点的全部交付（快照，顺序是全局键的纯函数） */
  collect<K extends string & keyof ContributionPointMap>(
    point: K,
  ): ReadonlyArray<ContributionHandle<ContributionPointMap[K] & ContributionSpec>>;
}

export const contributions = defineService<Contributions, Contributions>('contributions', port => port.require());
const createContributions = factory<Contributions>(contributions, (scope, { contributions: registry }) => {
  const entries = new Map<string, () => void>();
  return {
    contribute(point, spec) {
      if (!accepts(scope, `contribute("${point}")`)) return () => {};
      const key = `${point}\u0000${(spec as ContributionSpec).id}`;
      entries.get(key)?.();
      const rawOff = registry.register(point, spec, scope.id, scope.identity);
      const off = scope.track(
        () => {
          if (entries.get(key) === off) entries.delete(key);
          rawOff();
        },
        `contribute:${point}:${(spec as ContributionSpec).id}`,
      );
      entries.set(key, off);
      return off;
    },
    collect: point => registry.collect(point),
  };
});

// ----- lifecycle -----

export interface LifecycleCap {
  /** 这次激活的实例 id（多实例为 `name:suffix`）：日志、展示、路由用的逻辑名 */
  readonly id: string;
  /** 这次激活已开始关闭 */
  readonly closed: boolean;
  /**
   * 登记收尾：在本激活撤回登记之前执行，用于停接新活、把在手数据交给下层并等待确认。
   * 依赖可用性取决于关停图：普通消费者先关，宿主根与循环依赖采用各自的阶段顺序；
   * 不保护动态查询、缓存裸引用或提供者主动提前释放的资源。
   * 回调不得 await 或返回同一关闭计划中后续阶段的完成 Promise（会互等）；计划外调用者仍可等待关闭完成。
   */
  onDrain(fn: () => void | Promise<void>, label?: string): () => void;
  /** 登记清理（清理段）：本激活的对外登记已撤回；依赖可能已不可用，交接应放在 onDrain */
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
}

export const lifecycle = defineService<LifecycleCap, LifecycleCap>('lifecycle', port => port.require());
const createLifecycle = factory<LifecycleCap>(lifecycle, scope => ({
  id: scope.id,
  get closed() {
    return scope.closed;
  },
  onDrain: (fn, label) => scope.onDrain(fn, label),
  onDispose: (fn, label) => scope.onDispose(fn, label),
}));

// ----- logger / config -----

export const logger = defineService<Logger, Logger>('logger', port => port.require());
const createLogger = factory<Logger>(logger, scope => scope.logger);

/** 插件自己的配置视图（只读）。宿主级的配置管理是另一项能力，不默认发给插件。 */
export const config = defineService<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>(
  'config',
  port => port.require(),
);
const createConfig = factory<Readonly<Record<string, unknown>>>(config, scope => scope.config);

// ----- services（提供与动态查找）-----

// biome-ignore lint/suspicious/noExplicitAny: 描述符泛型只作推导载体
type AnyDescriptor = ServiceDescriptor<any, any>;

/**
 * 发布服务：唯一的发布入口。实现按描述符的提供者类型约束；返回退订，随这次激活撤回。
 *
 * `options.onBehalfOf`：条目的逻辑身份取被代者 id（偏好、服务页、provides 校验的 hasByContext 都认这个 id），
 * 清理仍归本激活。代登记不计入代理人的 `provides`；写进去会按「未提供」让本次激活进入 error。
 */
export type Provide = <D extends AnyDescriptor>(
  descriptor: D,
  implementation: ProviderOf<D> | ServiceFactory<ProviderOf<D>>,
  options?: ProvideOptions,
) => () => void;

export const provide = defineService<Provide, Provide>('provide', port => port.require());
const createProvide = factory<Provide>(provide, (scope, runtime) => (descriptor, implementation, options) => {
  const name = descriptor.name;
  if (!accepts(scope, `provide("${name}")`)) return () => {};
  if (implementation === null || implementation === undefined) throw new Error('provide 的实现不能为空');
  if (options?.priority !== undefined && !Number.isFinite(options.priority)) {
    throw new Error(`provide 的 priority 必须是有限数字（收到 ${String(options.priority)}）`);
  }
  const entryId = options?.onBehalfOf ?? options?.entryId ?? scope.id;
  if (runtime.devMode && options?.onBehalfOf === undefined)
    validateProvide(
      { ctxId: scope.id, name, entryId, explicitEntryId: options?.entryId !== undefined },
      { services: runtime.services, logger: scope.logger },
    );
  const off = runtime.services.register(name, implementation, entryId, scope.identity, options);
  const dispose = scope.track(
    () => {
      if (off()) runtime.notify('service:unregistered', name);
    },
    `provide:${options?.onBehalfOf ?? options?.entryId ?? name}`,
  );
  runtime.notify('service:registered', name);
  scope.logger.debug(`服务已注册: ${name}`);
  return dispose;
});

/** 动态查询的键：有描述符就用描述符（带类型），只有运行期字符串（URL、配置里的服务名）就用名字 */
export type ServiceKey = AnyDescriptor | string;
type KeyedProvider<K extends ServiceKey> = K extends AnyDescriptor ? ProviderOf<K> : unknown;
const keyName = (key: ServiceKey): string => (typeof key === 'string' ? key : key.name);

/**
 * 动态查询与偏好管理（管理、展示面用）。查到的服务不是声明依赖：不参与激活闸，
 * 不享有重绑与关停顺序保证——需要这些保证就写进 uses。
 */
export interface Services {
  /** 当前胜者。按名字查时没有类型可依凭，由调用方自行收窄 */
  get<K extends ServiceKey>(key: K): KeyedProvider<K> | undefined;
  all<K extends ServiceKey>(key: K): ServiceView<KeyedProvider<K>>[];
  /** 当前已注册的全部服务名 */
  names(): string[];
  /** Provider metadata only; does not construct activation-scoped instances. */
  inspect(key: ServiceKey): ServiceInfo[];
  /** 某服务当前的偏好提供者（contextId）；无偏好为 undefined */
  preferred(key: ServiceKey): string | undefined;
  prefer(key: ServiceKey, contextId: string): boolean;
  unprefer(key: ServiceKey): boolean;
}

export const services = defineService<Services, Services>('services', port => port.require());
const createServices = factory<Services>(services, (scope, runtime, resolve) => ({
  get: <K extends ServiceKey>(key: K) =>
    resolve(scope, keyName(key), runtime.services.get(keyName(key))) as KeyedProvider<K> | undefined,
  all: <K extends ServiceKey>(key: K) =>
    runtime.services
      .getAll(keyName(key))
      .map(entry => ({ ...entry, instance: resolve(scope, keyName(key), entry.instance) as KeyedProvider<K> })),
  names: () => runtime.services.getServiceNames(),
  inspect: key => runtime.services.inspect(keyName(key)),
  preferred: key => runtime.services.getPreferred(keyName(key)),
  prefer: (key, contextId) => {
    const ok = runtime.services.prefer(keyName(key), contextId);
    if (ok) runtime.notify('service:preference-changed', keyName(key));
    return ok;
  },
  unprefer: key => {
    const ok = runtime.services.unprefer(keyName(key));
    if (ok) runtime.notify('service:preference-changed', keyName(key));
    return ok;
  },
}));

type Resolve = (scope: ServiceScope, name: string, provider: unknown) => unknown;
function factory<T>(
  descriptor: ServiceDescriptor<T, unknown>,
  create: (scope: ServiceScope, runtime: ServiceRuntime, resolve: Resolve) => T,
) {
  return { name: descriptor.name, create };
}

/** Bootstrap registration uses the same container and factory protocol as third-party services. */
export function registerCoreServices(runtime: ServiceRuntime, owner: symbol, resolve: Resolve): void {
  const factories = [
    createEvents,
    createHooks,
    createContributions,
    createLifecycle,
    createLogger,
    createConfig,
    createProvide,
    createServices,
  ];
  const registered: Array<() => boolean> = [];
  try {
    for (const entry of factories) {
      registered.push(
        runtime.services.register(
          entry.name,
          serviceFactory<unknown>(scope => entry.create(scope, runtime, resolve)),
          'root',
          owner,
          { exclusive: true },
        ),
      );
    }
  } catch (error) {
    for (const off of registered.reverse()) off();
    throw error;
  }
}
