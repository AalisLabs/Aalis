# ServiceContainer — 服务容器

服务容器实现同名多实现的 IoC 查找。

**源码**: `packages/core/src/primitives/services.ts`

插件不直接持有容器：注册与消费走 Context 门面（`ctx.provide` / `ctx.getService` / `ctx.getAllServices` / `ctx.whenService` /
偏好三件套，见 [context.md — 服务 API](context.md)）。本页是注册表类本身的参考：宿主经 `AppOptions.services` 注入替身、
或管控类代码经 `app.services` 巡视时用；其方法签名按契约表归 experimental（随原语统一工作调整）。

## 核心概念

- 一个服务名可有多个提供者（如 `llm` 有 DeepSeek 和 OpenAI 两个实现）
- 每个提供者声明优先级（priority）；可选偏好（preference）覆盖优先级
- 服务选择走 **「偏好 > 优先级 > 注册顺序」**：`get()` 返回当前胜者实例
- 领域级筛选（如按 LLM 模型能力路由）由各 `-api` 自理，不在内核 DI

## ServiceView 结构

容器对外只交出条目的投影，每次读都是新对象，改它不影响容器；清理归属 `owner` 是容器内部的钥匙，任何读口都不交出：

```typescript
interface ServiceView<T = unknown> {
  instance: T;        // 服务实例
  contextId: string;  // 注册者 Context ID
  priority: number;   // 优先级（越高越优先）
  label?: string;     // 可选展示标签（如 "OpenAI / gpt-4o"）
}
```

## 关键方法

### `register(name, instance, contextId, owner?, options?)`

与另外三个注册表同形：`(键, 载荷, contextId, owner?)`，返回退订闭包。`options` 收 `priority`（默认 0）与 `label`。
已登记的服务名（`ServiceTypeMap` 里有的）按契约类型约束 `instance`，错误实现在编译期被拒；未登记名放行为 `unknown`。

`owner` 是清理归属（Context 门面自动传入本次激活的 symbol）；省略则该 entry 不被拆卸自动清理，调用方用返回的退订闭包自管。
退订闭包返回这次是否真的摘掉了条目——同一条目退订两次、或已被 `unregisterByOwner` 清走时为 `false`（门面据此决定要不要广播 `service:unregistered`）。
同名服务按优先级降序排列（稳定排序：同优先级先注册者在前）。

### `get(name)`

已登记的服务名按 `ServiceTypeMap` 推导实例类型；未登记名退回 `get<T>(name)` 的兜底重载。返回当前胜者实例，解析顺序为 **「偏好 > 优先级 > 注册顺序」**：先看是否有偏好的提供者（且仍存在），否则取优先级最高、最先注册者。无提供者返回 `undefined`。

### `hasByContext(name, contextId)`

检查指定 contextId 是否注册了某服务。"拥有" 语义同时匹配 `contextId === ownerId` 和以 `ownerId + '/'` 为前缀的 per-entry 子 entry（如 `@aalis/plugin-llm-ollama:main/llama3`）。

### `getAll(name)`

枚举某服务的所有提供者（业务遍历与管控视图共用），返回 `ServiceView` 投影的数组快照，顺序遵循「偏好 > 优先级 > 注册顺序」；已登记名按 `ServiceTypeMap` 推导 `instance` 类型。

### `getServiceNames()`

列出所有已注册的服务名。

### `unregisterByOwner(owner)`

移除该清理归属注册的所有 entry，返回被移除的服务名列表。按 owner 而非 contextId：同名 Context 各有各的 owner，互不误清；per-entry 子 entry 与主 entry 同 owner，一并清掉，不再依赖 id 前缀。用于插件卸载时清理。

## 服务偏好

当多个插件提供同名服务时，所有者可显式指定偏好的提供者（按 contextId），使其无视 priority 数值始终成为 `get()` 的胜者。

### `prefer(name, contextId)` / `unprefer(name)` / `getPreferred(name)`

容器层的偏好读写。偏好可在目标 entry 注册前提前设置——一旦该 contextId 注册即生效。

> 公开 API 走 `ctx.preferService()` / `ctx.unpreferService()` / `ctx.getPreferredService()`（额外 emit `service:preference-changed` 触发 `whenService` 重挂）；容器层方法仅供 Context 内部转发，插件勿直接调用。所有者也可在 WebUI 的 Services 页面设置偏好。

## 依赖规范化

```typescript
function normalizeDependency(dep: string | ServiceDependency): NormalizedDependency
```

将依赖声明统一为 `{ service }`：字符串 `'llm'` 与对象 `{ service: 'llm' }` 都归一为 `{ service: 'llm' }`。

## 扩展服务名（declaration merging）

服务名 → 实例接口的映射表是 `ServiceTypeMap`（core 内字面为空）。`-api` 契约包就近注入自己那一条，之后注册表的
`register` / `get` / `getAll` 与门面上的 `ctx.provide` / `ctx.getService` / `ctx.getAllServices` 在编译期即按契约类型工作：

```typescript
// packages/api-memory/src/index.ts —— 契约包，与接口定义同文件
export interface MemoryService { /* ... */ }

declare module '@aalis/core' {
  interface ServiceTypeMap {
    memory: MemoryService;
  }
}
```

```typescript
// 消费方：import 一次契约包（仅副作用，把类型注册进 ServiceTypeMap）
import '@aalis/api-memory';

ctx.provide('memory', new SqliteMemory());  // 实现不符契约 → 编译期被拒
const m = ctx.getService('memory');         // MemoryService | undefined
const all = ctx.getAllServices('memory');   // ServiceView<MemoryService>[]
```

- 增广只能用裸包名 `'@aalis/core'`：`declare module` 按说明符解析到的模块身份合并，只有解析到与 `-api` 包同一份
  `@aalis/core` 才进同一张 `ServiceTypeMap`。装进两份 core 时两份声明会绑成两个接口（TS2717，被 `skipLibCheck`
  吞掉），`getService('memory')` 静默落回 `<T = unknown>` 兜底重载——peer 区间禁 caret 就是为了避免装出两份。
- 未登记的名字照常可用，退回 `unknown`：`provide` 的实例放行，`getService<T>(name)` 由调用方 narrow。按运行时变量
  （而非字面量）寻址服务的场景走这条路。
- 这里只登记「服务名 → 实例接口」一件事。领域能力（LLM 的 `vision`、storage 的 `local-path`）挂在服务实例 / model
  handle 的元数据上，由各 `-api` 的 helper 按需筛选，不进内核 DI。
- core 自己 provide 的 `app` / `plugins` 不登记：`plugins` 的契约引用编排层词汇（`PluginEntry` 等），基础词汇文件
  `types/services.ts` 不得向上引用，成对登不了就一个不登；消费点显式传类型参数（`getService<AppService>('app')`）。
  谁注入了哪个服务名，见[扩展点索引 §1](../extensions/index.md)。
