// ============================================================
// descriptors.ts — 服务声明、类型推导与资源端口契约
//
// caps.xxx 分两层。上层是选择层（ServiceSelection），由 core 定义、每个服务都一样，只管选哪一家；下层是业务层，
// 由契约定义：默认就是提供者的形状（活的转发句柄），契约给了 bind 就是 bind 的返回值。描述符把两层连起来：
// 契约包导出描述符，消费方在 uses 里声明它，装配时 core 造选择层，每个目标（`use` 与各个 `of(id)`）各调一次 bind。
//
// binder 随消费方 import 的那份契约包走：类型与绑定实现同版本，不需要宿主登记装配表，
// 也不需要 import 时的进程全局副作用；服务身份是描述符的 name，契约包装了两份也指向同一服务。
// ============================================================

import type { SelectionBasis } from '../primitives/services.js';

import type { Logger } from '../infrastructure/logger.js';

/**
 * 跟随回调的返回：不需要清理就什么都不返回，需要就返回清理函数。用 void 而非 undefined，
 * 块体回调不必写 `return undefined`；联合里的 void 不吞 Promise，async 回调照样被类型拒掉。
 */
// biome-ignore lint/suspicious/noConfusingVoidType: 见上——这里要的正是「可以不返回」
export type FollowCleanup = void | (() => unknown);

/** 选择层里的一家提供者：元数据与它的业务句柄 */
export interface ProviderEntry<B> {
  /** 条目的逻辑身份（contextId） */
  readonly id: string;
  readonly label?: string;
  readonly priority: number;
  /** 是否为本插件当前选中的那一家，即 `use` 此刻打到的那一家 */
  readonly selected: boolean;
  /** 选中依据，只在选中的那一条上有 */
  readonly basis?: SelectionBasis;
  /**
   * 钉在这一条登记上的业务句柄：它对外时打到它，撤回之后访问抛错，同一个 id 换了新实例也不跟过去（`of(id)` 按 id，
   * 会跟过去）。同一条登记每次列出都是同一个句柄
   */
  readonly use: B;
}

/**
 * caps.xxx：选择层，只读。挑选只有一条规则：本插件偏好 > 全局偏好 > 优先级 > 注册顺序，偏好指向的那家不在就按下一级挑、
 * 回来后自动切回；偏好由用户经管理面（`services.prefer`）设。业务句柄是活的：每次访问成员都重新解析，存起来也安全；
 * 访问时选不到提供者就同步抛错。错误类不导出：可选依赖先看 `present`，接错误时认 `err.name === 'ServiceUnavailableError'`。
 * 已经开始的一次调用在原来那一家上完成；一段操作要固定同一家，取 `list()` 里选中那一条的 `use`。
 */
export interface ServiceSelection<B> {
  /** 每次调用重新枚举对外可见的提供者（转入后台、尚未完成激活的不在内），本插件选中的那一条在前 */
  list(): ProviderEntry<B>[];
  /** 默认业务句柄：转发给本插件当前选中的那一家 */
  readonly use: B;
  /**
   * 固定某一家的业务句柄：那一家不在时访问成员抛错，同一个 id 回来后照常可用。内置项的业务句柄在取句柄时就取门面，
   * 对根以外的 id 调 of 当场抛错
   */
  of(id: string): B;
  /** 本插件此刻能否选到一家 */
  readonly present: boolean;
  /**
   * 有状态资源：选得到即以选中那一家的业务句柄调 attach；换人时先跑上次返回的清理（是异步的就等它落定），再挂新的；
   * 选不到时只清理；下线与关闭时清理。attach 必须同步，见 {@link FollowCleanup}。交给 attach 的句柄钉在挂上的这一条
   * 登记：那一家撤回、或同一个 id 换了新实例，它仍打到原来那一家，直到这次挂载的清理落定，之后访问抛错
   */
  follow(attach: (handle: B) => FollowCleanup): () => void;
}

/** 注册型能力的账本：同键替换、目标换人整体重挂、关闭后拒收、异步撤回被关闭等待。 */
export interface Registrar<Item> {
  /** 登记一条；返回退订（按条目身份，旧退订对已被替换的登记无动作） */
  add(item: Item): () => void;
}

/**
 * 绑定的资源口：契约作者接入生命周期的全部接口，不暴露激活记录，不含清扫凭据——经它登记的每一条都由这次激活的
 * 撤回段逐条撤回。bind 对每个目标调一次：`use` 的目标是本插件选中的那一家（随偏好与上下线换人），`of(id)` 的目标
 * 固定那一家；返回值就是该目标的业务句柄。bind 可以包装业务方法（如给调用盖上调用方 id）、加登记方法，改不了选谁。
 * 要在转发之上加或改几个成员，用 `Object.create(port.provider, …)` 或 `Object.assign(Object.create(port.provider), …)`：
 * 没覆盖的成员沿原型链落到活句柄上。
 */
