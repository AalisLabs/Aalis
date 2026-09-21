# 核心类型定义

`@aalis/core` 导出的是运行时基础设施与三张扩展点表。业务服务接口、消息、工具、命令等一律在 `@aalis/api-*` / `@aalis/schema-*`，类型随服务描述符走，core 不持有领域词汇。

**源码**: `packages/core/src/index.ts`（值导出定格见 `test/core/purity.test.ts`）；类型按分层散在 `types/`、`composition/`、`infrastructure/`、`orchestration/`。

领域接口请到对应契约包查阅，文档入口：[api 包](../api/) 与 [服务](../services/)。

---

## 插件定义

```typescript
interface PluginMeta {} // core 内字面为空；额外字段由契约包 declaration merging 挂上

interface PluginDefinition<U extends Uses = {}> extends PluginMeta {
  name: string;
  displayName?: string;
  subsystem?: string;
  uses?: U;
  provides?: ServiceDescriptor<any, any>[];
  core?: boolean;
  reusable?: boolean;
  apply(caps: BoundOf<U>): void | Promise<void>;
}

function definePlugin<U extends Uses>(definition: PluginDefinition<U>): PluginDefinition<U>;
```

`name` 须为非空字符串，不含 `#`（子模块 id 分隔符），也不含 `:suffix`（只用于 instanceId）。

### PluginMeta 增强

core 对 `PluginMeta` 的字段零感知，只原样带在定义上：

```typescript
// @aalis/schema-config：配置表单是插件配置的唯一声明来源
declare module '@aalis/core' {
  interface PluginMeta {
    configSchema?: ConfigSchema;
  }
}

// @aalis/api-webui：仅用于前端展示
declare module '@aalis/core' {
  interface PluginMeta {
    extends?: ExtendDeclaration; // { events?: string[]; hooks?: string[] }
  }
}
```

写 `definePlugin({ configSchema, extends, … })` 时，对应包必须在编译图里（值导入或 `import type {}`），否则字段在类型上不存在。core 不解释 `configSchema`：默认值回填与按 schema 裁剪未知字段属宿主政策（`@aalis/runtime`）。

### 注册表条目

```typescript
type PluginState = 'pending' | 'activating' | 'active' | 'disabled' | 'disposed' | 'error';

interface PluginEntry {
  definition: PluginDefinition;
  instanceId: string;
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  required: string[];
  optional: string[];
}

function parseInstanceId(instanceId: string): { moduleName: string; suffix?: string };
```

公开类型不声明内部激活记录；`getPlugin()` 当前返回现场条目，管理面应只读，状态与配置变更须经管理 API。状态摘要 `PluginStatusEntry` 另含 `provides` / `core` / `reusable` / `requiredServices` / `optionalServices`；`uses` 是完整声明的快照，每项为 `{ key, service, kind: 'required' | 'optional' }`，保留参数别名，零声明为 `[]`。Core 基础服务也计入对应依赖列表，不再另设 builtin 类别。配置详情经 `getPlugin(instanceId)` 从 `entry.config` / `entry.definition` 读取。

---

## 描述符与绑定

```typescript
interface ServiceDescriptor<P, B = ServiceRef<P>> {
  readonly name: string;
  bind(port: BindingPort<P>): B;
}

interface ServiceRef<P> {
  readonly current: P | undefined;
  require(): P;
  all(): ServiceView<P>[];
  follow(attach: (provider: P) => void | (() => unknown)): () => void;
}

interface ServiceView<T = unknown> {
  instance: T;
  contextId: string;
  priority: number;
  label?: string;
}

interface BindingPort<P> { /* name, id, logger, closed, current, require, all, follow, track, registrar */ }
interface Registrar<Item> {
  add(item: Item): () => void;
}

function defineService<P>(name: string): ServiceDescriptor<P, ServiceRef<P>>;
function defineService<P, B>(name: string, bind: (port: BindingPort<P>) => B): ServiceDescriptor<P, B>;
function optional<P, B>(descriptor: ServiceDescriptor<P, B>): OptionalUse<P, B>;
function serviceRef<P>(port: BindingPort<P>): ServiceRef<P>;
function serviceRef<P, E extends object>(port: BindingPort<P>, extra: E): ServiceRef<P> & E;
```

既登记又被调用的服务，把登记方法作为第二参传入：`serviceRef(port, { registerX })`。不要对象展开——`current` 是 getter，展开会求值成一次性快照。

`ProviderOf<D>` / `BoundOf<U>` / `Uses` 是推导载体。详见 [service.md](service.md)、[hub-services.md](../design/hub-services.md)。

