# ServiceContainer — 服务容器

服务容器实现同名多实现的 IoC 查找。

**源码**: `packages/core/src/service.ts`

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
}
```

## 关键方法

### `register(name, instance, priority?, contextId?, label?)`

注册服务，返回刚插入的 `ServiceEntry`。同名服务按优先级降序排列（稳定排序：同优先级先注册者在前）。可用返回的 entry 引用调用 `unregisterEntry` 精确删除这一条。

### `get<T>(name)`

返回当前胜者实例，解析顺序为 **「偏好 > 优先级 > 注册顺序」**：先看是否有偏好的提供者（且仍存在），否则取优先级最高、最先注册者。无提供者返回 `undefined`。

### `has(name)`

检查是否存在提供者（等价于 `get(name) !== undefined`）。

### `hasByContext(name, contextId)`

检查指定 contextId 是否注册了某服务。"拥有" 语义同时匹配 `contextId === ownerId` 和以 `ownerId + '/'` 为前缀的 per-entry 子 entry（如 `@aalis/plugin-ollama:main/llama3`）。

### `getEntries(name)` / `getAll<T>(name)`

枚举某服务的所有提供者（给 API/管控视图暴露用）。返回顺序遵循「偏好 > 优先级 > 注册顺序」。`getAll` 附带 `contextId` / `label` 提供者信息。

### `getServiceNames()`

列出所有已注册的服务名。

### `unregisterEntry(name, entry)`

按 entry 引用精确删除某个提供者（推荐），避免 "同一 contextId 多次 register" 时按 contextId 删除命中错误条目的 footgun。返回是否成功删除。

### `unregisterByContext(contextId)`

移除指定 Context 拥有的所有服务 entry，返回被移除的服务名列表。"拥有" 同 `hasByContext`（含 `id` 与 `id + '/'` 前缀子 entry）。用于插件卸载时清理。

## 服务偏好

当多个插件提供同名服务时，所有者可显式指定偏好的提供者（按 contextId），使其无视 priority 数值始终成为 `get()` 的胜者。

### `prefer(name, contextId)` / `unprefer(name)` / `getPreferred(name)`

容器层的偏好读写。偏好可在目标 entry 注册前提前设置——一旦该 contextId 注册即生效。

> 公开 API 走 `ctx.preferService()` / `ctx.unpreferService()` / `ctx.getPreferredService()`（额外 emit `service:preference-changed` 触发 `whenService` 重挂）；容器层方法仅供 Context 内部转发，插件勿直接调用。所有者也可在 WebUI 的 Services 页面设置偏好。

## 作用域子容器

### `createScope()`

创建作用域子容器（`ScopedServiceContainer`）。子容器读取时先查本地，miss 则 fallback 到父容器；写入（register / unregisterEntry）仅影响子容器自身。支持多层嵌套。

适用于沙盒/会话隔离场景：每个沙盒拥有独立的服务覆盖，同时继承全局公共服务（如 `authority`、`commands`）。

```typescript
const scoped = container.createScope();
scoped.register('agent', sandboxAgent); // 仅沙盒可见
scoped.get('authority'); // fallback 到父容器
```

## 依赖规范化

```typescript
function normalizeDependency(dep: string | ServiceDependency): NormalizedDependency
```

将依赖声明统一为 `{ service }`：字符串 `'llm'` 与对象 `{ service: 'llm' }` 都归一为 `{ service: 'llm' }`。
