// ============================================================
// binding.ts — 服务描述符、按激活绑定、资源口
//
// 一个服务有两张面：共享的提供者（容器里的实例，全 App 一份）与按激活绑定的调用接口
// （每次插件激活一份，登记自动归属这次激活）。描述符把两者连起来：契约包导出描述符，
// 消费方在 uses 里声明它，装配时由描述符自带的 bind 为这次激活造接口。
//
// binder 随消费方 import 的那份契约包走：类型与绑定实现同版本，不需要宿主登记装配表，
// 也不需要 import 时的进程全局副作用；服务身份是描述符的 name，契约包装了两份也指向同一服务。
// ============================================================

import { reportQuietly } from '../kernel/disposable-chain.js';

import type { Context } from './context.js';
import type { Logger } from './logger.js';

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
  /**
   * 跟随提供者建立有状态资源：在场即调 attach，换人时先跑上次返回的清理再用新实例调，
   * 下线与关闭时清理。清理可以是异步的，关闭会等它落地。取代整插件重启式的依赖更新。
   */
  follow(attach: (provider: P) => undefined | (() => unknown)): () => void;
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
  /** 实例 id：日志、展示、路由用的逻辑名，不是资源身份 */
  readonly id: string;
  readonly logger: Logger;
  /** 这次激活已开始关闭 */
  readonly closed: boolean;
  /** 当前胜者 */
  current(): P | undefined;
  /**
   * 跟随提供者建立有状态资源，串行交接：在场即调 attach（同步）；换人时先跑上次返回的清理，
   * 等它的 Promise **落定**（完成或被拒——被拒只记 warn，不代表资源已释放）之后才用新实例调
   * attach；等待期间再换人只跟到最新的。关闭或退订之后不再挂载，哪怕旧清理后来才落定。
   * 旧清理永不落定则新实例永不挂上；关闭时按超时放弃并点名。与 ServiceRef.follow 同一语义。
   */
  follow(attach: (provider: P) => undefined | (() => unknown)): () => void;
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

export interface OptionalUse<P, B> {
  readonly optional: ServiceDescriptor<P, B>;
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
  return { name, bind: bind ?? (refBinder as unknown as (port: BindingPort<P>) => B) };
}

/** 可选依赖：只是不参与激活闸；绑定接口与 required 完全相同。 */
export function optional<P, B>(descriptor: ServiceDescriptor<P, B>): OptionalUse<P, B> {
  return { optional: descriptor };
}

function refBinder<P>(port: BindingPort<P>): ServiceRef<P> {
  return {
    get current() {
      return port.current();
    },
    require() {
      const provider = port.current();
      if (provider === undefined) throw new Error(`服务不可用（"${port.id}" 的依赖当前没有提供者）`);
      return provider;
    },
    follow: attach => port.follow(attach),
  };
}

/** 内置能力的标记：绑的是激活自身，不参与激活闸，也不产生依赖边 */
// 全局 symbol：装了两份 core 时另一份副本的内置描述符仍被认出，随后在 activationOf 处明确报错，
// 而不是被当成普通服务名永远等不到提供者
const BUILTIN = Symbol.for('aalis.builtin-capability');

/** @internal */
export function markBuiltin<D extends object>(descriptor: D): D {
  return Object.assign(descriptor, { [BUILTIN]: true });
}

/** @internal */
export function isBuiltin(descriptor: object): boolean {
  return (descriptor as { [BUILTIN]?: boolean })[BUILTIN] === true;
}

// 核心内置描述符需要激活记录本身（事件总线的归属、配置视图）；对能力作者公开的资源口不含它。
const activations = new WeakMap<object, Context>();

