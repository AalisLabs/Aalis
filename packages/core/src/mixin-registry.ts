import type { Logger } from './logger.js';

/** Mixin 条目记录 */
export interface MixinEntry {
  service: string;
  methods: string[];
  contextId: string;
}

/** 最小 getService 依赖 —— 让 MixinRegistry 不直接持有 Context */
interface ServiceLookup {
  getService<T = unknown>(name: string): T | undefined;
}

/** 承载 mixin 方法的目标 prototype（一般是 Context.prototype） */
type MixinTarget = object;

/**
 * Mixin 注册表（进程级）
 *
 * 职责：
 * - 维护 mixin 条目列表（哪些服务的哪些方法被代理到了 target prototype 上）
 * - 在 target prototype 上安装 getter，按 `this` 运行时解析服务实例并 bind
 * - `dispose()` 时如该方法已无其他 mixin 引用则清除
 *
 * 设计：静态类而非单例——因为 Context.prototype 是进程级共享资源，
 * 不存在"每实例一个 registry"的语义；集中成静态便于测试和管理。
 */
export class MixinRegistry {
  private static _entries: MixinEntry[] = [];

  /**
   * 注册 mixin：把 `serviceName` 指代的服务实例的若干方法
   * 代理到 `target` prototype 上。
   *
   * @returns 卸载函数
   */
  static register(
    target: MixinTarget,
    serviceName: string,
    methods: string[],
    contextId: string,
    logger: Logger,
  ): () => void {
    const entry: MixinEntry = { service: serviceName, methods, contextId };
    MixinRegistry._entries.push(entry);

    for (const method of methods) {
      if (method in target) {
        logger.warn(`mixin: 方法 "${method}" 已存在于 target，跳过`);
        continue;
      }
      Object.defineProperty(target, method, {
        configurable: true,
        enumerable: false,
        get(this: ServiceLookup) {
          const svc = this.getService<Record<string, unknown>>(serviceName);
          if (!svc) return undefined;
          const val = svc[method];
          if (typeof val === 'function') return (val as (...args: unknown[]) => unknown).bind(svc);
          return val;
        },
      });
    }

    logger.debug(`mixin: ${methods.join(', ')} → ${serviceName}`);

    return () => {
      const idx = MixinRegistry._entries.indexOf(entry);
      if (idx >= 0) MixinRegistry._entries.splice(idx, 1);
      for (const method of methods) {
        const stillUsed = MixinRegistry._entries.some(e => e.methods.includes(method));
        if (!stillUsed) {
          delete (target as Record<string, unknown>)[method];
        }
      }
    };
  }

  /** 当前所有 mixin 注册信息（快照） */
  static list(): MixinEntry[] {
    return MixinRegistry._entries.map(e => ({ ...e }));
  }
}
