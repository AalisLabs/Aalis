import { isThenable } from '../kernel/disposable-chain.js';

import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer, ServiceEntry } from '../primitives/services.js';

import type { BindingPort, FollowCleanup, Registrar, ServiceDescriptor, ServiceSelection } from './descriptors.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

// 只认框架为本次激活装配的 required 依赖的 use 句柄；optional、of(id)、动态查询与自造端口不借用重试资格。
class ServiceUnavailableError extends Error {
  override name = 'ServiceUnavailableError';
  readonly #origin: { resources: Resources; name: string } | undefined;

  constructor(scope: BindingScope, name: string, required: boolean, id: string | undefined) {
    const missing = id === undefined ? '提供者' : ` "${id}" 这一家`;
    super(`服务 "${name}" 不可用（"${scope.id}" 声明的依赖当前没有${missing}）`);
    this.#origin = required ? { resources: scope.resources, name } : undefined;
  }

  static missingIn(error: unknown, resources: Resources, required: readonly string[]): string | undefined {
    const origin = error instanceof ServiceUnavailableError && #origin in error ? error.#origin : undefined;
    return origin?.resources === resources && required.includes(origin.name) ? origin.name : undefined;
  }
}

/**
 * 初始化失败归因：本次激活 required 依赖的 use 句柄抛出的不可用错误，返回所缺的服务名；其余错误返回 undefined。
 * 来源身份随激活变化，重抛上一轮错误不能触发下一轮重试。
 * @internal
 */
export function missingRequiredService(
  error: unknown,
  resources: Resources,
  required: readonly string[],
): string | undefined {
  return ServiceUnavailableError.missingIn(error, resources, required);
}

/** 绑定只需要资源账与服务读取，不持有整个激活或插件管理器。 */
interface BindingScope {
  /** 消费方实例 id：本插件偏好认它 */
  readonly id: string;
  /** 清理归属：原语登记与关停边认它，不是逻辑 id */
  readonly owner: symbol;
  readonly logger: Logger;
  readonly resources: Resources;
  readonly services: Pick<ServiceContainer, 'ranked'>;
  readonly events: EventBus;
  /** 登记跟随边：挂上的那一条归 owner 提供；提供者撤回时经 pump 就地驱动交接；释放时带上撤回的落定 */
  retainBinding(owner: symbol, name: string, pump: () => void): (settling?: Promise<void>) => void;
}

/**
 * 活句柄：每次访问成员都经 resolve 取当前实例，缺席时 resolve 同步抛错。then、symbol 键、toJSON 不转发：
 * `await` 句柄不会把它当成 thenable，打印与序列化不触发解析。取到的方法在调用时才再解析，以真实实例作 this 调用，
 * 用 # 私有字段的提供者才不会出错；属性在读取时解析。目标取 resolve 本身（一个函数），提供者是函数时句柄可直接调用。
 */
function forward<P>(resolve: () => P): P {
  return new Proxy(resolve, {
    get(_, key) {
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      const value = (resolve() as Record<string, unknown>)[key];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const self = resolve() as Record<string, (...args: unknown[]) => unknown>;
        return Reflect.apply(self[key], self, args);
      };
    },
    apply: (_, __, args) => Reflect.apply(resolve() as (...args: unknown[]) => unknown, undefined, args),
  }) as P;
}

/**
 * 为一次激活造某个服务的选择层（caps.xxx）
 * @internal
 */
