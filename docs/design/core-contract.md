# core 语义契约（1.0 承诺书）

本文是 `@aalis/core` 对插件生态的**行为承诺**。1.0 起，下列不变量在任何 1.x 版本中不变；
未列入承诺的一切（内部实现、算法、数据结构、日志文案）随时可换。守卫：
`test/core/purity.test.ts`（词汇禁令 + 公开面快照）、`test/core/architecture.test.ts`（内部分层）。

## 一、四原语行为不变量

**events（`ctx.on` / `ctx.emit`）——广播**
- 监听器错误互相隔离：单个 handler 抛错（同步或异步）不影响其余 handler，也不使 `emit` reject。
- `emit` 按注册顺序依次调用，但**顺序不构成语义**：监听方不得依赖自己相对其他监听方的位置。
- 无返回通道、不可变更 payload 语义、不可截停。
- sticky 事件（`app:ready` / `app:started`）：注册晚于 emit 的监听器在下一个微任务收到补发。

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
- 全局键 = `${ctx.id}/${局部id}`，由门面自动冠前缀：**spec.id 侧**构造上无法顶替他人条目
  （局部 id 禁空、禁含 `/`，注册期抛错）。该保证以 `ctx.id` 为信任锚——`fork` / `useModule`
  不保证 ctx.id 唯一，重复 ctx.id 的两方共用同一命名空间。
- 已 dispose 的 Context 上 `contribute` 被拒（warn + no-op），不影响同 id 的活实例。
- 同一 ctx 内同局部 id 重复注册 = 替换（幂等）。
- `collect` 返回快照，排序是全局键的纯函数——同集合任意机器、任意重启，枚举顺序逐字节相同。
- 内核**从不执行**贡献 spec 中的任何插件代码；执行策略（并行/隔离/超时）全归收集方。

## 二、生命周期不变量

- 经 Context 门面注册的一切副作用（事件监听、服务、钩子、贡献、`onDispose` 回调），
  在该 Context `dispose` 后**必然消失**——包括子上下文级联与寄存在枢纽服务里的条目
  （`unregisterByPlugin(contextId)` 鸭子协议）。
- 清理链分撤回段（`whenService` 的 cleanup）与清理段（`onDispose`）：撤回段整体先于清理段，段内相对注册**逆序**执行；单个清理器抛错不影响其余。
- `onDispose` 是插件清理副作用的唯一正确 API；`disposeAsync` 路径等待异步清理完成（带超时护栏）。
- 插件启停顺序：激活 = 提供者先于消费者（required 依赖拓扑）。关停 = 消费者先于提供者**只在 `App.stop()` 的整体拓扑逆序成立**，异步清理按 `disposeTimeoutMs` 逐项设限；单插件 `unload` / `disable` / `bounce` 不提供该顺序保证，消费者的 onDispose 拿到的服务可能已不可用。
- 提供者换人（多提供者其一退出、偏好切换、更高优先级上线）不改变插件的目标状态，经 `service:registered` / `service:unregistered` / `service:preference-changed` 可观察；`requiresBounceOnDepChange` 的级联只在依赖的服务名整个落空、或依赖的 provider 自身被 bounce 时触发。要跟随换人用 `whenService`。
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
| stable | 四原语门面全部动词、`fork` / `useModule` / `onDispose` / `dispose` / `disposeAsync`、`App` / `createApp` / `AppOptions` providers、`ConfigManager` 快照读写、`PluginManagerService` 接口的全部成员（接口即清单，不在此另抄一份） | 1.x 内不破坏 |
| experimental | 四个注册表类（`EventBus` / `HookRegistry` / `ServiceContainer` / `ContributionRegistry`）的直接持有面：签名随原语统一工作调整，0.13 / 0.14 各改过一轮 | 1.x 内可变，变更走 minor |
| internal | `@internal` 标注成员、私有方法、`DisposableChain` 等未从包根导出者 | 无承诺 |

## 七、1.0 之前的实况（避免误读上表）

