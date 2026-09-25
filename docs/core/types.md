# 核心类型定义

`@aalis/core` 导出的是运行时基础设施与事件扩展点 `AalisEvents`。业务服务接口、消息、工具、命令等一律在 `@aalis/api-*` / `@aalis/schema-*`，类型随服务描述符走，core 不持有领域词汇。

**源码**: `packages/core/src/index.ts`（值导出定格见 `test/core/purity.test.ts`）；类型按分层散在 `types/`、`composition/`、`infrastructure/`、`orchestration/`。

领域接口请到对应契约包查阅，文档入口：[api 包](../api/README.md) 与 [服务](../services/README.md)。

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
  reusable?: boolean;
  apply(caps: BoundOf<U>): void | Promise<void>;
}

function definePlugin<U extends Uses>(definition: PluginDefinition<U>): PluginDefinition<U>;
```

`name` 须为非空字符串，不含保留字符 `#`，也不含 `:suffix`（只用于 instanceId）。

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

公开类型不声明内部激活记录；经 `pluginsService` 拿到的 `getPlugin()` 是快照，宿主侧 `app.plugins.getPlugin()` 返回现场条目、应只读，状态与配置变更须经管理 API。状态摘要 `PluginStatusEntry` 另含 `provides` / `reusable` / `requiredServices` / `optionalServices`；`uses` 是完整声明的快照，每项为 `{ key, service, kind: 'required' | 'optional' }`，保留参数别名，零声明为 `[]`。Core 基础服务也计入对应依赖列表，不再另设 builtin 类别。配置详情经 `getPlugin(instanceId)` 从 `entry.config` / `entry.definition` 读取。

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

interface BindingPort<P> { /* name, id, identity, logger, current, require, all, follow, track, registrar */ }
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

`BindingPort.identity` 是这次激活的不透明资源身份（`symbol`），也是以这次激活名义调用提供者的凭据，见 [资源身份](service.md#资源身份)。

`ServiceInfo` 是无实例的登记元数据：`contextId`、`priority`、可选 `label`、`exclusive: boolean`。由 `services.inspect(key)` 返回。

---

## 基础服务与宿主服务

值导出（插件放进 `uses`）：`events`、`lifecycle`、`logger`、`config`、`provide`、`services`。`hooks` / `contributions` 不在 core，从 `@aalis/api-hooks` / `@aalis/api-contributions` 导入。

宿主服务：`appService`、`pluginsService`。两类都由根激活经 `provide` 独占登记，共用同一套服务协议，都须显式 `uses`；上面六项的提供者按调用方激活交出接口，见 [内置服务的登记](service.md#内置服务的登记)。配置文档的 `hostConfig` 在 `@aalis/api-host-config`，由宿主提供。

```typescript
interface LifecycleCap {
  readonly id: string;
  readonly closed: boolean;
  onDrain(fn: () => void | Promise<void>, label?: string): () => void;
  onDispose(fn: () => void | Promise<void>, label?: string): () => void;
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
  implementation: ProviderOf<D>,
  options?: ProvideOptions,
) => () => void;
```

`AppService` / `PluginManagerService` 见 [app.md](app.md)、[plugin.md](plugin.md)。六个管理动作返回 `Promise<boolean>`：false = 主体不在注册表或被状态 / 政策挡下（含定义或实例 id 校验失败、停机中的 register / bounce）；true = 其余，含幂等。停机进行中 unload 汇入停机计划后立即 true；disable 先判 `disposed` 终态，停机拆卸开始后对已标 `disposed` 的条目返回 false，其余同 unload。激活是否落定看 `idle()`。

---

## 扩展点

core 的扩展点只有 `AalisEvents`（core 自持基础设施事件，从来不空）。服务没有类型表——类型随描述符走。钩子与贡献点的扩展点随各自的契约包，增广目标分别是 `declare module '@aalis/api-hooks'` 与 `declare module '@aalis/api-contributions'`。

| 扩展点 | 所在包 | 含义 | 谁注入 |
|---|---|---|---|
| `AalisEvents` | `@aalis/core` | 事件名 → 参数元组 | core 自持 `service:*` / `plugin:*` / `app:*`；业务事件由 `-api` 注入 |
| `HookContextMap` | `@aalis/api-hooks` | 钩子名 → 中间件上下文 | 契约包内字面为空；`api-agent` / `api-gateway` / `api-memory` 等注入 |
| `ContributionPointMap` | `@aalis/api-contributions` | 贡献点名 → spec（须含 `id: string`） | 如 `api-agent` 的 `agent:prompt` |

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

core 不持配置文档，也不导出配置类型；插件自己的配置视图是内置服务 `config`（`Readonly<Record<string, unknown>>`）。配置文档类型 `AalisConfig` 与读写面 `HostConfig` 在 `@aalis/api-host-config`，runtime 的 `ConfigStore` / `ConfigProvider` 见 [运行态与配置文档](config.md)。

表单词汇（`ConfigSchema` / `SchemaField` / …）在 `@aalis/schema-config`。能力词汇（`CapabilityVisibility` 等）在 `@aalis/api-authority`。

日志接口与通道：`Logger` / `LogHub` / `DefaultLogger`，日志记录类型 `LogEntry` / `LogLevel`。行编解码 `formatLogLine` / `parseLogLine` 由 `@aalis/schema-log` 提供，它以 peer 依赖引用 Core 的记录类型。

---

## 编排与宿主 SPI

`App` / `AppOptions` / `createApp`；`PluginEntry` / `PluginState` / `parseInstanceId`；`RestartStrategy`。插件加载器 `PluginLoader` / `PluginDescriptor` 在 `@aalis/runtime`，插件包入口判定 `pluginDefinitionOf` 在 `@aalis/api-plugin-source`。

钩子的 `Hooks` / `MiddlewareFn` / `MiddlewareNext` 与贡献点的 `Contributions` / `ContributionSpec` / `ContributionHandle` 见 [api-hooks](../api/api-hooks.md)、[api-contributions](../api/api-contributions.md)。
