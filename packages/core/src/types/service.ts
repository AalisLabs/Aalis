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
