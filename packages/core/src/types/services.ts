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
 * **不要在 core 内部登记领域服务**——storage / memory / llm 之类一律由其 api 包就近通过
 * `declare module '@aalis/core'` 注入，这样 core 与具体服务实现解耦。core 自己 provide 的
 * `app` / `plugins` 是例外，它们就是内核原语（见 `app.ts` 的 `ctx.provide('app', …)`），
 * 写在这里而不是别处。
 *
 * ⚠️ **增广只能用裸包名说明符 `'@aalis/core'`，绝不能用相对路径。** 曾经 `types/app.ts` 里
 * 有一段 `declare module './services.js'` 给这两个键做增广，实测把接口绑成了**第二个
 * symbol**：当 `-api` 包的 `declare module '@aalis/core'` 先绑定时（biome 的 import 排序让
 * `@aalis/api-*` 恒排在 `@aalis/core` 之前，真实代码 100% 命中），36 个 api 服务在 core 的
 * 签名视角里直接不存在，`getService('storage')` 悄悄落到 `<T = unknown>` 兜底重载。
 * 而这一条 build / test / biome / knip 四道门全都看不见——类型退化不产生错误、只是不再报错。
 * 所以键写在接口体里没问题，**用相对说明符增广才是病**；两者别混为一谈。
 */
export interface ServiceTypeMap {
  app: import('./app.js').AppService;
  plugins: import('./app.js').PluginManagerService;
}

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