**上表的承诺自 1.0 起生效。1.0 之前 core 的公开面在次版本里被删过，且不止一次：**

| 版本 | 删除的公开面 |
|---|---|
| 0.7.0 | `Context.createScope`、`ScopedConfigManager`、`ScopedServiceContainer` |
| 0.9.0 | `CORE_CONFIG_SCHEMA` / `ConfigSchema` 全家、`Context.once` / `hasService` / `getServiceEntries`、`PluginManager.createInstance` / `removeInstance`、`ServiceContainer.has`、`EventBus.removeAll`、`ConfigManager.syncPluginDefaults`、`AppOptions.configSync` |
| 0.12.0 | `ServicePriority` / `ServicePriorityValue`（0.11.0 仍从包根导出，服务优先级改为裸数字后移除） |
| 0.13.0 | 四个注册表的 `unregisterByContext`（换为 `unregisterByOwner(owner: symbol)`）；另有三处改形而非删除：`saveConfig()` 返回 `Promise<void>`、`useModule()` 返回 `ModuleHandle`、`EventBus.on` 第三参由 `string` 改为 `symbol` |
| 0.14.0 | `ServiceContainer.unregisterEntry`（`register` 改为返回退订闭包）；改形：`ServiceContainer.register(name, instance, contextId, owner?, options?)` 与 `HookRegistry.register` 的 `contextId` 必填；`ContributionRegistry` 的注册与读取动词按 `ContributionPointMap` 约束键；`ServiceContainer` 的服务名保持开放，约束落在载荷 `ServiceOf<K>` 与 `get` / `getAll` 的按键重载上；事件键 `ready` / `restarting`（改名 `app:ready` / `app:restarting`，屏障统一 `app:` 前缀）；`PluginManagerService.enablePlugin` / `disablePlugin` / `updatePluginConfig`（改名 `enable` / `disable` / `updateConfig`；类上的 `bouncePlugin` 改 `bounce`）；改形：`PluginManagerService.register` / `unload` 由 `Promise<void>` 改 `Promise<boolean>`（六个管理动作同一口径）；行为：`plugin:loaded` 不再等监听器 |

因此插件生态里常见的 `peerDependencies: { "@aalis/core": ">=0.2.0 <1.0.0" }` **不是**"core 保证
0.x 内兼容"的推论——它只是"没用到新 API 的插件不必随次版本重发"的便利区间。用了某个版本才有的
API，就把下限抬到那个版本（如 0.13.0 这批的 runtime / plugin-cli / plugin-media / plugin-package-manager
因用到 `saveConfig()` / `config.save()` 的 Promise 返回值，抬到 `>=0.13.0 <1.0.0`）。

**版本号语义**：core 在 1.0 之前，次版本（0.x.0）可含破坏性变更并在发布说明中列出迁移路径；
补丁版本（0.x.y）只做修复与加法。1.0 之后按标准 semver。

**禁 caret，一律用宽区间**：`@aalis/core` 的 peerDep 用 `>=x.y.z <1.0.0`；`@aalis/schema-config`
被五十余个包依赖，同样用 `workspace:>=0.9.0 <1.0.0`（发布时原样保留）。0.x 的 caret 锁死 minor——
用了 caret，被依赖包加一个词汇就会让所有已发布消费者拒收新版，node_modules 里出现两份副本，
而 declaration merging 按模块副本生效，扩展点的合并面会就此裂开。

## 八、内部分层（非承诺面，改动须守）

core 源码按目录分四层，自下而上，每层只许 import 本层与更低层；依赖方向由 `test/core/architecture.test.ts` 机器守（按解析后的真实路径判层，只查直接 import 说明符）：

