// ============================================================
// service-helpers.ts — Context 的服务子系统辅助
//
// 从 context.ts 拆出来的纯函数，消除 Context 类自身对"如何包装/校验服务"的细节
// 知识，留下 Context 作为编排者：路由参数 → 调 helper → 登记 disposable。
//
// 这里不持有任何状态，所有副作用（注册/警告/事件）都通过参数传入的 services/
// logger/events 反映出去。便于单元测试（mock 即可）。
// ============================================================

import type { EventBus } from './events.js';
import type { Logger } from './logger.js';
import type { ServiceContainer } from './service.js';
import { probeCapability } from './types/capabilities.js';
import { ServicePriority } from './types/service.js';

/**
 * 创建一个"动态服务句柄"——Proxy，每次属性访问都重新从容器解析当前最佳 provider。
 *
 * 目的：让调用方写 `const memory = ctx.getService('memory')` 后长期持有也安全，
 * 不再因 provider 切换/重载而持有过期实例。
 *
 * 解析策略和 `container.get()` 完全一致（偏好 > 优先级 > 注册顺序，能力过滤）。
 * 若调用时刻没有 provider，访问任意属性会抛错——但 `getService` 入口已先校验
 * 至少有一个匹配 entry 才返回句柄，所以正常路径下不会触发这个抛错；
 * 仅在调用方持有句柄期间所有 provider 都被注销才会遇到。
 */
export function makeServiceHandle<T>(container: ServiceContainer, name: string, caps: string[] | undefined): T {
  const resolve = (): unknown => {
    const inst = container.get<unknown>(name, caps);
    if (inst === undefined) {
      throw new Error(`服务 "${name}" 已不再可用（持有句柄期间 provider 全部注销）`);
    }
    return inst;
  };
  // 用空对象做 target，所有 trap 都委托到当前解析结果——保证 typeof / 属性访问 / 调用 / new 等都跟随最新 provider
  return new Proxy(
    {},
    {
      get(_t, prop, receiver) {
        const target = resolve() as object;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      has(_t, prop) {
        return Reflect.has(resolve() as object, prop);
      },
      ownKeys() {
        return Reflect.ownKeys(resolve() as object);
      },
      getOwnPropertyDescriptor(_t, prop) {
        return Reflect.getOwnPropertyDescriptor(resolve() as object, prop);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(resolve() as object);
      },
      apply(_t, thisArg, args) {
        const fn = resolve();
        if (typeof fn !== 'function') throw new TypeError(`服务 "${name}" 不是函数`);
        return Reflect.apply(fn, thisArg, args);
      },
      construct(_t, args, newTarget) {
        const fn = resolve();
        if (typeof fn !== 'function') throw new TypeError(`服务 "${name}" 不可构造`);
        return Reflect.construct(fn as new (...a: unknown[]) => object, args, newTarget);
      },
    },
  ) as T;
}

/**
 * provide() 的 dev-mode 校验集合：
 *   1. entryId 必须以 ctxId 为前缀（否则 plugin 卸载时清理不到）
 *   2. 声明的 capabilities 必须能在 instance 上探测到对应方法
 *   3. 同一上下文重复 provide 同一服务名静默失效（容器路由按 contextId）
 *   4. priority 应使用 ServicePriority enum 而非裸数字
 *
 * 参数 explicitEntryId 区分"调用方有意覆盖 entryId"vs"使用 ctxId 默认值"——
 * 前者才触发 entryId 前缀检查与抑制重复 provide warn（有意拆粒度的语义）。
 *
 * 失败模式：
 *   - capabilities 不匹配 → throw（写错的代码不该跑起来）
 *   - 其它 → warn（提示但不阻断）
 */
export function validateProvide(args: {
  ctxId: string;
  name: string;
  instance: unknown;
  capabilities: readonly string[];
  entryId: string;
  explicitEntryId: boolean;
  priority?: number;
  services: ServiceContainer;
  logger: Logger;
}): void {
  const { ctxId, name, instance, capabilities, entryId, explicitEntryId, priority, services, logger } = args;

  if (explicitEntryId && entryId !== ctxId && !entryId.startsWith(`${ctxId}/`)) {
    logger.warn(
      `服务 "${name}" 的 entryId "${entryId}" 不以 "${ctxId}/" 为前缀。` +
        `违反约定后 plugin 卸载时可能遗漏清理。` +
        `推荐格式：\`\${ctx.id}/\${子粒度标识}\`。`,
    );
  }

  const failures: string[] = [];
  for (const cap of capabilities) {
    const result = probeCapability(name, cap, instance);
    if (typeof result === 'string') failures.push(`  - [${cap}] ${result}`);
  }
  if (failures.length > 0) {
    throw new Error(`服务 "${name}" 声明的能力与实例实现不符（provide 拒绝注册）:\n${failures.join('\n')}`);
  }

  if (!explicitEntryId && services.hasByContext(name, ctxId)) {
    logger.warn(
      `服务 "${name}" 已被当前上下文 "${ctxId}" provide 过一次。容器允许多 entry，` +
        `但下游按 contextId 路由时仅能命中首个，后续注册将静默失效。` +
        `如需多实例（如多套 API key），请在插件 module 上声明 reusable=true，` +
        `然后在 config 中用 "<name>:<suffix>" 形式注册多份。` +
        `若是有意拆出多个子粒度 entry（如 per-model LLM），请传入 options.entryId。`,
    );
  }

  if (priority !== undefined) {
    const standard = Object.values(ServicePriority) as number[];
    if (!standard.includes(priority)) {
      logger.warn(
        `服务 "${name}" 使用了非标准 priority=${priority}。建议改用 ServicePriority enum：` +
          `Backend(0) / Override(50) / System(200)。` +
          `裸数字会让"谁是默认胜者"难以静态推断。`,
      );
    }
  }
}

/**
 * 异步发射 service:registered 事件，捕获并 warn 任何监听器抛错。
 * 抽出为函数主要让 provide() 主体看起来更短。
 */
export function emitServiceRegistered(
  events: EventBus,
  logger: Logger,
  name: string,
  capabilities: readonly string[],
): void {
  events.emit('service:registered', name, [...capabilities]).catch(err => {
    logger.warn(`服务注册事件发射失败 [${name}]:`, err);
  });
}
