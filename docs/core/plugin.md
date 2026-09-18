# PluginManager — 插件管理

管理插件的注册、激活、停用和热更新。

**源码**: `packages/core/src/orchestration/plugin.ts`

## 插件模块格式

```typescript
interface PluginModule {
  name: string;               // 插件名（如 '@aalis/plugin-llm-deepseek'）
  inject?: InjectDeclaration; // 依赖声明
  provides?: string[];        // 提供的服务名
  core?: boolean;             // 核心插件标记（不可禁用）
  reusable?: boolean;         // 允许同 module 多实例注册（`name:suffix`）
  /**
   * 级联契约：下游 inject 了本插件 provided 服务的消费者，
   * 是否需要在本插件 bounce 时被级联重新 apply。
   * 默认 false。绝大多数 provider 不需要设为 true，
   * 下游应使用 lazy `ctx.getService()` 透明获取新实例。
   * 详见 [plugin-author-guide §3.5](../plugin-author-guide.md#_3-5-级联契约-opt-in-requiresbounceondepchange)。
   */
  requiresBounceOnDepChange?: boolean;
  /** core 视为 opaque 数据原样透传；形状类型 ConfigSchema 在 @aalis/schema-config */
  configSchema?: Record<string, unknown>;
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
  单轮内消费者先于提供者 dispose；跨轮（依赖此刻仍在、下一轮才降级）与单插件 unload/disable/bounce 不在此保证内。

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

管理动作一律返回 `Promise<boolean>`，口径只有一条：**false = 主体不在注册表，或本次动作被状态 / 政策规则挡下**
（重名、未声明 `reusable` 的多实例、core 插件禁用、`disposed` 单向终态、`disabled` 态 bounce）；**true = 其余，含主体已在
目标态的幂等情形**。每个 false 分支都已记一笔日志。true 只说明请求已受理，激活是否落定看 `idle()`。

### `register(module, config?, instanceId?)`

注册插件并触发 recompute。重名或未声明 `reusable` 却要多实例时拒绝。

### `unload(instanceId)`

卸载插件，dispose 其 Context 并从注册表移除。撞上在途卸载时 join 它，返回时该实例已离开注册表。

### `enable(instanceId)` / `disable(instanceId)`

启用/禁用插件。core 插件不可禁用。

### `updateConfig(instanceId, config)`

更新配置并热重载。**现为 `bounce(instanceId, { config })` 的薄壳别名**，
保留化名便于调用点语义明确（WebUI / mcp-client / ConfigWatcher 都调这个）。
本插件会被 dispose + reapply；下游是否被级联 evict 取决于各下游插件的
`requiresBounceOnDepChange`（默认 false 不级联）。

### `bounce(instanceId, opts?: { config?, module? }): Promise<boolean>`

增量重载单个插件的统一入口：
- 可选 `opts.config`：同时写回 ConfigManager + entry.config
- 可选 `opts.module`：热替换 module 引用（热重载代码场景）
- dispose 旧 ctx → 粗状态转 pending → `recompute({type:'plugin-state-changed'})`
- 下游是否被级联 evict：仅当下游声明 `requiresBounceOnDepChange: true` 时才级联，
  默认不动。详见 [plugin-author-guide §3.5](../plugin-author-guide.md#_3-5-级联契约-opt-in-requiresbounceondepchange)。

## 反应式监听

- `service:registered` → `recompute({ type: 'service-up', service })`
- `service:unregistered` → `recompute({ type: 'service-down', service })`

`reloading` 与 `shuttingDown` 标志在 recompute 期间屏蔽重入。