- **资源内核** `kernel/`（`lifecycle.ts`、`disposable-chain.ts`）：父子归属、清理链、可等待关闭与逐项超时、错误隔离与上报。只认自己，不依赖类型词汇、四原语、Context 或编排。
- **四原语** `primitives/`（events、hooks、services、contributions）：定义插件之间协作方式的四个注册表。只认 kernel 与类型词汇，不认识 Context、Logger、Config；需要上报的诊断经注入的回调送出（`onHandlerError`、`onStall`）。
- **Context 基础** `context/`（context、services-helpers、config、logger）：Context 门面把注入的四原语收窄成插件可见的注册面（四原语的实例由编排层构造），连同配置、日志与服务接线辅助；不 import 编排层。
- **编排层** `orchestration/`（app、plugin、plugin-activation、plugin-topology、providers）：把下层机制编排成插件生命周期与应用骨架，含宿主 SPI（插件加载器、重启策略）。

src 根只留 barrel（`index.ts`）。配置持久化的宿主 SPI（`ConfigProvider`）只依赖 `AalisConfig`，与 `ConfigManager` 同处 `context/config.ts`。`types/` 按种类存放类型词汇：`app.ts`、`plugin.ts` 属编排层词汇，`index.ts` barrel 会把它们一并带出，下层三者都不得引用；其余基础词汇文件只许互相引用。

层间依赖的性质（运行时值依赖与纯类型依赖分开看）：

| 从 | 到 | 性质 |
|---|---|---|
| primitives | kernel | 值：events / hooks 上报诊断用的 `reportQuietly` |
| primitives | 基础词汇 | 纯类型 |
| context | kernel | 值：`Lifecycle`、`reportQuietly` |
| context | primitives、基础词汇 | 纯类型——四原语的实例由编排层构造后注入，Context 不 `new` 它们 |
| orchestration | context、primitives、kernel | 值：App 构造 Context 与四个注册表，上报走 kernel 的 `reportQuietly` |
| `types/app.ts`、`types/plugin.ts` | context、primitives、基础词汇 | 纯类型 |

kernel 与基础词汇文件不依赖任何东西。

文件内的 import 与包根 index.ts 的导出按同一层序自下而上排列：types → kernel → primitives → context → orchestration → 同层兄弟，组间空行；由 biome 对 `packages/core/src/**` 的 organizeImports 分组配置守。同一模块既导值又导类型时写成一条语句、类型加内联 `type` 修饰符；全是类型的模块用 `export type {}`。

文件前言与分节：带前言的文件用 60 个 `=` 的 `//` 横幅夹住前言（首行「文件名 — 一句话」），无前言的文件不补；文件内分节一律一行 `// ----- 节名 -----`。JSDoc 描述在前、`@internal` 等标签收尾（单行式也展开成多行）；不用警示符号，告诫写成陈述句。

私有成员的写法：面向插件的 `Context` 一律 ECMAScript `#` 私有（运行时对插件不可见，`test/core/purity.test.ts` 用实例自有属性快照守）；其余类用 TypeScript `private` 裸名；都不带 `_` 前缀（biome 对 `packages/core/src/**` 的 `useNamingConvention` 守）。

诊断与错误的写法（文字规矩，无机器守——正则守卫经变异证明会被折行调用与含引号的英文骗过）：错误对象一律作 logger 的附加参数
（`logger.error('xxx 失败:', err)`），不内插进消息——内插只剩 message、丢 stack，logger 写入前会把换行转义成单行。宿主 SPI
（插件加载器、重启策略、配置 provider）的失败一律 `error` 级。kernel 抛出的错误信息用中文、带 `Lifecycle:` 前缀、不带节点 id
（kernel 不认识 Context；这两条抛错是收养关系写错的编程错误，不是运行时故障，抛给调用方即止）。

不拆 kernel 包：包是发布单位不是模块化单位；维持可拆的依赖方向，出现不依赖 core 的真实使用者时再议。资源内核不从包根导出，其不变量：子节点级联序（先关全部子节点 → 撤回对外注册 → 自身清理链按段逆序 → 收尾）；关闭后登记立即执行（与 TC39 `DisposableStack` 抛错相反，用来接住初始化或子节点关闭期间迟到的资源）；超时只是停止等待，不代表资源已释放；每个 Lifecycle 至多跟踪一次初始化（调用方保证，再次调用会覆盖前一次）。
