// ----- 服务容器类型与纯辅助函数 -----
//
// 与运行时实现 (ServiceContainer) 分离，避免下游消费者只为类型而拉入 class。
// 实现详见 ../service.ts。

import type { DependencyDeclaration } from './core.js';

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
 * - `Router = 100`：聚合 facade 层（已不推荐：feat/service-granularity 后 LLM / storage 已废弃 router；
 *   platform router 待后续 commit 同步重构）。
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
