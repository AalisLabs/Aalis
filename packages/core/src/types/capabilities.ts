// ----- 服务能力声明框架 -----
//
// Aalis 的服务能力（capability）采用「按服务隔离的注册表 + declaration merging」模式，
// 既保证编译期类型安全，也允许第三方插件扩展。
//
// ## 模式说明
//
// 每个服务类型文件（如 `types/llm.ts`）维护一个独立的 `XxxCapabilityRegistry` 接口，
// 通过 interface declaration merging 让第三方可以追加能力键：
//
// ```ts
// // types/llm.ts (内置)
// export interface LLMCapabilityRegistry {
//   Chat: 'chat';
//   ToolCalling: 'tool_calling';
//   // ...
// }
// export type LLMCapability = LLMCapabilityRegistry[keyof LLMCapabilityRegistry];
// export const LLMCapabilities = { Chat: 'chat', ToolCalling: 'tool_calling', ... } as const;
// ```
//
// ```ts
// // 第三方插件扩展能力
// declare module '@aalis/core' {
//   interface LLMCapabilityRegistry {
//     AudioInput: 'audio_input';
//     FimCompletion: 'fim_completion';
//   }
// }
// ```
//
// 然后通过 `ServiceCapabilityMap`（本文件）将服务名映射到其能力 union，
// `Context.provide()` / `getService()` 即可在编译期约束传入的 capability 字符串。
//
// 各服务类型文件通过 declaration merging 注册自己的映射，本文件**不**列出具体服务
// （保持模块化，新增服务无需修改本文件）：
//
// ```ts
// // types/llm.ts
// declare module './capabilities.js' {
//   interface ServiceCapabilityMap {
//     llm: LLMCapability;
//   }
// }
// ```

/**
 * 服务名 → 能力 union 的全局映射表
 *
 * 各服务类型文件通过 declaration merging 注册自己的条目；
 * 第三方插件如需注册全新服务名，也通过同样方式扩展。
 *
 * 不在此处列出任何条目，所有内容由各服务文件就近声明，便于解耦与新增。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ServiceCapabilityMap {
  // 由 types/llm.ts、types/memory.ts 等通过 declaration merging 填充
}

/**
 * 根据服务名解析其允许的能力字符串类型。
 * - 已注册的服务名（在 ServiceCapabilityMap 中）→ 对应 union
 * - 未注册的服务名 → `string`（保持向后兼容，不阻塞动态服务）
 */
export type CapabilityOf<TName extends string> =
  TName extends keyof ServiceCapabilityMap
    ? ServiceCapabilityMap[TName] & string
    : string;

/**
 * `provide()` / `getService()` 的能力参数类型
 *
 * 允许传入只读数组（如 `as const` 字面量）或普通数组。
 */
export type CapabilityList<TName extends string> = ReadonlyArray<CapabilityOf<TName>>;
