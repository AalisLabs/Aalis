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

// ----- 能力探测（capability ↔ 实例方法 的运行时一致性校验） -----
//
// 作用：插件在 `ctx.provide(service, instance, { capabilities: [...] })` 声明能力时，
// dev 模式下核对实例是否真的实现了该能力要求的成员/方法，尽早暴露「声明与实现不符」。
//
// 与 capability 注册表一样，探测器由各服务类型文件**就近**注册（保持模块化）。
// 对于参数层能力（如 LLM 的 ToolCalling / Vision），由于无法用方法名探测，
// 通常不注册探测器 —— 未注册 = 不校验，不阻塞。

/**
 * 能力探测函数：返回 `true` 表示通过；返回字符串表示失败原因。
 *
 * @example
 * const probe: CapabilityProbe = inst =>
 *   typeof (inst as { chat?: unknown }).chat === 'function'
 *     ? true
 *     : 'LLMService.chat() is required for capability "chat"';
 */
export type CapabilityProbe = (instance: unknown) => true | string;

const _probes = new Map<string, Map<string, CapabilityProbe>>();

/**
 * 注册一条能力探测器
 *
 * 重复注册相同 `(service, capability)` 会覆盖之前的注册，
 * 这使得同一服务的不同实现版本可以通过自己的类型文件被覆盖/扩展。
 */
export function registerCapabilityProbe(
  service: string,
  capability: string,
  probe: CapabilityProbe,
): void {
  let byCap = _probes.get(service);
  if (!byCap) {
    byCap = new Map();
    _probes.set(service, byCap);
  }
  byCap.set(capability, probe);
}

/**
 * 按服务+能力探测实例
 *
 * @returns
 * - `true`：探测通过
 * - `string`：探测失败（信息用于报错）
 * - `null`：没有对应探测器（跳过校验）
 */
export function probeCapability(
  service: string,
  capability: string,
  instance: unknown,
): true | string | null {
  const byCap = _probes.get(service);
  if (!byCap) return null;
  const probe = byCap.get(capability);
  if (!probe) return null;
  try {
    return probe(instance);
  } catch (err) {
    return `probe threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

