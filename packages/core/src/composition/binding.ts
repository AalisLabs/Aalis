import { reportQuietly } from '../kernel/disposable-chain.js';

import type { EventBus } from '../primitives/events.js';
import type { ServiceContainer } from '../primitives/services.js';

import type { BindingPort, FollowCleanup, Registrar } from './descriptors.js';
import type { Logger } from '../infrastructure/logger.js';
import type { Resources } from '../infrastructure/resources.js';

// 只认框架为本次激活装配的 required 端口，optional / 动态查询 / 自造端口不借用重试资格。
class ServiceUnavailableError extends Error {
  readonly #origin: { resources: Resources; name: string } | undefined;

  constructor(scope: BindingScope, name: string, required: boolean) {
    super(`服务 "${name}" 不可用（"${scope.id}" 声明的依赖当前没有提供者）`);
    this.#origin = required ? { resources: scope.resources, name } : undefined;
  }

  static belongsTo(error: unknown, resources: Resources, required: readonly string[]): boolean {
    return (
      error instanceof ServiceUnavailableError &&
      #origin in error &&
      error.#origin?.resources === resources &&
      required.includes(error.#origin.name)
    );
  }
}

/** @internal 初始化失败归因：来源身份随激活变化，重抛上一轮错误不能触发下一轮重试。 */
export function isRequiredServiceUnavailable(
  error: unknown,
  resources: Resources,
  required: readonly string[],
): boolean {
  return ServiceUnavailableError.belongsTo(error, resources, required);
}

/** 绑定只需要资源账与服务读取，不持有整个激活或插件管理器。 */
interface BindingScope {
  readonly id: string;
  /** 清理归属：原语登记与关停边认它，不是逻辑 id */
  readonly owner: symbol;
  readonly logger: Logger;
  readonly resources: Resources;
  readonly services: Pick<ServiceContainer, 'get' | 'getAll'>;
  readonly events: EventBus;
  /** 登记跟随边：提供者撤回时经 pump 就地驱动交接；释放时带上撤回的落定 */
  retainBinding(name: string, pump: () => void): (settling?: Promise<void>) => void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}

/** @internal 为一次激活造某个服务的资源口 */
export function createPort<P>(scope: BindingScope, name: string, required = false): BindingPort<P> {
  const withdraw = (off: () => unknown, what: string) => scope.resources.withdraw(off, what);

  // 一个资源口一条提供者订阅；每个跟随者自己一台小状态机
  interface Follower {
    attach(provider: P): FollowCleanup;
    /** 注册账本走的内部路径：换人不等旧撤回落定，立即挂新实例（被动注册表） */
    overlap: boolean;
    attached?: P;
    cleanup?: () => unknown;
    /** 依赖边：挂上时登记，该次挂载的撤回落定后释放 */
    releaseEdge?: (settling?: Promise<void>) => void;
    /** 串行交接：旧清理的 Promise 尚未落定 */
    busy: boolean;
    /** attach 回调正在执行：期间的退订 / 换人只记状态，等回调返回（拿到它的清理器）后再收敛 */
    attaching: boolean;
    cancelled: boolean;
  }
  const followers: Follower[] = [];
  let subscribed = false;

  const desiredProvider = (follower: Follower): P | undefined =>
    follower.cancelled || scope.resources.disposed ? undefined : scope.services.get<P>(name);

  /** 让一个跟随者向「当前应挂的实例」收敛；任何状态变化后都调它 */
  const pump = (follower: Follower): void =>
    scope.resources.run(() => {
      if (follower.busy || follower.attaching) return;
      let desired = desiredProvider(follower);
      if (follower.attached !== undefined && follower.attached !== desired) {
        const cleanup = follower.cleanup;
        const releaseEdge = follower.releaseEdge;
        follower.attached = undefined;
        follower.cleanup = undefined;
        follower.releaseEdge = undefined;
        // 旧清理同步段内的重入 pump 让步：它可能同步改胜者，新实例须等本次收敛决定
        follower.busy = true;
        const pending = cleanup ? withdraw(cleanup, name) : undefined;
        follower.busy = false;
        // 落定（完成或被拒——被拒不代表资源已释放，只是不再等）之后释放依赖边；提供者撤回段等它
        const settled = pending
          ? Promise.resolve(pending).then(
              () => undefined,
              () => undefined,
            )
          : undefined;
        releaseEdge?.(settled);
        if (settled && !follower.overlap) {
          follower.busy = true;
          settled.then(() => {
            follower.busy = false;
            pump(follower);
          });
          return;
        }
      }
      // 旧清理可以同步改偏好、退订或关闭；不能拿回调之前的胜者继续挂载。
      desired = desiredProvider(follower);
      if (follower.attached === undefined && desired !== undefined) {
        follower.attached = desired;
        follower.releaseEdge = scope.retainBinding(name, () => pump(follower));
        follower.attaching = true;
        try {
          const ret: unknown = follower.attach(desired);
          if (typeof ret === 'function') {
            follower.cleanup = ret as () => unknown;
          } else if (isThenable(ret)) {
            // attach 同步契约：不 await 取 cleanup；接住拒绝以免逃成 unhandledRejection
            reportQuietly(() =>
              scope.logger.warn(
                `${name} 跟随回调返回了 thenable（attach 应同步返回 cleanup 函数；该 Promise 已被接住，拒绝不会逃逸）`,
              ),
            );
            ret.then(undefined, () => undefined);
          }
        } catch (err) {
          reportQuietly(() => scope.logger.warn(`${name} 跟随回调抛错（订阅保持，等下次提供者变更）:`, err));
        } finally {
          follower.attaching = false;
        }
        // 回调里取消了自己、或挂载途中又换了人：刚拿到的清理器不能丢，立刻按新目标收敛
        if (follower.cancelled || scope.resources.disposed || follower.attached !== desiredProvider(follower))
          pump(follower);
      }
    });

  const pumpAll = (): void => {
    for (const follower of [...followers]) pump(follower);
  };

  // 胜者可能变化时让全部跟随者收敛（pump 自己去重）。拆卸窗口内的服务事件不引爆清理，由撤回段统一收
  const subscribe = (): void => {
    subscribed = true;
    const offs = (['service:registered', 'service:unregistered', 'service:preference-changed'] as const).map(event =>
      scope.events.on(event, service => {
        if (service === name && !scope.resources.disposed) pumpAll();
      }),
    );
    scope.resources.trackWithdrawal(() => {
      for (const off of offs) off();
      pumpAll();
    }, `watch:${name}`);
  };

  const follow = (attach: Follower['attach'], overlap: boolean): (() => void) => {
    if (scope.resources.disposed) {
      scope.logger.warn(`"${scope.id}" 已关闭，忽略对 ${name} 的跟随`);
      return () => {};
    }
    const follower: Follower = { attach, overlap, busy: false, attaching: false, cancelled: false };
    followers.push(follower);
    // 登记账本的条目是本激活对外可见的能力，关闭时与原语同一拍撤掉，不等下游交接
    if (overlap) scope.resources.onCut(() => pump(follower));
    if (!subscribed) subscribe();
    pump(follower);
    return () => {
      if (follower.cancelled) return;
      follower.cancelled = true;
      const index = followers.indexOf(follower);
      if (index >= 0) followers.splice(index, 1);
      pump(follower);
    };
  };

  const port: BindingPort<P> = {
    name,
    id: scope.id,
    identity: scope.owner,
    logger: scope.logger,
    current: () => scope.services.get<P>(name),
    require() {
      const provider = scope.services.get<P>(name);
      if (provider === undefined) throw new ServiceUnavailableError(scope, name, required);
      return provider;
    },
    all: () => scope.services.getAll<P>(name),
    follow: attach => follow(attach, false),
    track: (off, label) => scope.resources.track(off, label ?? name),
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

      const attachOne = (target: P, entry: Entry, key: string): void =>
        scope.resources.run(() => {
          if (entries.get(key) !== entry || entry.off !== undefined || provider !== target || scope.resources.disposed)
            return;
          const off = options.register(target, entry.item);
          // register 也能替换当前键、切换提供者或关闭激活。回调返回时重新核验所有权，
          // 失效登记就地撤回；不得覆盖重入调用已接住的句柄。
          if (
            entries.get(key) === entry &&
            provider === target &&
            !scope.resources.disposed &&
            entry.off === undefined
          ) {
            entry.off = off;
          } else {
            withdraw(off, `${name} "${key}"`);
          }
        });

      // 账本创建即跟随：同口多账本的重挂次序 = 创建次序（如分组先于工具），不取决于谁先被登记。
      // 被动注册表换人时立即重挂（旧条目的撤回在后台落定、关闭会等）——走内部的 overlap 路径
      follow(target => {
        provider = target;
        // 按键再取当前 Entry：register 回调里重入 add 会换掉 map 里的对象，
        // 快照里的旧 Entry 再挂一次就是账外孤儿。新 Entry 已就地登记则 attachOne 跳过。
        for (const key of [...entries.keys()]) {
          const entry = entries.get(key);
          if (!entry) continue;
          try {
            attachOne(target, entry, key);
          } catch (err) {
            // 单条失败不拖垮同批：当前条目留在账上，下次提供者变更时重试
            reportQuietly(() => scope.logger.warn(`${name} 登记 "${key}" 失败（保留待重试）:`, err));
          }
        }
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
  return port;
}
