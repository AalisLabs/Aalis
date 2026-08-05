// ----- 服务类型注册表（service name → service interface） -----
//
// 登记服务名 → 服务实例接口本身，供 `Context.provide` / `getService` 在编译期约束类型。
//
// ## 用法
//
// 每个 service api 包通过 declaration merging 反向注入自己一条：
//
// ```ts
// // packages/api-memory/src/index.ts
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
//      用于按运行时变量（而非字面量）寻址 service 的场景。
//
// ## 边界
//
// - 第三方插件未 declare：使用方就走 unknown 重载（依旧能用，但失去自动推断）。
// - 同名服务多个实现（如 'memory' 同时被 sqlite/inmemory/mongodb provide）：
//   类型契约相同，落到同一条目即可，运行时按 priority + preference 选择。

/**
 * 全局服务类型注册表 —— **core 内部保持字面为空**。
 *
 * 所有条目一律由 `-api` 包就近通过 `declare module '@aalis/core'` 注入，core 与具体服务
 * 实现因此解耦。core 自己 provide 的 `app` / `plugins` 也不例外：全部消费点都显式
 * 传了类型参数（`getService<AppService>('app')`），写进这里买不到任何东西。
 *
 * ⚠️ **增广只能用裸包名说明符 `'@aalis/core'`，绝不能用相对路径。**
 * 相对说明符会把接口绑成**第二个 symbol**：当 `-api` 包的
 * 增广先绑定时（biome 的 import 排序让 `@aalis/api-*` 恒排在 `@aalis/core` 之前），
 * 36 个 api 服务在 core 的签名视角里直接不存在，`getService('storage')` 静默落到
 * `<T = unknown>` 兜底重载。这类退化不产生任何诊断，只是不再报错。
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

// ----- 服务依赖声明（插件 inject 与 whenService 等消费的服务域词汇） -----

export interface ServiceDependency {
  service: string;
}

export type DependencyDeclaration = string | ServiceDependency;
