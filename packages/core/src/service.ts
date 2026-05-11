import type { DependencyDeclaration } from './types/index.js';

/**
 * 服务优先级约定（数字越大越优先）
 *
 * 用于 `ctx.provide(name, instance, { priority })`。
 * 同优先级时，先注册的胜出（稳定降序排序）。
 *
 * 设计目的：把『谁是默认胜者』变成静态、可预测的契约，
 * 替代旧版 preferService 那种「需要用户手动激活」的运行时偏好。
 *
 * 推荐用法：
 * - `Backend = 0`：普通后端实现（如 plugin-openai / plugin-deepseek）。
 * - `Override = 50`：用户级覆盖；同名服务希望默认胜过普通后端时使用。
 * - `Router = 100`：聚合 facade 层（如 llm-router / platform-router）。
 *   facade 实现 `getAllServices(name)` 时务必过滤 `instance !== this` 以避免自递归。
 * - `System = 200`：保留给核心系统级覆盖。
 */
export const ServicePriority = {
  Backend: 0,
  Override: 50,
  Router: 100,
  System: 200,
} as const;
export type ServicePriorityValue = (typeof ServicePriority)[keyof typeof ServicePriority];

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
  /** 服务偏好：service name → preferred contextId（preferred 永远胜过 priority） */
  private preferences = new Map<string, string>();

  /**
   * 注册一个服务实例
   *
   * @returns 刚插入的 ServiceEntry，调用方可以该引用调用 {@link unregisterEntry} 精确删除这一条。
   */
  register(
    name: string,
    instance: unknown,
    capabilities: string[] = [],
    priority: number = 0,
    contextId: string = 'root',
    label?: string,
  ): ServiceEntry {
    let list = this.entries.get(name);
    if (!list) {
      list = [];
      this.entries.set(name, list);
    }
    const entry: ServiceEntry = {
      instance,
      capabilities: new Set(capabilities),
      priority,
      contextId,
      label,
    };
    list.push(entry);
    // 按优先级降序排列（稳定排序：同优先级先注册者在前）
    list.sort((a, b) => b.priority - a.priority);
    return entry;
  }

  /**
   * 按解析顺序返回某服务的所有 entry：
   *
   *   1. 用户偏好的 entry（如有，且仍存在）
   *   2. 其余 entry，按 priority 降序 + 注册顺序
   *
   * 这是 get/getEntries/getAll 的共同基础——保证「偏好 > 优先级 > 注册顺序」语义在所有读路径一致。
   */
  private resolveEntries(name: string): ServiceEntry[] {
    const list = this.entries.get(name);
    if (!list || list.length === 0) return [];
    const preferredCtxId = this.preferences.get(name);
    if (!preferredCtxId) return list;
    const preferred = list.find(e => e.contextId === preferredCtxId);
    if (!preferred) return list;
    return [preferred, ...list.filter(e => e !== preferred)];
  }

  /**
   * 获取一个满足能力要求的服务实例
   */
  get<T>(name: string, requiredCapabilities?: string[]): T | undefined {
    const list = this.resolveEntries(name);
    if (list.length === 0) return undefined;

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
   * 按 entry 引用精确删除某个提供者（推荐）
   *
   * 避免 "同一 contextId 多次 register" 场景下按 contextId 删除会命中错误条目的 footgun。
   * @returns 是否成功删除
   */
  unregisterEntry(name: string, entry: ServiceEntry): boolean {
    const list = this.entries.get(name);
    if (!list) return false;
    const idx = list.indexOf(entry);
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
  getServiceNames(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 获取某个服务的所有 entry（给 API 暴露用）
   *
   * 返回顺序遵循「偏好 > 优先级 > 注册顺序」。
   */
  getEntries(name: string): ServiceEntry[] {
    return this.resolveEntries(name);
  }

  /**
   * 获取某个服务的所有实例（带提供者信息）
   *
   * 可选 requiredCapabilities 过滤：只返回满足所有所需能力的提供者。
   * 返回顺序遵循「偏好 > 优先级 > 注册顺序」。
   */
  getAll<T>(
    name: string,
    requiredCapabilities?: string[],
  ): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    const list = this.resolveEntries(name);
    if (list.length === 0) return [];
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
   * 设置某服务的偏好 provider（按 contextId）
   *
   * 语义：偏好 > 优先级 > 注册顺序。即偏好 entry 总会被 `get()` 第一个返回，
   * 哪怕它的 priority 数值低于 router 等其他 entry。
   *
   * @returns true 表示偏好已记录（即使目标 entry 当下尚未注册也会接受——一旦注册即生效）
   */
  prefer(name: string, contextId: string): boolean {
    this.preferences.set(name, contextId);
    return true;
  }

  /**
   * 清除某服务的偏好（恢复 priority + 注册顺序解析）
   */
  unprefer(name: string): boolean {
    return this.preferences.delete(name);
  }

  /**
   * 读取某服务当前的偏好 contextId（无偏好返回 undefined）
   */
  getPreferred(name: string): string | undefined {
    return this.preferences.get(name);
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
 * - get / has / getEntries / getServiceNames: 先查本地，miss 则 fallback 到父容器
 * - register / unregisterEntry: 仅操作本地，不影响父容器
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

  override getServiceNames(): string[] {
    return [...new Set([...super.getServiceNames(), ...this.parent.getServiceNames()])];
  }

  override getEntries(name: string): ServiceEntry[] {
    const local = super.getEntries(name);
    const parent = this.parent.getEntries(name);
    // 本地条目优先（在前），父容器条目在后
    return [...local, ...parent];
  }

  override getAll<T>(
    name: string,
    requiredCapabilities?: string[],
  ): Array<{ instance: T; contextId: string; capabilities: string[]; label?: string }> {
    const local = super.getAll<T>(name, requiredCapabilities);
    const parent = this.parent.getAll<T>(name, requiredCapabilities);
    return [...local, ...parent];
  }
}