export interface BindingPort<P> {
  /** 消费方的实例 id：日志、展示、路由用的逻辑名，不是资源身份 */
  readonly id: string;
  /**
   * 这次激活的资源身份（不透明），即调用方身份：提供者据它认出调用方、把登记归到这次激活。
   * 每次激活各不相同，同一 id 的前后两次激活也不同；按插件持久的状态用 id。
   */
  readonly identity: symbol;
  readonly logger: Logger;
  /** 目标那一家此刻在不在，与选择层的 `present` 同口径 */
  readonly present: boolean;
  /** 目标那一家的活句柄，规则同选择层的业务句柄（缺席时访问成员抛错）；提供者是函数时可直接调用 */
  readonly provider: P;
  /**
   * 跟随目标建立有状态资源，串行交接：目标在场即以实例调 attach（同步）；换人时先跑上次返回的清理，
   * 等它的 Promise **落定**（完成或被拒——被拒只记 warn，不代表资源已释放）之后才挂新的；等待期间再换人只跟到最新的。
   * 关闭或退订之后不再挂载，哪怕旧清理后来才落定。旧清理永不落定则新的永不挂上；关闭时按超时放弃并点名。
   */
  follow(attach: (provider: P) => FollowCleanup): () => void;
  /**
   * 登记一条随本次激活撤回的句柄（binder 自己持有、不属于任何提供者的资源）；返回一次性的退订。与 registrar 同一清理契约：
   * 手动退订启动的异步清理被随后的关闭等到、拒绝被接住；关闭后登记的句柄就地执行。
   */
  track(off: () => unknown, label?: string): () => void;
  /**
   * 注册型能力的通用账本，登记到目标那一家，见 {@link Registrar}。register 返回的撤回须同步摘掉这一条，余下的异步收尾
   * 照常由关闭等待：账本不等旧撤回落定就挂新的（目标换人、同键替换），在异步段里按键删除的话，快速换人 A→B→A 或同键
   * 替换时会删掉刚挂上的新登记
   */
  registrar<Item>(options: {
    key(item: Item): string;
    register(provider: P, item: Item): () => unknown;
  }): Registrar<Item>;
}

/** 服务描述符：P 是提供者形状，B 是业务层（不给 bind 时就是 P） */
export interface ServiceDescriptor<P, B = P> {
  readonly name: string;
  bind(port: BindingPort<P>): B;
}

/** 模块私有品牌：装配只认 optional() 盖过的包装，描述符自有 `optional` 字段不算 */
const OPTIONAL = Symbol('aalis.optional-use');
/**
 * 本副本身份。进程里装了两份 core 时，另一份造的描述符、optional 包装带的是它的身份；跨副本只共用这一个
 * 检测键（值各自私有），据此在定义校验处拒绝混装——两份 core 会让日志中枢等进程级身份静默分裂。
 */
const MINTED = Symbol.for('aalis.core.minted');
const THIS_COPY = Symbol('aalis.core.copy');

function mint<T extends object>(value: T): T {
  return Object.defineProperty(value, MINTED, { value: THIS_COPY });
}

/**
 * 另一份 core 造的对象一律拒绝；没盖章的手写对象按形状放行
 * @internal
 */
export function assertOwnCopy(value: unknown, what: string): void {
  const stamp = (value as { [MINTED]?: unknown } | null)?.[MINTED];
  if (stamp !== undefined && stamp !== THIS_COPY) {
    throw new Error(
      `${what}来自另一份 @aalis/core：进程里装了两份 core，只能装一份（插件以 peerDependencies 引用 core；排查见 https://aalis.acenyan.com/guide/third-party-plugin#two-cores）`,
    );
  }
}

export interface OptionalUse<P, B> {
  readonly optional: ServiceDescriptor<P, B>;
  readonly [OPTIONAL]: true;
}

// biome-ignore lint/suspicious/noExplicitAny: 声明表的值类型只作推导载体
export type Uses = Record<string, ServiceDescriptor<any, any> | OptionalUse<any, any>>;

/** 逐项核对声明表：写错的那一项要求改成描述符，报错只落在它身上，其余绑定照常推导 */
export type CheckedUses<U> = { [K in keyof U]: U[K] extends Uses[string] ? U[K] : Uses[string] };

/** apply 的参数：每个声明一个选择层 */
export type BoundOf<U> = {
  // biome-ignore lint/suspicious/noExplicitAny: 同上
  [K in keyof U]: U[K] extends ServiceDescriptor<any, infer B>
    ? ServiceSelection<B>
    : // biome-ignore lint/suspicious/noExplicitAny: 同上
      U[K] extends OptionalUse<any, infer B>
      ? ServiceSelection<B>
      : never;
};

/** 描述符对应的提供者类型（`provide(desc, impl)` 的实现约束） */
// biome-ignore lint/suspicious/noExplicitAny: 同上
export type ProviderOf<D> = D extends ServiceDescriptor<infer P, any> ? P : never;

/**
 * 定义一个服务。不给 bind，业务层就是按 P 的形状转发的活句柄，什么都不用多写；给 bind 即自定义业务层，
 * 见 {@link BindingPort}。
 */
export function defineService<P>(name: string): ServiceDescriptor<P, P>;
export function defineService<P, B>(name: string, bind: (port: BindingPort<P>) => B): ServiceDescriptor<P, B>;
export function defineService<P, B>(name: string, bind?: (port: BindingPort<P>) => B): ServiceDescriptor<P, B> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('服务 name 不能为空');
  }
  return mint({ name, bind: bind ?? (port => port.provider as unknown as B) });
}

/** 可选依赖：只是不参与激活闸；选择层与 required 完全相同。 */
export function optional<P, B>(descriptor: ServiceDescriptor<P, B>): OptionalUse<P, B> {
  return mint({ optional: descriptor, [OPTIONAL]: true });
}

/**
 * 是否为 optional() 包装。不看自有 `optional` 字段。
 * @internal
 */
// biome-ignore lint/suspicious/noExplicitAny: 与 Uses 的 any 载体一致
export function isOptional(use: unknown): use is OptionalUse<any, any> {
  return typeof use === 'object' && use !== null && (use as { [OPTIONAL]?: boolean })[OPTIONAL] === true;
}

// biome-ignore lint/suspicious/noExplicitAny: 与 Uses 的 any 载体一致
function unwrapDescriptor(use: Uses[string]): ServiceDescriptor<any, any> {
  return isOptional(use) ? use.optional : use;
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
