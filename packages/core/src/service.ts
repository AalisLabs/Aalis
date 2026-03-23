import type { DependencyDeclaration } from './types.js';

export interface ServiceEntry {
  instance: unknown;
  capabilities: Set<string>;
  priority: number;
  contextId: string;
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
}