/** @internal 仅 core 内置描述符使用 */
export function activationOf(port: BindingPort<unknown>): Context {
  const ctx = activations.get(port);
  if (!ctx) throw new Error('资源口不属于本 core 副本的任何激活（@aalis/core 必须是单副本 peer 依赖）');
  return ctx;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/** @internal 为一次激活造某个服务的资源口 */
export function createPort<P>(ctx: Context, name: string): BindingPort<P> {
  /** 调一条撤回：同步抛错就地隔离；异步结果交给激活的在飞账，关闭等到它、拒绝被接住 */
  const withdraw = (off: () => unknown, what: string): PromiseLike<unknown> | undefined => {
    let result: unknown;
    try {
      result = off();
    } catch (err) {
      reportQuietly(() => ctx.logger.warn(`${what} 撤回抛错（已忽略）:`, err));
      return undefined;
    }
    if (!isThenable(result)) return undefined;
    ctx.holdInflight(result, what);
    return result;
  };

  // 一个资源口一条提供者订阅；每个跟随者自己一台小状态机
  interface Follower {
    attach(provider: P): undefined | (() => unknown);
    /** 注册账本走的内部路径：换人不等旧撤回落定，立即挂新实例（被动注册表） */
    overlap: boolean;
    attached?: P;
    cleanup?: () => unknown;
    /** 依赖边：挂上时登记，该次挂载的撤回落定后释放 */
    releaseEdge?: () => void;
    /** 串行交接：旧清理的 Promise 尚未落定 */
    busy: boolean;
    /** attach 回调正在执行：期间的退订 / 换人只记状态，等回调返回（拿到它的清理器）后再收敛 */
    attaching: boolean;
    cancelled: boolean;
  }
  const followers: Follower[] = [];
  let live: P | undefined;
  let subscribed = false;

  /** 让一个跟随者向「当前应挂的实例」收敛；任何状态变化后都调它 */
  const pump = (follower: Follower): void => {
    if (follower.busy || follower.attaching) return;
    const desired = follower.cancelled || ctx.disposed ? undefined : live;
    if (follower.attached !== undefined && follower.attached !== desired) {
      const cleanup = follower.cleanup;
      const releaseEdge = follower.releaseEdge;
      follower.attached = undefined;
      follower.cleanup = undefined;
      follower.releaseEdge = undefined;
      const pending = cleanup ? withdraw(cleanup, name) : undefined;
      if (!pending) {
        releaseEdge?.();
      } else {
        // 落定（完成或被拒——被拒不代表资源已释放，只是不再等）之后释放依赖边
        const settled = Promise.resolve(pending).then(
          () => undefined,
          () => undefined,
        );
        if (follower.overlap) {
          settled.then(() => releaseEdge?.());
        } else {
          follower.busy = true;
          settled.then(() => {
            releaseEdge?.();
            follower.busy = false;
            pump(follower);
          });
          return;
        }
      }
    }
    if (follower.attached === undefined && desired !== undefined) {
      follower.attached = desired;
      follower.releaseEdge = ctx.retainBinding(name);
      follower.attaching = true;
      try {
        follower.cleanup = follower.attach(desired) ?? undefined;
      } catch (err) {
        reportQuietly(() => ctx.logger.warn(`${name} 跟随回调抛错（订阅保持，等下次提供者变更）:`, err));
      } finally {
        follower.attaching = false;
      }
      // 回调里取消了自己、或挂载途中又换了人：刚拿到的清理器不能丢，立刻按新目标收敛
      if (follower.cancelled || follower.attached !== live) pump(follower);
    }
  };

  const subscribe = (): void => {
    subscribed = true;
    ctx.whenService<P>(name, provider => {
      live = provider;
      for (const follower of [...followers]) pump(follower);
      return () => {
        live = undefined;
        for (const follower of [...followers]) pump(follower);
      };
    });
  };

  const follow = (attach: Follower['attach'], overlap: boolean): (() => void) => {
    if (ctx.disposed) {
      ctx.logger.warn(`"${ctx.id}" 已关闭，忽略对 ${name} 的跟随`);
      return () => {};
    }
    const follower: Follower = { attach, overlap, busy: false, attaching: false, cancelled: false };
    followers.push(follower);
    if (!subscribed) subscribe();
    else pump(follower);
    return () => {
      if (follower.cancelled) return;
      follower.cancelled = true;
      const index = followers.indexOf(follower);
      if (index >= 0) followers.splice(index, 1);
      pump(follower);
    };
  };

  const port: BindingPort<P> = {
    id: ctx.id,
    logger: ctx.logger,
    get closed() {
      return ctx.disposed;
    },
    current: () => ctx.getService<P>(name),
    follow: attach => follow(attach, false),
    track(off, label) {
      const what = label ?? name;
      // 一次性且结果记忆：无论由手动退订、另一个句柄、还是清理链先调到，发起的都是同一笔清理，
      // 清理链上的这一项返回同一个 Promise——关闭前登记的清理，关闭一定等到它
      let started = false;
      let result: PromiseLike<unknown> | undefined;
      const run = (): PromiseLike<unknown> | undefined => {
        if (!started) {
          started = true;
          result = withdraw(off, what);
        }
        return result;
      };
      const dispose = ctx.trackWithdrawal(run, what);
      return () => {
        if (started) return;
        ctx.untrackWithdrawal(dispose);
        run();
      };
    },
    registrar<Item>(options: {
      key(item: Item): string;
      register(provider: P, item: Item): () => unknown;
    }): Registrar<Item> {
      interface Entry {
        item: Item;
        off?: () => unknown;
      }
      const entries = new Map<string, Entry>();
      let provider: P | undefined;

      const attachOne = (target: P, entry: Entry, key: string): void => {
        // register 回调里重入 add 的条目已经就地登记过了：再挂一次会把它的句柄覆盖掉、永不撤回
        if (entry.off !== undefined) return;
        try {
          entry.off = options.register(target, entry.item);
        } catch (err) {
          // 单条失败不拖垮同批：条目留在账上，下次提供者变更时重试
          reportQuietly(() => ctx.logger.warn(`${name} 登记 "${key}" 失败（保留待重试）:`, err));
        }
      };

      // 账本创建即跟随：同口多账本的重挂次序 = 创建次序（如分组先于工具），不取决于谁先被登记。
      // 被动注册表换人时立即重挂（旧条目的撤回在后台落定、关闭会等）——走内部的 overlap 路径
      follow(target => {
        provider = target;
        for (const [key, entry] of [...entries]) attachOne(target, entry, key);
        return () => {
          provider = undefined;
          const pending: PromiseLike<unknown>[] = [];
          for (const [key, entry] of entries) {
            const off = entry.off;
            entry.off = undefined;
            const result = off ? withdraw(off, `${name} "${key}"`) : undefined;
            if (result) pending.push(result);
          }
          // 返回聚合 Promise 只为让依赖边留到整批撤回落定；拒绝已各自接住
          return pending.length === 0 ? undefined : Promise.allSettled(pending);
        };
      }, true);

      return {
        add(item: Item) {
          const key = options.key(item);
          if (ctx.disposed) {
            ctx.logger.warn(`"${ctx.id}" 已关闭，忽略 ${name} 登记 "${key}"`);
            return () => {};
          }
          const previous = entries.get(key);
          if (previous?.off) {
            const off = previous.off;
            previous.off = undefined;
            withdraw(off, `${name} "${key}"`);
          }
          const entry: Entry = { item };
          // 提供者在场即登记；register 抛错原样抛给调用方，账上不留半条——同键替换失败时
          // 旧登记已撤，旧条目一并出账，不会在下次换提供者时复活
          if (provider !== undefined) {
            try {
              entry.off = options.register(provider, item);
            } catch (err) {
              entries.delete(key);
              throw err;
            }
          }
          entries.set(key, entry);
          return () => {
            if (entries.get(key) !== entry) return;
            entries.delete(key);
            const off = entry.off;
            entry.off = undefined;
            if (off) withdraw(off, `${name} "${key}"`);
          };
        },
      };
    },
  };
  activations.set(port, ctx);
  return port;
}

/**
 * @internal 按声明表为一次激活装配绑定接口。任一 bind 抛错即整体失败：调用方拆掉这次激活，
 * 已装配部分经撤回段回滚。
 */
export function assemble<U extends Uses>(ctx: Context, uses: U): BoundOf<U> {
  const bound: Record<string, unknown> = {};
  for (const [key, use] of Object.entries(uses)) {
    const descriptor = 'optional' in use ? use.optional : use;
    bound[key] = descriptor.bind(createPort(ctx, descriptor.name));
  }
  // 声明即计入关停编排（required 与 optional，访问与否无关）；内置能力绑的是激活自身，不成边
  ctx.declareDependencies(
    Object.values(uses)
      .map(use => ('optional' in use ? use.optional : use))
      .filter(descriptor => !isBuiltin(descriptor))
      .map(descriptor => descriptor.name),
  );
  return bound as BoundOf<U>;
}

/** 声明表里参与激活闸的服务名（optional 不参与） */
export function requiredNames(uses: Uses): string[] {
  return Object.values(uses)
    .filter((use): use is ServiceDescriptor<unknown, unknown> => !('optional' in use))
    .map(use => use.name);
}

export function optionalNames(uses: Uses): string[] {
  return Object.values(uses)
    .filter((use): use is OptionalUse<unknown, unknown> => 'optional' in use)
    .map(use => use.optional.name);
}
