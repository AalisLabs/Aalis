# ServiceContainer — 服务容器

服务容器实现同名多实现 + 能力匹配的 IoC 查找。

**源码**: `packages/core/src/service.ts`

## 核心概念

- 一个服务名可有多个提供者（如 `llm` 有 DeepSeek 和 OpenAI 两个实现）
- 每个提供者声明能力集（capabilities）和优先级（priority）
- `get()` 返回满足所需能力的最高优先级实例

## ServiceEntry 结构

```typescript
interface ServiceEntry {
  instance: unknown;        // 服务实例
  capabilities: Set<string>; // 能力集
  priority: number;         // 优先级（越高越优先）
  contextId: string;        // 注册者 Context ID
}
```

## 关键方法

### `register(name, instance, capabilities?, priority?, contextId?)`

注册服务。同名服务按优先级降序排列。

### `get<T>(name, requiredCapabilities?)`

获取满足所有要求能力的最高优先级实例。遍历按优先级排序的提供者列表，返回首个 `capabilities ⊇ requiredCapabilities` 的实例。

### `has(name, requiredCapabilities?)`

检查是否存在满足能力的提供者。

### `getCapabilities(name)`

返回所有提供者的能力集并集。

### `unregisterByContext(contextId)`

移除指定 Context 注册的所有服务，返回被移除的 `[name, entry]` 列表。用于插件卸载时清理。

### `prefer(name, contextId)`

将指定 Context 的提供者置于列表首位（仅调整顺序，不改变优先级）。

## 依赖规范化

```typescript
function normalizeDependency(dep: string | ServiceDependency): NormalizedDependency
```

支持两种格式：
- 字符串: `'llm'` → `{ service: 'llm', capabilities: [] }`
- 对象: `{ service: 'llm', capabilities: ['tool_calling'] }`
