// ============================================================
// descriptors.ts — 服务声明、类型推导与资源端口契约
//
// 一个服务有两张面：共享的提供者（容器中的实现，可有多个提供者）与按激活绑定的调用接口
// （每次插件激活一份，登记自动归属这次激活）。描述符把两者连起来：契约包导出描述符，
// 消费方在 uses 里声明它，装配时由描述符自带的 bind 为这次激活造接口。
//
// binder 随消费方 import 的那份契约包走：类型与绑定实现同版本，不需要宿主登记装配表，
// 也不需要 import 时的进程全局副作用；服务身份是描述符的 name，契约包装了两份也指向同一服务。
// ============================================================

import type { ServiceView } from '../primitives/services.js';

import type { Logger } from '../infrastructure/logger.js';

/**
 * 跟随回调的返回：不需要清理就什么都不返回，需要就返回清理函数。用 void 而非 undefined，
 * 块体回调不必写 `return undefined`；联合里的 void 不吞 Promise，async 回调照样被类型拒掉。
 */
// biome-ignore lint/suspicious/noConfusingVoidType: 见上——这里要的正是「可以不返回」
export type FollowCleanup = void | (() => unknown);

/**
 * 普通调用型服务的绑定接口。契约是「每次查询解析当前值」：current / require 返回的是提供者本身，
 * 调用方把它存起来就得自己承担它失效；要用提供者建立长期状态（SDK 句柄、订阅）走 follow。
 * required 与 optional 拿到的是同一接口——两者只差激活闸。
 */
export interface ServiceRef<P> {
  /** 当前胜者（偏好 > 优先级 > 注册顺序）；无提供者为 undefined */
  readonly current: P | undefined;
  /** 取当前胜者，无提供者抛错。required 依赖丢失到调度收敛之间也可能短暂为空。 */
  require(): P;
  /** 本服务的全部提供者（偏好 > 优先级 > 注册顺序），每次调用重新枚举 */
  all(): ServiceView<P>[];
  /**
   * 跟随提供者建立有状态资源：在场即调 attach，换人时先跑上次返回的清理再用新实例调，
   * 下线与关闭时清理。清理可以是异步的，关闭会等它落地。
   * attach 本身必须同步，见 {@link FollowCleanup}。
   */
  follow(attach: (provider: P) => FollowCleanup): () => void;
}

/** 注册型能力的账本：同键替换、提供者换人整体重挂、关闭后拒收、异步撤回被关闭等待。 */
export interface Registrar<Item> {
  /** 登记一条；返回退订（按条目身份，旧退订对已被替换的登记无动作） */
  add(item: Item): () => void;
}

/**
 * 一次激活的资源口：能力作者接入生命周期的全部接口。不暴露激活记录本身，
 * 不含清扫凭据——经它登记的每一条都由这次激活的撤回段逐条撤回。
 */
export interface BindingPort<P> {
  /** 所绑定的服务名 */
  readonly name: string;
  /** 实例 id：日志、展示、路由用的逻辑名，不是资源身份 */
  readonly id: string;
  /**
   * 这次激活的资源身份（不透明）。提供者据它把登记归到这次激活、核对调用方；
   * 它是凭据：交给谁，谁就能以这次激活的名义调用认它的提供者。
   */
  readonly identity: symbol;
  readonly logger: Logger;
  /** 当前胜者 */
  current(): P | undefined;
  /** Resolve or throw an error attributed to this host and activation. */
  require(): P;
  /** 全部提供者（偏好 > 优先级 > 注册顺序） */
  all(): ServiceView<P>[];
  /**
   * 跟随提供者建立有状态资源，串行交接：在场即调 attach（同步）；换人时先跑上次返回的清理，
   * 等它的 Promise **落定**（完成或被拒——被拒只记 warn，不代表资源已释放）之后才用新实例调
   * attach；等待期间再换人只跟到最新的。关闭或退订之后不再挂载，哪怕旧清理后来才落定。
   * 旧清理永不落定则新实例永不挂上；关闭时按超时放弃并点名。与 ServiceRef.follow 同一语义。
   */
  follow(attach: (provider: P) => FollowCleanup): () => void;
  /**
   * 登记一条随本次激活撤回的句柄；返回一次性的退订。与 registrar 同一清理契约：手动退订启动的
   * 异步清理被随后的关闭等到、拒绝被接住；关闭后登记的句柄就地执行。
   */
  track(off: () => unknown, label?: string): () => void;
  /** 注册型能力的通用账本，见 {@link Registrar} */
  registrar<Item>(options: {
    key(item: Item): string;
    register(provider: P, item: Item): () => unknown;
  }): Registrar<Item>;
}

export interface ServiceDescriptor<P, B = ServiceRef<P>> {
  readonly name: string;
  bind(port: BindingPort<P>): B;
}

/** 模块私有品牌：装配只认 optional() 盖过的包装，描述符自有 `optional` 字段不算 */
const OPTIONAL = Symbol('aalis.optional-use');
/**
 * 本副本身份。进程里装了两份 core 时，另一份造的描述符、optional 包装带的是它的身份；跨副本只共用这一个
 * 检测键（值各自私有），据此在定义校验与发布处拒绝混装——两份 core 会让日志中枢等进程级身份静默分裂。
 */