`serviceFactory` 返回 `ServiceFactory<T>`，回调同步创建 T，不能返回 Promise。回调的 `ServiceScope` 提供消费者的 `id` / `identity` / `logger` / `config` / `closed`，以及 `track` / `onDrain` / `onDispose` / `module`。完整寿命与回滚契约见 [服务工厂](service.md#按消费者创建实例)。

`ServiceInfo` 是无实例的登记元数据：`contextId`、`priority`、可选 `label`、`scope: 'shared' | 'activation'`、`exclusive: boolean`。由 `services.inspect(key)` 与 `ServiceContainer.inspect(name)` 返回；查询不会执行工厂。

---

## 基础服务与宿主服务

值导出（插件放进 `uses`）：`events`、`hooks`、`contributions`、`lifecycle`、`logger`、`config`、`provide`、`services`。

宿主共享实例服务：`appService`、`pluginsService`、`hostConfig`。上面八项由同步工厂按消费者激活创建；两类共用同一套服务协议，都须显式 `uses`。

```typescript
interface LifecycleCap {
  readonly id: string;
  readonly closed: boolean;
  onDrain(fn: () => void | Promise<void>, label?: string): () => void;
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
  module(definition: PluginDefinition, config?: Record<string, unknown>): Promise<ModuleHandle>;
}

interface ModuleHandle {
  readonly id: string;
  dispose(): void;
  disposeAsync(timeoutMs?: number): Promise<void>;
}

interface ProvideOptions {
  priority?: number;
  exclusive?: boolean;
  label?: string;
  entryId?: string;
  onBehalfOf?: string;
}

type Provide = <D extends ServiceDescriptor<any, any>>(
  descriptor: D,
  implementation: ProviderOf<D> | ServiceFactory<ProviderOf<D>>,
  options?: ProvideOptions,
) => () => void;
```

`AppService` / `PluginManagerService` 见 [app.md](app.md)、[plugin.md](plugin.md)。六个管理动作返回 `Promise<boolean>`：false = 主体不在注册表或被状态 / 政策挡下（含定义或实例 id 校验失败、停机中的 register / bounce）；true = 其余，含幂等。停机进行中 unload / disable 汇入停机计划后立即 true。激活是否落定看 `idle()`。

---

## 扩展点

core 保留三张空扩展点接口（另：`AalisEvents` 自持基础设施事件，从来不空）。服务没有类型表——类型随描述符走。

| 扩展点 | 含义 | 谁注入 |
|---|---|---|
| `AalisEvents` | 事件名 → 参数元组 | core 自持 `service:*` / `plugin:*` / `app:*`；业务事件由 `-api` 注入 |
| `HookContextMap` | 钩子名 → 中间件上下文 | core 内字面为空；`api-agent` / `api-gateway` / `api-memory` 等注入 |
| `ContributionPointMap` | 贡献点名 → spec（须含 `id: string`） | 如 `api-agent` 的 `agent:prompt` |

```typescript
type MiddlewareNext = () => Promise<void>;
type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;
```

事件目录以 [events.md](events.md) 为准。谁注入了哪一族业务事件 / 钩子 / 贡献点，见 [扩展点索引](../extensions/index.md)。

```typescript
interface AalisEvents {
  'service:registered': [name: string];
  'service:unregistered': [name: string];
  'service:preference-changed': [name: string];
  'plugin:loaded': [instanceId: string];
  'plugin:unloaded': [instanceId: string];
  'plugins:changed': [];
  'app:starting': [];
  'app:ready': [];
  'app:started': [];
  'app:restarting': [];
  'app:stopping': [];
}
```

`AalisEvents` 类型封闭（没有 `[key: string]` 兜底）。动态事件名走模板字面量签名，见 events.md。

---

## 配置与日志

`AalisConfig` 仅声明基础字段（`name` / `logLevel` / `plugins` / `disabledPlugins` / `servicePreferences`）加索引兜底；业务字段由对应 `-api` 注入。`ConfigManager` / `ConfigProvider` 见 [config.md](config.md)。

表单词汇（`ConfigSchema` / `SchemaField` / …）在 `@aalis/schema-config`。能力词汇（`CapabilityVisibility` 等）在 `@aalis/api-authority`。

日志接口与通道：`Logger` / `LogHub` / `DefaultLogger`。日志记录类型 `LogEntry` / `LogLevel` 与行编解码 `formatLogLine` / `parseLogLine` 由 `@aalis/schema-log` 提供。

---

## 编排与宿主 SPI

`App` / `AppOptions` / `createApp`；`PluginManager` / `PluginEntry` / `PluginState` / `parseInstanceId`；`PluginLoader` / `PluginDescriptor` / `RestartStrategy`。

四原语注册表类：`EventBus` / `ServiceContainer` / `HookRegistry` / `ContributionRegistry`。贡献点的 `ContributionSpec` / `ContributionHandle` 见 [contributions.md](contributions.md)。
