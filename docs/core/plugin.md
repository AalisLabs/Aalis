# PluginManager — 插件管理

管理插件的注册、激活、停用和热更新。

**源码**: `packages/core/src/plugin.ts`

## 插件模块格式

```typescript
interface PluginModule {
  name: string;               // 插件名（如 '@aalis/plugin-deepseek'）
  inject?: InjectDeclaration; // 依赖声明
  provides?: string[];        // 提供的服务名
  core?: boolean;             // 核心插件标记（不可禁用）
  configSchema?: ConfigSchema;
  defaultConfig?: Record<string, unknown>;
  apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>;
}
```

## 插件状态

| 状态 | 说明 |
|---|---|
| `pending` | 已注册，等待依赖满足 |
| `activating` | 正在激活（调用 apply） |
| `active` | 已激活，正常运行 |
| `disabled` | 手动禁用 |
| `disposed` | 已卸载 |
| `error` | 激活失败 |

## 生命周期流程

```
register(module, config?)
  │
  ├─ 创建 PluginEntry (状态=pending)
  ├─ 归一化依赖声明
  ├─ 如果所有 required 依赖已满足 → tryActivate()
  │     ├─ fork 子 Context
  │     ├─ 调用 module.apply(ctx, config)
  │     ├─ 状态 → active
  │     └─ 发出 plugin:loaded 事件
  └─ 否则保持 pending，等待 service:registered 事件
```

## Soft Reload

`softReload()` 是固定点迭代机制，在服务注册/移除后调用：

```
do {
  changed = false

  Phase 1 — 停用:
    对每个 active 插件，检查 required 依赖是否仍满足
    不满足 → dispose 子 Context → 状态设为 pending → changed=true

  Phase 2 — 激活:
    对每个 pending 插件，检查 required 依赖是否满足
    满足 → tryActivate() → changed=true

  Phase 3 — 服务恢复:
    对每个必需服务（如 webui-server），如不可用:
      搜索能提供该服务的 pending 插件 → 递归激活其依赖链

} while (changed)

Phase 4 — 发出 plugins:changed 事件
```

## 关键方法

### `register(module, config?)`

注册插件并尝试激活。

### `unload(name)`

卸载插件，dispose 其 Context，状态设为 disposed。

### `enablePlugin(name)` / `disablePlugin(name)`

启用/禁用插件。core 插件不可禁用。

### `updatePluginConfig(name, config)`

更新配置并热重载（先 dispose 再重新 activate）。

### `ensureServiceProvider(serviceName)`

搜索 pending 插件池，找到能提供该服务的插件并递归激活。

## 事件监听

- `service:registered` → `checkPendingPlugins()`（尝试激活等待中的插件）
- `service:unregistered` → `checkActivePlugins()`（停用失去依赖的插件）
