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

import {
  activationOf,
  type BindingPort,
  defineService,
  markBuiltin,
  type ProviderOf,
  type ServiceDescriptor,
} from './binding.js';
import type { Context, ModuleHandle } from './context.js';
import type { Logger } from './logger.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

function builtinService<B>(name: string, bind: (ctx: Context) => B): ServiceDescriptor<never, B> {
  return markBuiltin(defineService<never, B>(name, (port: BindingPort<never>) => bind(activationOf(port))));
}

// ----- events -----

export interface Events {
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void;
  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void>;
}

export const events = builtinService<Events>('events', ctx => ({
  on: (event, handler) => ctx.on(event, handler),
  emit: (event, ...args) => ctx.emit(event, ...args),
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

export const hooks = builtinService<Hooks>('hooks', ctx => ({
  middleware: (hook, fn) => ctx.middleware(hook, fn),
  run: (hook, data, defaultAction, opts) => ctx.runHook(hook, data, defaultAction, opts),
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

export const contributions = builtinService<Contributions>('contributions', ctx => ({
  contribute: (point, spec) => ctx.contribute(point, spec),
  collect: point => ctx.collect(point),
}));

// ----- lifecycle -----

export interface LifecycleCap {
  /** 这次激活的实例 id（多实例为 `name:suffix`，子模块为 `父id#模块名`）：日志、展示、路由用的逻辑名 */
  readonly id: string;
  /** 这次激活已开始关闭 */
  readonly closed: boolean;
  /**
   * 登记收尾（最先执行）：此刻本激活的监听、登记与依赖都还在，用于停接新活、把在手的数据
   * 交给下层并等它确认。关停时消费者先于它绑定过的提供者关闭，所以这里调下层是安全的。
   */
  onDrain(fn: () => void | Promise<void>, label?: string): () => void;
  /** 登记清理（清理段）：此时本激活的全部对外登记已撤回；声明的依赖仍可调用 */
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
  /**
   * 挂一个子模块：独立身份与生命周期，能力按子激活重新绑定，随父关闭。子模块不进调度器：
   * 挂载时缺 required 服务即拒绝（抛错，apply 不执行）；挂载之后不再设闸——提供者离场时
   * 登记排队、引用可能为空，由父模块决定是否关掉它。
   */
  module(definition: ModuleDefinition, config?: Record<string, unknown>): Promise<ModuleHandle>;
}

/** 子模块定义在 plugin-definition.ts 里收窄为 PluginDefinition；这里只需要 name 与装配入口 */
export interface ModuleDefinition {
  readonly name: string;
  /** @internal 由 definePlugin 填入：required 服务名 */
  readonly requires: readonly string[];
  /** @internal 由 definePlugin 填入 */
  readonly mount: (ctx: Context, config: Record<string, unknown>) => void | Promise<void>;
}

export const lifecycle = builtinService<LifecycleCap>('lifecycle', ctx => ({
  id: ctx.id,
  get closed() {
    return ctx.disposed;
  },
  onDrain: (fn, label) => ctx.onDrain(fn, label),
  onDispose: (fn, label) => ctx.onDispose(fn, label),
  module: async (definition, config = {}) => {
    const missing = definition.requires.filter(name => ctx.getService(name) === undefined);
    if (missing.length > 0) {
      throw new Error(`子模块 "${definition.name}" 缺少 required 服务 [${missing.join(', ')}]，未挂载`);
    }
    return ctx.useModule({ name: definition.name, apply: (child, cfg) => definition.mount(child, cfg) }, config);
  },
}));

// ----- logger / config -----

export const logger = builtinService<Logger>('logger', ctx => ctx.logger);

const activationConfig = new WeakMap<Context, Readonly<Record<string, unknown>>>();

/** @internal 装配前由激活路径写入这次激活的插件配置 */
export function setActivationConfig(ctx: Context, config: Record<string, unknown>): void {
  activationConfig.set(ctx, config);
}

/** 插件自己的配置视图（只读）。宿主级的配置管理是另一项能力，不默认发给插件。 */
export const config = builtinService<Readonly<Record<string, unknown>>>(
  'config',
  ctx => activationConfig.get(ctx) ?? {},
);

// ----- services（提供与动态查找）-----

// biome-ignore lint/suspicious/noExplicitAny: 描述符泛型只作推导载体
type AnyDescriptor = ServiceDescriptor<any, any>;

/** 发布服务：唯一的发布入口。实现按描述符的提供者类型约束；返回退订，随这次激活撤回。 */
export type Provide = <D extends AnyDescriptor>(
  descriptor: D,
  implementation: ProviderOf<D>,
  options?: { priority?: number; label?: string; entryId?: string },
) => () => void;

export const provide = builtinService<Provide>(
  'provide',
  ctx => (descriptor, implementation, options) => ctx.provide(descriptor.name, implementation as never, options),
);

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

export const services = builtinService<Services>('services', ctx => ({
  get: key => ctx.getService(keyName(key)),
  all: key => ctx.getAllServices(keyName(key)),
  names: () => ctx.getServiceNames(),
  preferred: key => ctx.getPreferredService(keyName(key)),
  prefer: (key, contextId) => ctx.preferService(keyName(key), contextId),
  unprefer: key => ctx.unpreferService(keyName(key)),
}));
