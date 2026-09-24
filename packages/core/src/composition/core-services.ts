// ============================================================
// core-services.ts — 内置八项服务的描述符与提供者
//
// 与契约包的服务同一种做法：提供者由根激活经 provide 登记（独占），描述符的 bind 只用公开的资源口。
// 八项的提供者形状相同：以调用方的 port.identity 为参，交回这次激活的门面；提供者先核对该身份属于
// 在 uses 里声明过本服务的激活——动态查询拿到提供者，也只能以自己的身份、在已声明时使用。
// 原语登记按身份归属，由拆卸的同栈切断统一撤回；手动退订直接撤原语登记，不另记清理链。
// ============================================================

import type { ContributionPointMap } from '../types/contributions.js';
import type { AalisEvents } from '../types/events.js';
import type { HookContextMap, MiddlewareFn } from '../types/hooks.js';

import type { ContributionHandle, ContributionSpec } from '../primitives/contributions.js';
import type { ServiceInfo, ServiceView } from '../primitives/services.js';

import { defineService, type ProviderOf, type ServiceDescriptor } from './descriptors.js';
import { validateProvide } from './provide-validation.js';
import type { ServiceRuntime } from './runtime.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** `provide` 的登记选项 */
export interface ProvideOptions {
  priority?: number;
  /** 独占：本条登记存续期间拒绝同名的其他提供者 */
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

/** 提供者按身份认出的调用方激活（结构上即激活记录的这几项） */
interface CoreCaller {
  readonly id: string;
  readonly owner: symbol;
  readonly logger: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly resources: Resources;
}

/** 内置服务的描述符：提供者是「身份 → 门面」，bind 以本资源口的身份取门面 */
function builtin<B>(name: string): ServiceDescriptor<(identity: symbol) => B, B> {
  return defineService<(identity: symbol) => B, B>(name, port => port.require()(port.identity));
}

// ----- events -----

export interface Events {
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void;
  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void>;
}
export const events = builtin<Events>('events');

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
export const hooks = builtin<Hooks>('hooks');

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
export const contributions = builtin<Contributions>('contributions');

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
export const lifecycle = builtin<LifecycleCap>('lifecycle');

// ----- logger / config -----

export const logger = builtin<Logger>('logger');

/** 插件自己的配置视图（只读）。宿主级的配置管理是另一项能力，不默认发给插件。 */
export const config = builtin<Readonly<Record<string, unknown>>>('config');

// ----- provide / services（发布与动态查找）-----

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
  implementation: ProviderOf<D>,
  options?: ProvideOptions,
) => () => void;
export const provide = builtin<Provide>('provide');

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
  /** 只读登记元数据（不含实例） */
  inspect(key: ServiceKey): ServiceInfo[];
  /** 某服务当前的偏好提供者（contextId）；无偏好为 undefined */
  preferred(key: ServiceKey): string | undefined;
  prefer(key: ServiceKey, contextId: string): boolean;
  unprefer(key: ServiceKey): boolean;
}
export const services = builtin<Services>('services');

// ----- 提供者 -----

/**
 * 八项内置服务的提供者：`provide` 单列（宿主须先直接登记它来自举），其余七项由根激活经 provide 登记。
 * `caller` 按身份认出调用方激活，并核对它在 uses 里声明过该服务（否则抛错）。
 */
export function coreProviders(
  runtime: ServiceRuntime,
  caller: (identity: symbol, name: string) => CoreCaller,
): { provide: (identity: symbol) => Provide; rest: Array<[AnyDescriptor, (identity: symbol) => unknown]> } {
  const entry = <B>(descriptor: ServiceDescriptor<(identity: symbol) => B, B>, view: (c: CoreCaller) => B) =>
    [descriptor, (identity: symbol) => view(caller(identity, descriptor.name))] as [AnyDescriptor, (i: symbol) => B];
  const accepts = (c: CoreCaller, operation: string): boolean => {
    if (!c.resources.disposed) return true;
    c.logger.warn(`激活 "${c.id}" 已 dispose，忽略 ${operation}`);
    return false;
  };
  const { events: bus, hooks: hookRegistry, contributions: registry, services: container } = runtime;
  const shared: Services = {
    get: <K extends ServiceKey>(key: K) => container.get<KeyedProvider<K>>(keyName(key)),
    all: <K extends ServiceKey>(key: K) => container.getAll<KeyedProvider<K>>(keyName(key)),
    names: () => container.getServiceNames(),
    inspect: key => container.inspect(keyName(key)),
    preferred: key => container.getPreferred(keyName(key)),
    prefer: (key, contextId) => {
      const ok = container.prefer(keyName(key), contextId);
      if (ok) runtime.notify('service:preference-changed', keyName(key));
      return ok;
    },
    unprefer: key => {
      const ok = container.unprefer(keyName(key));
      if (ok) runtime.notify('service:preference-changed', keyName(key));
      return ok;
    },
  };
  const [, provideFor] = entry<Provide>(provide, c => (descriptor, implementation, options) => {
    const name = descriptor.name;
    if (!accepts(c, `provide("${name}")`)) return () => {};
    const entryId = options?.onBehalfOf ?? options?.entryId ?? c.id;
    if (runtime.devMode && options?.onBehalfOf === undefined)
      validateProvide(
        { ctxId: c.id, name, entryId, explicitEntryId: options?.entryId !== undefined },
        { services: container, logger: c.logger },
      );
    const off = container.register(name, implementation, entryId, c.owner, options);
    runtime.notify('service:registered', name);
    c.logger.debug(`服务已注册: ${name}`);
    return () => {
      if (off()) runtime.notify('service:unregistered', name);
    };
  });
  return {
    provide: provideFor,
    rest: [
      entry<Events>(events, c => ({
        on: (event, handler) => (accepts(c, `on("${event}")`) ? bus.on(event, handler, c.owner) : () => {}),
        emit: (event, ...args) => bus.emit(event, ...args),
      })),
      entry<Hooks>(hooks, c => ({
        middleware: (hook, fn) =>
          accepts(c, `middleware("${hook}")`) ? hookRegistry.register(hook, fn, c.id, c.owner) : () => {},
        run: (hook, data, defaultAction, opts) => hookRegistry.run(hook, data, defaultAction, opts),
      })),
      entry<Contributions>(contributions, c => ({
        contribute: (point, spec) =>
          accepts(c, `contribute("${point}")`) ? registry.register(point, spec, c.id, c.owner) : () => {},
        collect: point => registry.collect(point),
      })),
      entry<LifecycleCap>(lifecycle, c => ({
        id: c.id,
        get closed() {
          return c.resources.disposed;
        },
        onDrain: (fn, label) => c.resources.onDrain(fn, label),
        onDispose: (fn, label) => c.resources.onDispose(fn, label),
      })),
      entry<Logger>(logger, c => c.logger),
      entry<Readonly<Record<string, unknown>>>(config, c => c.config),
      entry<Services>(services, () => shared),
    ],
  };
}
