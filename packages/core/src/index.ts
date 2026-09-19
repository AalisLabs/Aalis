// ============================================================
// index.ts — @aalis/core 包根导出，按内部分层分节（见 docs/design/core-contract.md 第八节）：
//   自下而上：类型词汇与扩展点 → 四原语注册表 → Context 基础 → 编排层（含宿主 SPI）。
// 资源内核（kernel/）不导出。领域词汇（消息、工具、LLM 等）一律在各 @aalis/api-* 包，
// 经扩展点接口的 declaration merging 接入，core 不认识任何业务类型。
// ============================================================

// ----- 通用 IoC 数据契约 + 扩展点 -----
export type {
  AalisEvents,
  AppService,
  ContributionPointMap,
  DependencyDeclaration,
  DisposableService,
  HookContextMap,
  InjectDeclaration,
  MiddlewareFn,
  MiddlewareNext,
  PluginManagerService,
  PluginMeta,
  PluginStatusEntry,
  ServiceDependency,
  ServiceOf,
  ServiceTypeMap,
} from './types/index.js';

// ----- 四原语 -----
export { type ContributionHandle, ContributionRegistry, type ContributionSpec } from './primitives/contributions.js';
export { EventBus } from './primitives/events.js';
export { HookRegistry } from './primitives/hooks.js';
export {
  type NormalizedDependency,
  ServiceContainer,
  type ServiceView,
} from './primitives/services.js';

// ----- 服务描述符与按激活绑定（原型）-----
export {
  asServiceRef,
  type BindingPort,
  type BoundOf,
  defineService,
  optional,
  type ProviderOf,
  type Registrar,
  type ServiceDescriptor,
  type ServiceRef,
  type ServiceSource,
  serviceRef,
  type Uses,
} from './context/binding.js';
export {
  type Contributions,
  config,
  contributions,
  type Events,
  events,
  type Hooks,
  hooks,
  type LifecycleCap,
  lifecycle,
  logger,
  type ModuleDefinition,
  type Provide,
  provide,
  type Services,
  services,
} from './context/builtins.js';
// ----- Context 基础：门面、配置、日志 -----
export { type AalisConfig, ConfigManager, type ConfigManagerOptions, type ConfigProvider } from './context/config.js';
// 注：Lifecycle / DisposableChain 是 Context 内部的资源生命周期实现，不从包根导出（零外部消费，
// 无 semver 承诺）；dist 里的深路径同样不在承诺面。
export { Context, type ModuleHandle } from './context/context.js';
export {
  DefaultLogger,
  formatLogLine,
  type LogEntry,
  type Logger,
  LogHub,
  type LogLevel,
  parseLogLine,
} from './context/logger.js';

// ----- 编排层：应用骨架与插件管理 -----
export { App, type AppOptions, createApp } from './orchestration/app.js';
export {
  appService,
  definePlugin,
  hostConfig,
  type PluginDefinition,
  pluginsService,
} from './orchestration/define-plugin.js';
export {
  type PluginEntry,
  PluginManager,
  type PluginModule,
  type PluginState,
  parseInstanceId,
} from './orchestration/plugin.js';
// 宿主 SPI：插件加载器与重启策略（ConfigProvider 随 ConfigManager 在上一节）
export type { PluginDescriptor, PluginLoader, RestartStrategy } from './orchestration/providers.js';