const MINTED = Symbol.for('aalis.core.minted');
const THIS_COPY = Symbol('aalis.core.copy');

/** @internal 来自另一份 @aalis/core 的对象：安装问题，注册期按 error 记 */
export class ForeignCoreError extends Error {}

function mint<T extends object>(value: T): T {
  return Object.defineProperty(value, MINTED, { value: THIS_COPY });
}

/** @internal 另一份 core 造的对象一律拒绝；没盖章的手写对象按形状放行 */
export function assertOwnCopy(value: unknown, what: string): void {
  const stamp = (value as { [MINTED]?: unknown } | null)?.[MINTED];
  if (stamp !== undefined && stamp !== THIS_COPY) {
    throw new ForeignCoreError(
      `${what}来自另一份 @aalis/core：进程里装了两份 core，只能装一份（插件以 peerDependencies 引用 core；排查见 docs/guide/third-party-plugin.md「装了两份 @aalis/core」）`,
    );
  }
}

export interface OptionalUse<P, B> {
  readonly optional: ServiceDescriptor<P, B>;
  readonly [OPTIONAL]: true;
}

// biome-ignore lint/suspicious/noExplicitAny: 声明表的值类型只作推导载体
export type Uses = Record<string, ServiceDescriptor<any, any> | OptionalUse<any, any>>;

export type BoundOf<U extends Uses> = {
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  [K in keyof U]: U[K] extends ServiceDescriptor<any, infer B>
    ? B
    : // biome-ignore lint/suspicious/noExplicitAny: 同上
      U[K] extends OptionalUse<any, infer B>
      ? B
      : never;
};

/** 描述符对应的提供者类型（`provide(desc, impl)` 的实现约束） */
// biome-ignore lint/suspicious/noExplicitAny: 同上
export type ProviderOf<D> = D extends ServiceDescriptor<infer P, any> ? P : never;

/**
 * 定义一个服务。不给 bind 即普通调用型：绑定接口是 {@link ServiceRef}；
 * 注册型能力给 bind，用资源口的 registrar / follow / track 造自动归属的门面。
 */
export function defineService<P>(name: string): ServiceDescriptor<P, ServiceRef<P>>;
export function defineService<P, B>(name: string, bind: (port: BindingPort<P>) => B): ServiceDescriptor<P, B>;
export function defineService<P, B>(name: string, bind?: (port: BindingPort<P>) => B): ServiceDescriptor<P, B> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('服务 name 不能为空');
  }
  return mint({ name, bind: bind ?? (serviceRef as unknown as (port: BindingPort<P>) => B) });
}

/** 可选依赖：只是不参与激活闸；绑定接口与 required 完全相同。 */
export function optional<P, B>(descriptor: ServiceDescriptor<P, B>): OptionalUse<P, B> {
  return mint({ optional: descriptor, [OPTIONAL]: true });
}

/** @internal 是否为 optional() 包装。不看自有 `optional` 字段。 */
// biome-ignore lint/suspicious/noExplicitAny: 与 Uses 的 any 载体一致
export function isOptional(use: unknown): use is OptionalUse<any, any> {
  return typeof use === 'object' && use !== null && (use as { [OPTIONAL]?: boolean })[OPTIONAL] === true;
}

// biome-ignore lint/suspicious/noExplicitAny: 与 Uses 的 any 载体一致
function unwrapDescriptor(use: Uses[string]): ServiceDescriptor<any, any> {
  return isOptional(use) ? use.optional : use;
}

/**
 * 由资源口造调用型接口。既登记又被调用的服务（如 agent：预处理器登记 + 对话调用）在自定义 bind 里
 * 把登记方法作为第二参数传入：`serviceRef(port, { registerX })`。不要用对象展开去拼——
 * `current` 是 getter，展开会把它求值成一次性的快照。
 */
export function serviceRef<P>(port: BindingPort<P>): ServiceRef<P>;
export function serviceRef<P, E extends object>(port: BindingPort<P>, extra: E): ServiceRef<P> & E;
export function serviceRef<P>(port: BindingPort<P>, extra?: object): ServiceRef<P> {
  const ref: ServiceRef<P> = {
    get current() {
      return port.current();
    },
    require: () => port.require(),
    all: () => port.all(),
    follow: attach => port.follow(attach),
  };
  return extra ? Object.assign(ref, extra) : ref;
}

/** 声明表里的依赖服务名。所有服务共用激活闸与关停边 */
function dependencyNames(uses: Uses, wantOptional: boolean): string[] {
  return Object.values(uses)
    .filter(use => isOptional(use) === wantOptional)
    .map(use => unwrapDescriptor(use))
    .map(descriptor => descriptor.name);
}

/** 参与激活闸的依赖 */
export const requiredNames = (uses: Uses): string[] => dependencyNames(uses, false);
/** 不参与激活闸的依赖 */
export const optionalNames = (uses: Uses): string[] => dependencyNames(uses, true);