export function createSelection<P, B>(
  scope: BindingScope,
  descriptor: ServiceDescriptor<P, B>,
  required: boolean,
): ServiceSelection<B> {
  type Target = ReturnType<typeof createTarget<P, B>>;
  const targets = new Map<string | undefined, Target>();
  const target = (id?: string) => {
    if (!targets.has(id)) targets.set(id, createTarget(scope, descriptor, required && id === undefined, id));
    return targets.get(id)!;
  };
  const selected = target();
  // list() 条目的句柄钉在那一条登记：对外时打到它，之后访问抛错；不再对外的在下次 list() 时退役
  const listed = new Map<ServiceEntry, Target>();
  // follow 交给 attach 的句柄钉在挂上的这一条登记：同 id 换了新实例也打不到新的；这次挂载的清理落定之前一直可用
  const pin = (entry: ServiceEntry, attach: (handle: B) => FollowCleanup): FollowCleanup => {
    const pinned = createTarget(scope, descriptor, false, entry);
    let ret: FollowCleanup;
    try {
      ret = attach(pinned.business);
    } catch (err) {
      pinned.retire();
      throw err;
    }
    // 违约的异步 attach 没有清理可等：句柄当场失效，Promise 原样交回由跟随者告警
    if (isThenable(ret)) {
      pinned.retire();
      return ret;
    }
    return () => {
      let result: unknown;
      try {
        result = typeof ret === 'function' ? ret() : undefined;
        return isThenable(result) ? Promise.resolve(result).finally(pinned.retire) : result;
      } finally {
        if (!isThenable(result)) pinned.retire();
      }
    };
  };
  return {
    list: () => {
      const { entries, basis } = scope.services.ranked(descriptor.name, scope.id);
      for (const [entry, gone] of listed) {
        if (entries.includes(entry)) continue;
        listed.delete(entry);
        gone.retire();
      }
      return entries.map((entry, i) => ({
        id: entry.contextId,
        label: entry.label,
        priority: entry.priority,
        selected: i === 0,
        basis: i === 0 ? basis : undefined,
        get use() {
          if (!listed.has(entry)) listed.set(entry, createTarget(scope, descriptor, false, entry, true));
          return listed.get(entry)!.business;
        },
      }));
    },
    use: selected.business,
    of: id => target(id).business,
    get present() {
      return selected.current() !== undefined;
    },
    follow: attach => selected.follow(entry => pin(entry, attach), false),
  };
}

/**
 * 一个目标：`use` 的是本插件选中的那一家（at 为 undefined），`of(id)` 的固定 id 那一家，钉住的是那一条登记本身（at 为
 * 登记：follow 的 retire 之前一直是它，list() 的另要它仍对外，即 listed）。交出此刻对应的那一条（current）、跟随它的入口
 * （follow，overlap 见 Follower）、bind 给它的业务句柄（business），以及退役（retire：钉住的目标失效，名下的跟随者收尾并
 * 退订，bind 经资源口登记的切断项与 track 一并撤掉）
 */
