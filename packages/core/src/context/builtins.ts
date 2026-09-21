// ============================================================
// builtins.ts — 核心内置能力的描述符
//
// 与第三方能力统一的是声明与装配入口：插件在 uses 里写描述符，apply 拿到按激活绑定的接口；
// 没有默认注入，用到什么写什么。来源与替换规则仍不同——内置能力绑的是这次激活自身的运行
// 基础设施（事件总线、容器、清理链），不经容器解析、不可被 provide 替换，也不参与激活闸。
// 不声明 lifecycle / logger 不影响框架对这次激活的管理：登记归属、撤回与关闭都照常。
// ============================================================

import type { ContributionPointMap } from '../types/contributions.js';
import type { AalisEvents } from '../types/events.js';
import type { HookContextMap, MiddlewareFn } from '../types/hooks.js';

import type { ContributionHandle, ContributionSpec } from '../primitives/contributions.js';
import type { ServiceView } from '../primitives/services.js';

import type { ProviderOf, ServiceDescriptor } from './binding.js';
import { builtinService, type CapabilityScope } from './capabilities.js';
import type { PluginDefinition } from './definition.js';
import type { Logger } from './logger.js';
import { validateProvide } from './services-helpers.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** `provide` 的登记选项 */
export interface ProvideOptions {
  priority?: number;
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

/**
 * `lifecycle.module` 返回的句柄——与激活自身的生命周期面同形，一个心智模型。
 */
export interface ModuleHandle {
  /** 子激活的实际 id：同名重复挂载时已唯一化（`parent#name`、`parent#name~2`…） */
  readonly id: string;
  /** 同步请求关闭：同步清理当场执行，异步清理不等待；名字随同步段释放 */
  dispose(): void;
  /** 关闭并等待全部异步清理完成；名字在此之后才释放 */
  disposeAsync(timeoutMs?: number): Promise<void>;
}

function accepts(scope: CapabilityScope, operation: string): boolean {
  if (!scope.resources.lifecycle.disposed) return true;
  scope.logger.warn(`激活 "${scope.id}" 已 dispose，忽略 ${operation}`);
  return false;
}

// ----- events -----

export interface Events {
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void;
  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void>;
}

export const events = builtinService<Events>('events', (scope, { events: bus }) => ({
  on: (event, handler) =>
    accepts(scope, `on("${event}")`)
      ? scope.resources.trackDisposable(bus.on(event, handler, scope.owner), `on:${event}`)
      : () => {},
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

export const hooks = builtinService<Hooks>('hooks', (scope, { hooks: registry }) => ({
  middleware: (hook, fn) =>
    accepts(scope, `middleware("${hook}")`)
      ? scope.resources.trackDisposable(registry.register(hook, fn, scope.id, scope.owner), `middleware:${hook}`)
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

export const contributions = builtinService<Contributions>('contributions', (scope, { contributions: registry }) => {
  const entries = new Map<string, () => void>();
  return {
    contribute(point, spec) {
      if (!accepts(scope, `contribute("${point}")`)) return () => {};
      const key = `${point}\u0000${(spec as ContributionSpec).id}`;
      entries.get(key)?.();
      const rawOff = registry.register(point, spec, scope.id, scope.owner);
      const off = scope.resources.trackDisposable(
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
  /** 这次激活的实例 id（多实例为 `name:suffix`，子模块为 `父id#模块名`）：日志、展示、路由用的逻辑名 */
  readonly id: string;
  /** 这次激活已开始关闭 */
  readonly closed: boolean;
  /**
   * 登记收尾：在本激活撤回登记之前执行，用于停接新活、把在手数据交给下层并等待确认。
   * 依赖可用性取决于关停图：普通消费者先关，父子与循环依赖采用各自的阶段顺序；
   * 不保护动态查询、缓存裸引用或提供者主动提前释放的资源。
   */
  onDrain(fn: () => void | Promise<void>, label?: string): () => void;
  /** 登记清理（清理段）：本激活的对外登记已撤回；依赖可能已不可用，交接应放在 onDrain */
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
  /**
   * 挂一个子模块：独立身份与生命周期，能力按子激活重新绑定，随父关闭。子模块不进调度器：
   * 挂载时缺 required 服务即拒绝（抛错，apply 不执行）；挂载之后不再设闸——提供者离场时
   * 登记排队、引用可能为空，由父模块决定是否关掉它。
   */
  module(definition: PluginDefinition, config?: Record<string, unknown>): Promise<ModuleHandle>;
}

export const lifecycle = builtinService<LifecycleCap>('lifecycle', scope => ({
  id: scope.id,
  get closed() {
    return scope.resources.lifecycle.disposed;
  },
  onDrain: (fn, label) => scope.resources.onDrain(fn, label),
  onDispose: (fn, label) => scope.resources.onDispose(fn, label),
  module: (definition, config) => scope.module(definition, config),
}));

// ----- logger / config -----

export const logger = builtinService<Logger>('logger', scope => scope.logger);

/** 插件自己的配置视图（只读）。宿主级的配置管理是另一项能力，不默认发给插件。 */
export const config = builtinService<Readonly<Record<string, unknown>>>('config', scope => scope.config);

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
  implementation: ProviderOf<D>,
  options?: ProvideOptions,
) => () => void;

export const provide = builtinService<Provide>('provide', (scope, runtime) => (descriptor, implementation, options) => {
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
  const off = runtime.services.register(name, implementation, entryId, scope.owner, options);
  const dispose = scope.resources.trackDisposable(
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
  /** 某服务当前的偏好提供者（contextId）；无偏好为 undefined */
  preferred(key: ServiceKey): string | undefined;
  prefer(key: ServiceKey, contextId: string): boolean;
  unprefer(key: ServiceKey): boolean;
}

export const services = builtinService<Services>('services', (_scope, runtime) => ({
  get: key => runtime.services.get(keyName(key)),
  all: key => runtime.services.getAll(keyName(key)),
  names: () => runtime.services.getServiceNames(),
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
