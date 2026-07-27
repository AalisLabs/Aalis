# core 语义契约（1.0 承诺书）

本文是 `@aalis/core` 对插件生态的**行为承诺**。1.0 起，下列不变量在任何 1.x 版本中不变；
未列入承诺的一切（内部实现、算法、数据结构、日志文案）随时可换。守卫：
`test/core/purity.test.ts`（词汇禁令 + 公开面快照）、`test/core/architecture.test.ts`（内部分层）。

## 一、四原语行为不变量

**events（`ctx.on` / `ctx.emit`）——广播**
- 监听器错误互相隔离：单个 handler 抛错（同步或异步）不影响其余 handler，也不使 `emit` reject。
- `emit` 按注册顺序依次调用，但**顺序不构成语义**：监听方不得依赖自己相对其他监听方的位置。
- 无返回通道、不可变更 payload 语义、不可截停。
- sticky 事件（`ready` / `app:started`）：注册晚于 emit 的监听器在下一个微任务收到补发。

**services（`ctx.provide` / `ctx.getService` / `ctx.getAllServices` / `whenService` / preference 三件套）——供需**
- 解析顺序恒为 **偏好 > 优先级 > 注册顺序**，所有读口（getService / getAllServices）一致。
- 同名多提供者并存；胜者变更经 `service:registered` / `service:unregistered` / `service:preference-changed` 事件可观察。
- `getService` 返回**当时点**的裸实例，从不阻塞、从不 await；消费方契约是惰性查询（每次用时取）。
- `whenService`：胜者不变则不动；胜者换人才 cleanup + 重挂；cb 返回的 cleanup 在下线与 dispose 时必被调用。

**hooks（`ctx.middleware` / `ctx.runHook`）——流程干预**
- 同一钩子键内按注册顺序执行洋葱模型；不调 `next()` 即合法截停（`runHook` 返回 `false`）。
- handler 抛错中断整链并上溯给 `runHook` 调用方（拦截者失败 = 流程该停）。
- 任何插件可驱动自己定义的钩子链；注册与执行权对称公开。

**contributions（`ctx.contribute` / `ctx.collect`）——汇集**
- 全局键 = `${ctx.id}/${局部id}`，由门面自动冠前缀：贡献者**构造上无法**顶替他人条目。
- 同一 ctx 内同局部 id 重复注册 = 替换（幂等）。
- `collect` 返回快照，排序是全局键的纯函数——同集合任意机器、任意重启，枚举顺序逐字节相同。
- 内核**从不执行**贡献 spec 中的任何插件代码；执行策略（并行/隔离/超时）全归收集方。

## 二、生命周期不变量

- 经 Context 门面注册的一切副作用（事件监听、服务、钩子、贡献、`onDispose` 回调），
  在该 Context `dispose` 后**必然消失**——包括子上下文级联与寄存在枢纽服务里的条目
  （`unregisterByPlugin(contextId)` 鸭子协议）。
- 清理相对注册**逆序**执行；单个清理器抛错不影响其余。
- `onDispose` 是插件清理副作用的唯一正确 API；`disposeAsync` 路径等待异步清理完成（带超时护栏）。
- 插件启停顺序：激活 = 提供者先于消费者；关停 = 消费者先于提供者（required 依赖拓扑）。
- required 依赖缺失 → 插件停在 pending（不阻塞、不轮询）；依赖就绪自动激活。

## 三、明确不承诺（实现自由区）

- recompute 的算法、轮次上界数值、内部数据结构（双账本形态、注册表实现）。
- 日志文案与级别、诊断信息格式。
- `@internal` 标注的成员（`serviceContainer` / `disposableCount` 等）与私有方法。
- `getStatus` 之外的枚举顺序（如 `getServiceNames` 的顺序）。

## 四、原语准入规则

新增第五原语必须同时满足三条，缺一不议：
1. **真实形状反复出现**——至少两个互不相关的领域在手工模拟同一交互形状；
2. **现有原语只能不安全地表达**——用现有原语实现必然放弃某类保障（幂等/定序/隔离/……），
   而非仅仅"写起来啰嗦"；
3. **事故实证**——已有因该形状被冒充而产生的真实缺陷记录。

原语增补永远是**纯加法**（新门面动词 + 新注册表），不改变既有原语的任何不变量。

## 五、内核负面清单（永不进入 core）

消息 / 会话 / 命令 / 用户 / 人设 / 调度 / 鉴权 / 存储 / LLM / 表单与渲染词汇 /
配置同步政策 / 多实例的配置文件编排 / 任何 `node:` API 与运行时依赖。
领域词汇一律经空扩展点（`ServiceTypeMap` / `AalisEvents` / `HookContextMap` /
`ContributionPointMap`）由 `-api` 包 declaration merging 注入。

## 六、公开面稳定性

| 层 | 成员 | 承诺 |
|---|---|---|
| stable | 四原语门面全部动词、`fork` / `useModule` / `onDispose` / `dispose` / `disposeAsync`、`App` / `createApp` / `AppOptions` providers、`ConfigManager` 快照读写、`PluginManager`（register/unload/enable/disable/bounce/getStatus/getPlugin/idle） | 1.x 内不破坏 |
| experimental | 无（0.9 收束后暂无试验面；新增能力先以此层进入） | 1.x 内可变，变更走 minor |
| internal | `@internal` 标注成员、私有方法、`DisposableChain` 等未从包根导出者 | 无承诺 |
