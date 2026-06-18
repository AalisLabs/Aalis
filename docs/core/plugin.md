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
  reusable?: boolean;         // 允许同 module 多实例注册（`name:suffix`）
  /**
   * 级联契约：下游 inject 了本插件 provided 服务的消费者，
   * 是否需要在本插件 bounce 时被级联重新 apply。
   * 默认 false。绝大多数 provider 不需要设为 true，
   * 下游应使用 lazy `ctx.getService()` 透明获取新实例。
   * 详见 [plugin-author-guide §3.5](../plugin-author-guide.md#35-级联契约opt-in)。
   */
  requiresBounceOnDepChange?: boolean;
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

## 统一状态机：`recompute(reason)`

PluginManager 只有一个状态变更入口 `recompute(reason)`。所有路径
（启用/禁用、配置更新、bounce、关机、服务注册/移除反应式回调）都被归一为一个
`RecomputeReason` 后汇入：

```typescript
type RecomputeReason =
  | { type: 'service-up'; service: string }      // service:registered 反应式
  | { type: 'service-down'; service: string }    // service:unregistered 反应式
  | { type: 'plugin-state-changed' }             // enable/disable/updateConfig/bounce
  | { type: 'shutdown' };                        // App.stop()
```

每轮 recompute 先按 provider→consumer 拓扑排序，然后：

```
Phase A 反向遍历:
  对每个 active entry，computeTargetState() 计算目标态
    目标 ≠ active → dispose 子 Context → 状态 → pending（或 disposed if shutdown）
  消费者先于提供者 dispose，dispose hook 访问依赖服务安全。

Phase B 正向遍历（非 shutdown）:
  对每个 pending entry，目标 = active 时调用 tryActivate()
  提供者先于消费者 active。

如本轮有变动则进入下一轮，直到稳定（fixed-point）或 maxRounds=20。
service-up / service-down 在第二轮起退化为 plugin-state-changed，避免无限 optional bounce。
```

收尾发出 `plugins:changed` 事件（shutdown 时跳过）。

`stopAll()` 与 `softReload()` 现在是 `recompute({type:'shutdown'})` 与
`recompute({type:'plugin-state-changed'})` 的薄壳。

## 关键方法

### `register(module, config?)`

注册插件并触发 recompute。

### `unload(name)`

卸载插件，dispose 其 Context，状态设为 disposed。

### `enablePlugin(name)` / `disablePlugin(name)`

启用/禁用插件。core 插件不可禁用。

### `updatePluginConfig(name, config)`

更新配置并热重载。**现为 `bouncePlugin(name, { config })` 的薄壳别名**，
保留化名便于调用点语义明确（WebUI / mcp-client / ConfigWatcher 都调这个）。
本插件会被 dispose + reapply；下游是否被级联 evict 取决于各下游插件的
`requiresBounceOnDepChange`（默认 false 不级联）。

### `bouncePlugin(name, opts?: { config?, module? }): Promise<boolean>`

增量重载单个插件的统一入口：
- 可选 `opts.config`：同时写回 ConfigManager + entry.config
- 可选 `opts.module`：热替换 module 引用（热重载代码场景）
- dispose 旧 ctx → 粗状态转 pending → `recompute({type:'plugin-state-changed'})`
- 下游是否被级联 evict：仅当下游声明 `requiresBounceOnDepChange: true` 时才级联，
  默认不动。详见 [plugin-author-guide §3.5](../plugin-author-guide.md#35-级联契约opt-in)。

## 反应式监听

- `service:registered` → `recompute({ type: 'service-up', service })`
- `service:unregistered` → `recompute({ type: 'service-down', service })`

`reloading` 与 `shuttingDown` 标志在 recompute 期间屏蔽重入。
