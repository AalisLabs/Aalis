// ============================================================
// builtins.ts — 核心内置能力的描述符
//
// 与第三方能力同一套声明与装配：插件在 uses 里写描述符，apply 拿到按激活绑定的接口。
// 区别只在提供者的来源——内置能力绑的是这次激活自身的运行基础设施（事件总线、容器、
// 清理链），不经容器解析、不可被 provide 替换，也不参与激活闸。
// ============================================================

import type { AalisEvents } from '../types/events.js';

import type { ServiceView } from '../primitives/services.js';

import { activationOf, type BindingPort, defineService, type ProviderOf, type ServiceDescriptor } from './binding.js';
import type { Context } from './context.js';
import type { Logger } from './logger.js';

type EventHandler<Args extends unknown[]> = (...args: Args) => void | Promise<void>;

/** 内置描述符的标记：装配时不参与激活闸 */
export const KERNEL = Symbol('aalis.kernel-capability');

function kernelService<B>(name: string, bind: (ctx: Context) => B): ServiceDescriptor<never, B> {
  const descriptor = defineService<never, B>(name, (port: BindingPort<never>) => bind(activationOf(port)));
  return Object.assign(descriptor, { [KERNEL]: true });
}

export function isKernelService(descriptor: ServiceDescriptor<unknown, unknown>): boolean {
  return (descriptor as { [KERNEL]?: boolean })[KERNEL] === true;
}

// ----- events -----

export interface Events {
  on<E extends string & keyof AalisEvents>(event: E, handler: EventHandler<AalisEvents[E]>): () => void;
  emit<E extends string & keyof AalisEvents>(event: E, ...args: AalisEvents[E]): Promise<void>;
}

export const events = kernelService<Events>('events', ctx => ({
  on: (event, handler) => ctx.on(event, handler),
  emit: (event, ...args) => ctx.emit(event, ...args),
}));

// ----- lifecycle -----

export interface ModuleHandle {
  dispose(): void;
  disposeAsync(timeoutMs?: number): Promise<void>;
}

export interface LifecycleCap {
  /** 这次激活已开始关闭 */
  readonly closed: boolean;
  /** 登记清理（清理段）：此时本激活的全部对外登记已撤回 */
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
  /** 挂一个子模块：独立身份与生命周期，能力按子激活重新绑定，随父关闭 */
  module(definition: ModuleDefinition, config?: Record<string, unknown>): Promise<ModuleHandle>;
}

/** 子模块定义在 plugin-definition.ts 里收窄为 PluginDefinition；这里只需要 name 与装配入口 */
export interface ModuleDefinition {
  readonly name: string;
  /** @internal 由 definePlugin 填入 */
  readonly mount: (ctx: Context, config: Record<string, unknown>) => void | Promise<void>;
}

export const lifecycle = kernelService<LifecycleCap>('lifecycle', ctx => ({
  get closed() {
    return ctx.disposed;
  },
  onDispose: (fn, label) => ctx.onDispose(fn, label),
  module: (definition, config = {}) =>
    ctx.useModule({ name: definition.name, apply: (child, cfg) => definition.mount(child, cfg) }, config),
}));

// ----- logger / config -----

export const logger = kernelService<Logger>('logger', ctx => ctx.logger);

const activationConfig = new WeakMap<Context, Readonly<Record<string, unknown>>>();

/** @internal 装配前由激活路径写入这次激活的插件配置 */
export function setActivationConfig(ctx: Context, config: Record<string, unknown>): void {
  activationConfig.set(ctx, config);
}

/** 插件自己的配置视图（只读）。宿主级的配置管理是另一项能力，不默认发给插件。 */
export const config = kernelService<Readonly<Record<string, unknown>>>(
  'config',
  ctx => activationConfig.get(ctx) ?? {},
);

// ----- services（提供与动态查找）-----

// biome-ignore lint/suspicious/noExplicitAny: 描述符泛型只作推导载体
type AnyDescriptor = ServiceDescriptor<any, any>;

export interface Services {
  /** 提供一个服务；实现按描述符的提供者类型约束。返回退订，随这次激活撤回。 */
  provide<D extends AnyDescriptor>(
    descriptor: D,
    implementation: ProviderOf<D>,
    options?: { priority?: number; label?: string; entryId?: string },
  ): () => void;
  /** 当前胜者（动态查找；常规依赖请走 uses 声明） */
  get<D extends AnyDescriptor>(descriptor: D): ProviderOf<D> | undefined;
  all<D extends AnyDescriptor>(descriptor: D): ServiceView<ProviderOf<D>>[];
  prefer(descriptor: AnyDescriptor, contextId: string): boolean;
  unprefer(descriptor: AnyDescriptor): boolean;
}

export const services = kernelService<Services>('services', ctx => ({
  provide: (descriptor, implementation, options) => ctx.provide(descriptor.name, implementation as never, options),
  get: descriptor => ctx.getService(descriptor.name),
  all: descriptor => ctx.getAllServices(descriptor.name),
  prefer: (descriptor, contextId) => ctx.preferService(descriptor.name, contextId),
  unprefer: descriptor => ctx.unpreferService(descriptor.name),
}));

/** 宿主预设的默认注入：每个插件免声明即得 */
export const defaultUses = { events, logger, lifecycle, config } as const;
export type DefaultCaps = {
  events: Events;
  logger: Logger;
  lifecycle: LifecycleCap;
  config: Readonly<Record<string, unknown>>;
};
