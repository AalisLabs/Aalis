import type { DependencyDeclaration } from './types/services.js';

// ----- 服务系统数据契约（与容器实现同文件，同 contributions.ts 的 Spec/Handle 惯例） -----

/**
 * 服务优先级约定（数字越大越优先）
 *
 * 用于 `ctx.provide(name, instance, { priority })`。
 * 同优先级时，先注册的胜出（稳定降序排序）。
 *
 * 设计目的：把『谁是默认胜者』变成静态、可预测的契约。
 * 与 preferService 正交、非替代关系：优先级是静态默认序，偏好是用户显式覆盖，
 * 解析序恒为「偏好 > 优先级 > 注册顺序」。
 *
 * 推荐用法：
 * - `Backend = 0`：普通后端实现（如 plugin-llm-openai / plugin-llm-deepseek）。
 * - `Override = 50`：用户级覆盖；同名服务希望默认胜过普通后端时使用。
 * - `System = 200`：保留给核心系统级覆盖。
 *
 * 注：feat/service-granularity 之后已不再有 router/facade 层级——LLM / storage / platform
 * 均改为按 model / root / sessionId 直接注册多 entry，跨 entry 的聚合与路由由各自
 * `*-api` 的 helper 函数承担（`createStorageGateway` / `resolvePlatformBySession` / ...），
 * 没有同名 facade entry，因此曾经的 `Router = 100` 槽位整体废弃。
 */
export const ServicePriority = {
  Backend: 0,
  Override: 50,
  System: 200,
} as const;
export type ServicePriorityValue = (typeof ServicePriority)[keyof typeof ServicePriority];

export interface ServiceEntry {
  instance: unknown;
  priority: number;
  contextId: string;
  /** 可选的展示标签（如 "OpenAI / gpt-4o"） */
  label?: string;
}

export interface NormalizedDependency {
  service: string;
}

/**
 * 将 string | ServiceDependency 统一为 NormalizedDependency
 */
export function normalizeDependency(dep: DependencyDeclaration): NormalizedDependency {
  return { service: typeof dep === 'string' ? dep : dep.service };
}

/**
 * 服务容器 —— 支持同名多实现
 *
 * 设计要点：
 * - 同一个服务名可以有多个提供者（按 priority + 偏好解析）
 * - 服务选择走「偏好 > 优先级 > 注册顺序」；领域级筛选（如按 LLM 模型能力）由各 -api 自理，不在内核 DI
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
   * 获取一个满足能力要求的服务实例。
   *
   * 不走 `resolveEntries`：那里在设了偏好时要 `find` + `filter` + spread 出一条全新的重排
   * 数组，而这里只取首个、其余全丢。`getService` 是全仓最频繁的读（三百余处调用点），
   * 且「锁定默认 LLM」这类偏好在真实部署里是常态，那条被算出来又被丢掉的尾巴不划算。
   *
   * 语义与 `resolveEntries` 保持一致：偏好项存在则取它，否则取 `list[0]` ——
   * `list` 在 `register` 里就按 priority 降序排好（稳定排序，同优先级保持注册顺序）。
   */
  get<T>(name: string): T | undefined {
    const list = this.entries.get(name);
    if (!list || list.length === 0) return undefined;
    const preferredCtxId = this.preferences.get(name);
    if (preferredCtxId) {
      const preferred = list.find(e => e.contextId === preferredCtxId);
      if (preferred) return preferred.instance as T;
    }
    return list[0].instance as T;
  }

  /**
   * 检查指定 contextId 是否注册了某个服务。
   *
   * "拥有" 语义：同时匹配 `contextId === ownerId` 和 per-entry 拆粒度的
   * `contextId` 以 `ownerId + '/'` 为前缀的子 entry（如 `@aalis/plugin-llm-ollama:main/llama3`）。
   */
  hasByContext(name: string, contextId: string): boolean {
    const list = this.entries.get(name);
    if (!list) return false;
    const prefix = `${contextId}/`;
    return list.some(e => e.contextId === contextId || e.contextId.startsWith(prefix));
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
   * 按 contextId 移除该上下文拥有的所有服务 entry，返回被移除的服务名列表。
   *
   * "拥有" 同 hasByContext：包括 `contextId === id` 和以 `id + '/'` 为前缀的 per-entry 子 entry。
   * 这是插件 unload 时清理多 entry 注册（per-model LLM / per-root storage / …）的路径。
   */
  unregisterByContext(contextId: string): string[] {
    const removed: string[] = [];
    const prefix = `${contextId}/`;
    for (const [name, list] of this.entries) {
      const before = list.length;
      const filtered = list.filter(e => e.contextId !== contextId && !e.contextId.startsWith(prefix));
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
   * 获取某个服务的所有实例（带提供者信息与优先级）
   *
   * 返回顺序遵循「偏好 > 优先级 > 注册顺序」。
   */
  getAll<T>(name: string): Array<{ instance: T; contextId: string; priority: number; label?: string }> {
    return this.resolveEntries(name).map(entry => ({
      instance: entry.instance as T,
      contextId: entry.contextId,
      priority: entry.priority,
      label: entry.label,
    }));
  }

  /**
   * 设置某服务的偏好 provider（按 contextId）
   *
   * 语义：偏好 > 优先级 > 注册顺序。即偏好 entry 总会被 `get()` 第一个返回，
   * 哪怕它的 priority 数值低于 router 等其他 entry。
   *
   * @returns true 表示偏好已记录（即使目标 entry 当下尚未注册也会接受——一旦注册即生效）
   * @internal 公开 API 走 `ctx.preferService()`（额外 emit service:preference-changed
   *   触发 whenService 重挂）；本方法仅供 Context 内部转发，插件勿直接调用。
   */
  prefer(name: string, contextId: string): boolean {
    this.preferences.set(name, contextId);
    return true;
  }

  /**
   * 清除某服务的偏好（恢复 priority + 注册顺序解析）
   * @internal 公开 API 走 `ctx.unpreferService()`；本方法仅供 Context 内部转发。
   */
  unprefer(name: string): boolean {
    return this.preferences.delete(name);
  }

  /**
   * 读取某服务当前的偏好 contextId（无偏好返回 undefined）
   * @internal 公开 API 走 `ctx.getPreferredService()`；本方法仅供 Context 内部转发。
   */
  getPreferred(name: string): string | undefined {
    return this.preferences.get(name);
  }
}
