import type { DependencyDeclaration } from './types/index.js';

export interface ServiceEntry {
  instance: unknown;
  capabilities: Set<string>;
  priority: number;
  contextId: string;
  /** 可选的展示标签（如 "OpenAI / gpt-4o"） */
  label?: string;
}

export interface NormalizedDependency {
  service: string;
  capabilities: string[];
}

/**
 * 将 string | ServiceDependency 统一为 NormalizedDependency
 */
export function normalizeDependency(dep: DependencyDeclaration): NormalizedDependency {
  if (typeof dep === 'string') {
    return { service: dep, capabilities: [] };
  }
  return { service: dep.service, capabilities: dep.capabilities ?? [] };
}

/**
 * 服务容器 —— 支持同名多实现 + 能力匹配
 *
 * 设计要点：
 * - 同一个服务名可以有多个提供者（不同能力集）
 * - 获取服务时可指定所需能力, 容器会匹配满足所有能力的最高优先级提供者
 * - 每个注册都关联 contextId, 以便在插件卸载时批量清理
 */
export class ServiceContainer {
  private entries = new Map<string, ServiceEntry[]>();

  /**
   * 注册一个服务实例
   */
  register(
    name: string,
    instance: unknown,
    capabilities: string[] = [],
    priority: number = 0,
    contextId: string = 'root',
    label?: string,
  ): void {
    let list = this.entries.get(name);
    if (!list) {
      list = [];
      this.entries.set(name, list);
    }
    list.push({
      instance,
      capabilities: new Set(capabilities),
      priority,
      contextId,
      label,
    });
    // 按优先级降序排列
    list.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取一个满足能力要求的服务实例
   */
  get<T>(name: string, requiredCapabilities?: string[]): T | undefined {
    const list = this.entries.get(name);
    if (!list || list.length === 0) return undefined;

    for (const entry of list) {
      if (requiredCapabilities && requiredCapabilities.length > 0) {
        const satisfied = requiredCapabilities.every(c => entry.capabilities.has(c));
        if (!satisfied) continue;
      }
      return entry.instance as T;
    }
    return undefined;
  }

  /**
   * 检查某个服务是否存在（并且满足指定能力）
   */
  has(name: string, requiredCapabilities?: string[]): boolean {
    return this.get(name, requiredCapabilities) !== undefined;
  }

  /**
   * 检查指定 contextId 是否注册了某个服务
   */
  hasByContext(name: string, contextId: string): boolean {
    const list = this.entries.get(name);
    return list?.some(e => e.contextId === contextId) ?? false;
  }

  /**
   * 获取某个服务的所有能力列表（合并所有提供者）
   */
  getCapabilities(name: string): string[] {
    const list = this.entries.get(name);
    if (!list) return [];
    const caps = new Set<string>();
    for (const entry of list) {
      for (const c of entry.capabilities) caps.add(c);
    }
    return [...caps];
  }

  /**
   * 移除指定服务名下某个 contextId 的提供者（精确卸载单条目）
   * @returns 是否成功移除
   */
  unregister(name: string, contextId: string): boolean {
    const list = this.entries.get(name);
    if (!list) return false;
    const idx = list.findIndex(e => e.contextId === contextId);
    if (idx < 0) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.entries.delete(name);
    return true;
  }

  /**
   * 按 contextId 移除所有该上下文注册的服务，返回被移除的服务名列表
   */
  unregisterByContext(contextId: string): string[] {
    const removed: string[] = [];
    for (const [name, list] of this.entries) {
      const before = list.length;
      const filtered = list.filter(e => e.contextId !== contextId);
      if (filtered.length < before) {
        removed.push(name);
      }
      if (filtered.length === 0) {
        this.entries.delete(name);
      } else {
        this.entries.set(name, filtered);
      }
    }
    return removed;
  }

  /**
   * 列出所有已注册的服务名
   */
  listServices(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 获取某个服务的所有 entry（给 API 暴露用）
   */
  getEntries(name: string): ServiceEntry[] {
    return this.entries.get(name) ?? [];
  }

  /**
   * 获取某个服务的所有实例（带提供者信息）
   *
   * 可选 requiredCapabilities 过滤：只返回满足所有所需能力的提供者。
   */
  getAll<T>(name: string, requiredCapabilities?: string[]): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    const list = this.entries.get(name);
    if (!list) return [];
    const result: Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> = [];
    for (const entry of list) {
      if (requiredCapabilities && requiredCapabilities.length > 0) {
        const satisfied = requiredCapabilities.every(c => entry.capabilities.has(c));
        if (!satisfied) continue;
      }
      result.push({
        instance: entry.instance as T,
        contextId: entry.contextId,
        capabilities: [...entry.capabilities],
        label: entry.label,
      });
    }
    return result;
  }

  /**
   * 将指定 contextId 的提供者置为首位（偏好选择）
   * 仅调整列表顺序，不修改 priority 数值
   */
  prefer(name: string, contextId: string): boolean {
    const list = this.entries.get(name);
    if (!list) return false;
    const target = list.find(e => e.contextId === contextId);
    if (!target) return false;
    const rest = list.filter(e => e !== target);
    list.length = 0;
    list.push(target, ...rest);
    return true;
  }

  /**
   * 创建作用域子容器
   *
   * 子容器读取时先查本地，miss 则 fallback 到父容器；
   * 写入（register）仅影响子容器自身。
   *
   * 适用于沙盒/会话隔离场景：每个沙盒拥有独立的服务覆盖，
   * 同时继承全局公共服务（如 authority、commands）。
   *
   * @example
   * const scoped = container.createScope();
   * scoped.register('agent', sandboxAgent); // 仅沙盒可见
   * scoped.get('authority'); // fallback 到父容器
   */
  createScope(): ScopedServiceContainer {
    return new ScopedServiceContainer(this);
  }
}

/**
 * 作用域服务容器 —— ServiceContainer 的子容器
 *
 * - get / has / getEntries / listServices: 先查本地，miss 则 fallback 到父容器
 * - register / unregister: 仅操作本地，不影响父容器
 * - 支持多层嵌套: ScopedServiceContainer.createScope() 返回更深层的子容器
 */
export class ScopedServiceContainer extends ServiceContainer {
  readonly parent: ServiceContainer;

  constructor(parent: ServiceContainer) {
    super();
    this.parent = parent;
  }

  override get<T>(name: string, requiredCapabilities?: string[]): T | undefined {
    const local = super.get<T>(name, requiredCapabilities);
    if (local !== undefined) return local;
    return this.parent.get<T>(name, requiredCapabilities);
  }

  override has(name: string, requiredCapabilities?: string[]): boolean {
    return super.has(name, requiredCapabilities) || this.parent.has(name, requiredCapabilities);
  }

  override getCapabilities(name: string): string[] {
    const local = super.getCapabilities(name);
    const parent = this.parent.getCapabilities(name);
    return [...new Set([...local, ...parent])];
  }

  override listServices(): string[] {
    return [...new Set([...super.listServices(), ...this.parent.listServices()])];
  }

  override getEntries(name: string): ServiceEntry[] {
    const local = super.getEntries(name);
    const parent = this.parent.getEntries(name);
    // 本地条目优先（在前），父容器条目在后
    return [...local, ...parent];
  }

  override getAll<T>(name: string, requiredCapabilities?: string[]): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    const local = super.getAll<T>(name, requiredCapabilities);
    const parent = this.parent.getAll<T>(name, requiredCapabilities);
    return [...local, ...parent];
  }
}
