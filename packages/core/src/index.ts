// ============================================================
// index.ts — @aalis/core 包根导出，按内部分层分节（见 docs/design/core-contract.md 第八节）：
//   自下而上：类型词汇与扩展点 → 原语注册表 → 服务描述符、内置能力与插件定义 → 编排层（含宿主 SPI）。
// 资源内核（kernel/）、原语注册表、激活记录与 PluginManager 类不导出：插件与宿主拿到的是按激活绑定的能力，不是内部对象。
// 领域词汇（消息、工具、LLM 等）一律在各 @aalis/api-* 包，服务类型随描述符走，core 不认识任何业务类型。
// ============================================================

// ----- 通用数据契约 + 扩展点 -----
export type {
  AalisEvents,
  AppService,
  PluginManagerService,
  PluginStatusEntry,
} from './types/index.js';

// ----- 原语的数据契约（注册表本身不外露，登记一律经描述符与资源口） -----
export type { ServiceInfo, ServiceView } from './primitives/services.js';

// ----- 编排层：应用骨架与插件管理 -----
export { App, type AppOptions, createApp } from './orchestration/app.js';
export { appService, pluginsService } from './orchestration/host-services.js';
export { type PluginEntry, type PluginState, parseInstanceId } from './orchestration/plugin.js';
// 宿主 SPI：重启策略
export type { RestartStrategy } from './orchestration/providers.js';

export {
  config,
  type Events,
  events,
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
} from './composition/plugin-definition.js';
// ----- 日志 -----
export {
  DefaultLogger,
  type LogEntry,
  type Logger,
  LogHub,
  type LogLevel,
} from './infrastructure/logger.js';
