// ============================================================
// index.ts — @aalis/core 包根导出，按内部分层分节（见 docs/design/core-contract.md 第八节）：
//   自下而上：类型词汇与扩展点 → 四原语注册表 → 服务描述符、内置能力与插件定义 → 编排层（含宿主 SPI）。
// 资源内核（kernel/）与激活记录（orchestration/activation.ts）不导出：插件拿到的是按激活绑定的能力，不是激活本身。
// 领域词汇（消息、工具、LLM 等）一律在各 @aalis/api-* 包，服务类型随描述符走，core 不认识任何业务类型。
// ============================================================

// ----- 通用数据契约 + 扩展点 -----
export type {
  AalisEvents,
  AppService,
  ContributionPointMap,
  HookContextMap,
  MiddlewareFn,
  MiddlewareNext,
  PluginManagerService,
  PluginStatusEntry,
} from './types/index.js';

// ----- 四原语 -----
export { type ContributionHandle, ContributionRegistry, type ContributionSpec } from './primitives/contributions.js';
export { EventBus } from './primitives/events.js';
export { HookRegistry } from './primitives/hooks.js';
export { ServiceContainer, type ServiceInfo, type ServiceView } from './primitives/services.js';

// ----- 编排层：应用骨架与插件管理 -----
export { App, type AppOptions, createApp } from './orchestration/app.js';
export { appService, hostConfig, pluginsService } from './orchestration/host-services.js';
export { type PluginEntry, PluginManager, type PluginState, parseInstanceId } from './orchestration/plugin.js';
// 宿主 SPI：插件加载器与重启策略（ConfigProvider 随 ConfigManager 在上一节）
export type { PluginDescriptor, PluginLoader, RestartStrategy } from './orchestration/providers.js';

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
  type Provide,
  type ProvideOptions,
  provide,
  type ServiceKey,
  type Services,
  services,
} from './composition/core-services.js';
// ----- 服务描述符与按激活绑定 -----
export {
  type BindingPort,
  type BoundOf,
  defineService,
  optional,
  type ProviderOf,
  type Registrar,
  type ServiceDescriptor,
  type ServiceRef,
  serviceRef,
  type Uses,
} from './composition/descriptors.js';
// ----- 插件定义 -----
export {
  definePlugin,
  type PluginDefinition,
  type PluginMeta,
  pluginDefinitionOf,
} from './composition/plugin-definition.js';
export { type ServiceFactory, type ServiceScope, serviceFactory } from './composition/service-factory.js';
// ----- 配置、日志 -----
export {
  type AalisConfig,
  ConfigManager,
  type ConfigManagerOptions,
  type ConfigProvider,
} from './infrastructure/config.js';
export {
  DefaultLogger,
  type LogEntry,
  type Logger,
  LogHub,
  type LogLevel,
} from './infrastructure/logger.js';
