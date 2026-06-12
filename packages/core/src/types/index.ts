// ============================================================
// @aalis/core - types 子模块统一导出
//
// 仅包含 core 自身定义的：
//   - 通用 IoC 数据契约（types/core.ts：Schema / Middleware / Dependency / AalisEvents 等）
//   - 钩子扩展点（types/hooks.ts，仅空 HookContextMap）
//   - 服务能力声明框架（types/capabilities.ts）
//   - App 服务接口（types/app.ts）
//
// 业务/领域类型一律由 plugin-*-api 包导出：
//   - Message / ContentSegment           → @aalis/plugin-agent-api
//   - ToolCall / ToolDefinition / ToolFunction → @aalis/plugin-tools-api
//   - LLM / Memory / Storage / Embedding / VectorStore / Tools / Commands / Gateway /
//     WebUI / Authority / Agent / Platform 等服务接口同样在各自的 plugin-*-api。
// ============================================================

// App 生命周期接口
export type { AppService, PluginManagerService, PluginStatusEntry } from './app.js';
// 服务能力声明框架
export type { CapabilityList, CapabilityOf, CapabilityProbe, ServiceCapabilityMap } from './capabilities.js';
export { probeCapability, registerCapabilityProbe } from './capabilities.js';
// 通用 IoC 数据契约
export type {
  AalisEvents,
  ConfigSchema,
  DependencyDeclaration,
  InjectDeclaration,
  MiddlewareFn,
  MiddlewareNext,
  SchemaArray,
  SchemaField,
  SchemaFieldType,
  SchemaGroup,
  ServiceDependency,
} from './core.js';
// 服务自清理协议
export type { DisposableService } from './disposable-service.js';
// 钩子上下文扩展点（空接口；由各 plugin-*-api 通过 declaration merging 注入业务键）
export type { HookContextMap } from './hooks.js';
// 服务实例类型注册表（空接口；由各 plugin-*-api 通过 declaration merging 注入「服务名→服务接口」）
export type { ServiceOf, ServiceTypeMap } from './services.js';