function createTarget<P, B>(
  scope: BindingScope,
  descriptor: ServiceDescriptor<P, B>,
  required: boolean,
  at?: string | ServiceEntry,
  listed = false,
) {
  const { name } = descriptor;
  const id = typeof at === 'object' ? at.contextId : at;
  const withdraw = (off: () => unknown, what: string) => scope.resources.withdraw(off, what);

  let retired = false;
  const ranked = (): readonly ServiceEntry[] => scope.services.ranked(name, scope.id).entries;
  const current = (): ServiceEntry | undefined => {
    if (typeof at === 'object') return retired || (listed && !ranked().includes(at)) ? undefined : at;
    return id === undefined ? ranked()[0] : ranked().find(entry => entry.contextId === id);
  };
  const instance = (): P => {
    const entry = current();
    if (!entry) throw new ServiceUnavailableError(scope, name, required, id);
    return entry.instance as P;
  };

  // 一个目标一条提供者订阅；每个跟随者自己一台小状态机
  interface Follower {
    attach(entry: ServiceEntry): FollowCleanup;
    /** 注册账本走的内部路径：换人不等旧撤回落定，立即挂新的（被动注册表）；它的清理逐条自行记账 */
    overlap: boolean;
    attached?: ServiceEntry;
    cleanup?: () => unknown;
    /** 依赖边：挂上时登记，该次挂载的撤回落定后释放 */
    releaseEdge?: (settling?: Promise<void>) => void;
    /** 串行交接：旧清理的 Promise 尚未落定 */
    busy: boolean;
    /** attach 回调正在执行：期间的退订 / 换人只记状态，等回调返回（拿到它的清理器）后再收敛 */
    attaching: boolean;
    cancelled: boolean;
  }
  const followers = new Set<Follower>();
  let unwatch: (() => unknown) | undefined;
  /** 本目标经资源口登记的切断项与 track 的摘除：钉住的目标退役时撤掉，不留到激活关闭 */
  const owned = new Set<() => unknown>();

  const desired = (follower: Follower): ServiceEntry | undefined =>
    follower.cancelled || scope.resources.disposed ? undefined : current();

  /** 让一个跟随者向「当前应挂的那一条」收敛；任何状态变化后都调它 */
  const pump = (follower: Follower): void => {
    if (follower.busy || follower.attaching) return;
    let next = desired(follower);
    if (follower.attached !== undefined && follower.attached !== next) {
      const cleanup = follower.cleanup;
      const releaseEdge = follower.releaseEdge;
      follower.attached = undefined;
      follower.cleanup = undefined;
      follower.releaseEdge = undefined;
      // 旧清理同步段内的重入 pump 让步：它可能同步改选择，新的一家须等本次收敛决定
      follower.busy = true;
      // 注册账本交回的聚合只为依赖边，不再记一次账
      const pending = cleanup && (follower.overlap ? cleanup() : withdraw(cleanup, name));
      follower.busy = false;
      // 落定（完成或被拒——被拒不代表资源已释放，只是不再等）之后释放依赖边；提供者撤回段等它
      const settled = isThenable(pending)
        ? Promise.resolve(pending).then(
            () => undefined,
            () => undefined,
          )
        : undefined;
      releaseEdge!(settled);
      if (settled && !follower.overlap) {
        follower.busy = true;
        settled.then(() => {
          follower.busy = false;
          pump(follower);
        });
        return;
      }
    }
    // 旧清理可以同步改偏好、退订或关闭；不能拿回调之前的选择继续挂载。
    next = desired(follower);
    if (follower.attached === undefined && next !== undefined) {
      follower.attached = next;
      follower.releaseEdge = scope.retainBinding(next.owner, name, () => pump(follower));
      follower.attaching = true;
      try {
        const ret: unknown = follower.attach(next);
        if (typeof ret === 'function') {
          follower.cleanup = ret as () => unknown;
        } else if (isThenable(ret)) {
          // attach 同步契约：不 await 取 cleanup；接住拒绝以免逃成 unhandledRejection
          scope.logger.warn(
            `${name} 跟随回调返回了 thenable（attach 应同步返回 cleanup 函数；该 Promise 已被接住，拒绝不会逃逸）`,
          );
          ret.then(undefined, () => undefined);
        }
      } catch (err) {
        scope.logger.warn(`${name} 跟随回调抛错（订阅保持，等下次提供者变更）:`, err);
      } finally {
        follower.attaching = false;
      }
      // 回调里取消了自己、或挂载途中又换了人：刚拿到的清理器不能丢，立刻按新目标收敛
      if (follower.cancelled || scope.resources.disposed || follower.attached !== desired(follower)) pump(follower);
    }
  };

  const pumpAll = (): void => {
    for (const follower of [...followers]) pump(follower);
  };

  // 选择可能变化时让全部跟随者收敛（pump 自己去重）。拆卸窗口内的服务事件不引爆清理，由撤回段统一收
  const subscribe = (): void => {
    const off = scope.events.on('service:changed', service => {
      if (service === name && !scope.resources.disposed) pumpAll();
    });
    unwatch = scope.resources.trackWithdrawal(() => {
      off();
      pumpAll();
    }, `watch:${name}`);
  };

  const follow = (attach: Follower['attach'], overlap: boolean): (() => void) => {
    if (scope.resources.disposed) {
      scope.logger.warn(`"${scope.id}" 已关闭，忽略对 ${name} 的跟随`);
      return () => {};
    }
    const follower: Follower = { attach, overlap, busy: false, attaching: false, cancelled: false };
    followers.add(follower);
    // 登记账本的条目是本激活对外可见的能力，关闭时与原语同一拍撤掉，不等下游交接
    if (overlap) owned.add(scope.resources.onCut(() => pump(follower)));
    if (!unwatch) subscribe();
    pump(follower);
    return () => {
      if (follower.cancelled) return;
      follower.cancelled = true;
      followers.delete(follower);
      pump(follower);
    };
  };

  const port: BindingPort<P> = {
    id: scope.id,
    identity: scope.owner,
    logger: scope.logger,
    get present() {
      return current() !== undefined;
    },
    provider: forward(instance),
    follow: attach => follow(entry => attach(entry.instance as P), false),
    track: (off, label) => {
      const dispose = scope.resources.track(() => {
        owned.delete(dispose);
        return off();
      }, label ?? name);
      owned.add(dispose);
      return dispose;
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
        if (entries.get(key) !== entry || entry.off !== undefined || provider !== target || scope.resources.disposed)
          return;
        const off = options.register(target, entry.item);
        // register 也能替换当前键、切换提供者或关闭激活。回调返回时重新核验所有权，
        // 失效登记就地撤回；不得覆盖重入调用已接住的句柄。
        if (entries.get(key) === entry && provider === target && !scope.resources.disposed && entry.off === undefined) {
          entry.off = off;
        } else {
          withdraw(off, `${name} "${key}"`);
        }
      };

      // 账本创建即跟随：同口多账本的重挂次序 = 创建次序（如分组先于工具），不取决于谁先被登记。
      // 被动注册表换人时立即重挂（旧条目的撤回在后台落定、关闭会等）——走内部的 overlap 路径
      follow(entry => {
        const target = entry.instance as P;
        provider = target;
        // 按键再取当前 Entry：register 回调里重入 add 会换掉 map 里的对象，
        // 快照里的旧 Entry 再挂一次就是账外孤儿。新 Entry 已就地登记则 attachOne 跳过。
        for (const key of [...entries.keys()]) {
          const item = entries.get(key);
          if (!item) continue;
          try {
            attachOne(target, item, key);
          } catch (err) {
            // 单条失败不拖垮同批：当前条目留在账上，下次提供者变更时重试
            scope.logger.warn(`${name} 登记 "${key}" 失败（保留待重试）:`, err);
          }
        }
        return () => {
          provider = undefined;
          const pending: PromiseLike<unknown>[] = [];
          for (const [key, item] of entries) {
            const off = item.off;
            item.off = undefined;
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
          if (scope.resources.disposed) {
            scope.logger.warn(`"${scope.id}" 已关闭，忽略 ${name} 登记 "${key}"`);
            return () => {};
          }
          const previous = entries.get(key);
          const entry: Entry = { item };
          // 先占位再执行任何用户回调：旧 off 或新 register 的重入替换都必须成为最新条目。
          entries.set(key, entry);
          if (previous?.off) {
            const off = previous.off;
            previous.off = undefined;
            withdraw(off, `${name} "${key}"`);
          }
          // 提供者在场即登记；register 抛错原样抛给调用方，账上不留半条——同键替换失败时
          // 旧登记已撤，旧条目一并出账，不会在下次换提供者时复活
          if (provider !== undefined) {
            try {
              attachOne(provider, entry, key);
            } catch (err) {
              if (entries.get(key) === entry) entries.delete(key);
              throw err;
            }
          }
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
  const retire = (): void => {
    retired = true;
    unwatch?.();
    for (const remove of [...owned]) remove();
  };
  return { current, follow, business: descriptor.bind(port), retire };
}
