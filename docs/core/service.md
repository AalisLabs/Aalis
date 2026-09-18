# ServiceContainer — 服务容器

服务容器实现同名多实现的 IoC 查找。

**源码**: `packages/core/src/primitives/services.ts`

## 核心概念

- 一个服务名可有多个提供者（如 `llm` 有 DeepSeek 和 OpenAI 两个实现）
- 每个提供者声明优先级（priority）；可选偏好（preference）覆盖优先级
- 服务选择走 **「偏好 > 优先级 > 注册顺序」**：`get()` 返回当前胜者实例
- 领域级筛选（如按 LLM 模型能力路由）由各 `-api` 自理，不在内核 DI

## ServiceEntry 结构

```typescript
interface ServiceEntry {
  instance: unknown;  // 服务实例
  priority: number;   // 优先级（越高越优先）
  contextId: string;  // 注册者 Context ID
  label?: string;     // 可选展示标签（如 "OpenAI / gpt-4o"）
  owner?: symbol;     // 清理归属（@internal）；getAll 的 ServiceView 投影不含它
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

### `getEntries(name)` / `getAll(name)`

枚举某服务的所有提供者（给 API/管控视图暴露用），两者都返回数组快照，顺序遵循「偏好 > 优先级 > 注册顺序」。`getAll` 的元素是 `ServiceView`（`ServiceEntry` 的投影：`instance` / `contextId` / `priority` / `label`，刻意不含清理归属 `owner`），已登记名按 `ServiceTypeMap` 推导 `instance` 类型。

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
