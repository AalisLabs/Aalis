// ----- 服务类型注册表（service name → service interface） -----
//
// 登记服务名 → 服务实例接口本身，供 `Context.provide` / `getService` 在编译期约束类型。
//
// ## 用法
//
// 每个 service api 包通过 declaration merging 反向注入自己一条：
//
// ```ts
// // packages/plugin-memory-api/src/index.ts
// declare module '@aalis/core' {
//   interface ServiceTypeMap {
//     memory: MemoryService;
//   }
// }
// ```
//
// 之后使用方：
//
// ```ts
// const m = ctx.getService('memory');        // 自动推断为 MemoryService | undefined
// const m2 = ctx.getService('memory'); // 旧式手动写法仍然可用
// ```
//
// ## escape hatch
//
// `Context.getService` 提供两个重载：
//   1. `<TName extends keyof ServiceTypeMap>(name: TName, ...)` —— 字面量自动强类型
//   2. `<T = unknown>(name: string, ...)` —— 字符串变量退回 `unknown`，
//      用于 router 类插件（plugin-llm-router / plugin-storage-router）按运行时
//      变量寻址 service 的场景。
//
// ## 边界
//
// - 第三方插件未 declare：使用方就走 unknown 重载（依旧能用，但失去自动推断）。
// - 同名服务多个实现（如 'memory' 同时被 sqlite/inmemory/mongodb provide）：
//   类型契约相同，落到同一条目即可，运行时按 priority + preference 选择。

/**
 * 全局服务类型注册表
 *
 * **不要在 core 内部为任何服务名登记条目**——所有内置服务都由其 api 包就近
 * 通过 declaration merging 注入。这样保持 core 与具体服务实现解耦。
 */
export interface ServiceTypeMap {}

/**
 * 根据服务名解析其实例类型。
 * - 已登记的服务名（在 ServiceTypeMap 中）→ 对应接口
 * - 未登记的服务名 → `unknown`（强制使用方主动 narrow，避免 footgun）
 *
 * 用户便利类型；core 自己用 `ServiceTypeMap[TName]` 直接索引。
 */
export type ServiceOf<TName extends string> = TName extends keyof ServiceTypeMap ? ServiceTypeMap[TName] : unknown;
