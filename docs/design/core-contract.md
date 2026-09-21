# core 语义契约（1.0 承诺书）

本文是 `@aalis/core` 对插件生态的**行为承诺**。1.0 起，下列不变量在任何 1.x 版本中不变；
未列入承诺的一切（内部实现、算法、数据结构、日志文案）随时可换。守卫：
`test/core/purity.test.ts`（词汇禁令 + 公开面快照）、`test/core/architecture.test.ts`（内部分层）。

## 一、四原语行为不变量

插件在 `definePlugin({ uses })` 里声明描述符，`apply` 拿到按这次激活绑定的接口。没有默认注入。内置能力（`events` / `hooks` / `contributions` / `lifecycle` / `logger` / `config` / `provide` / `services`）绑的是这次激活自身的基础设施，不可被 `provide` 替换，也不参与激活闸。

**events（`events.on` / `events.emit`）——广播**
- 监听器错误互相隔离：单个 handler 抛错（同步或异步）不影响其余 handler，也不使 `emit` reject。
- `emit` 按注册顺序依次调用，但**顺序不构成语义**：监听方不得依赖自己相对其他监听方的位置。
- 无返回通道、不可变更 payload 语义、不可截停。
- sticky 事件（`app:ready` / `app:started`）：注册晚于 emit 的监听器在下一个微任务收到补发。

**services（`provide` / `ServiceRef` / `services`）——供需**
- 解析顺序恒为 **偏好 > 优先级 > 注册顺序**，所有读口（`current` / `require()` / `all()` / `services.get` / `services.all`）一致。
- 同名多提供者并存；胜者变更经 `service:registered` / `service:unregistered` / `service:preference-changed` 事件可观察。
- `current` / `require()` 返回**当时点的提供者本身**，从不阻塞、从不 await；不是自动转发所有调用的代理。把引用存起来须自行承担它失效。`require()` 在 required 依赖丢失到调度收敛之间也可能短暂抛错。
- `all()` 每次调用重新枚举。长期缓存的非默认提供者不受关停依赖边保护：提供者有失效逻辑则调用会抛，没有则可能静默成功。
- `follow(attach)`：胜者不变则不动；胜者换人时先跑上次返回的清理，等其 Promise 落定之后才用新实例再挂；下线与关闭时清理。`attach` 必须同步——需要清理就返回函数，不需要就不返回；thenable 会被接住并 warn，不会当 cleanup。拒绝被隔离并报告，但不证明旧资源已释放。
- `services.get` / `services.all` 是动态查询：不产生依赖边，不参与激活闸，关停期可能拿空。需要等待、重绑与关停顺序就把描述符写进 `uses`。
- `provide(descriptor, impl, options?)` 是唯一发布入口。`options.onBehalfOf` 的条目逻辑身份取被代者，清理仍归本激活；代登记不计入代理人的 `provides`。

**hooks（`hooks.middleware` / `hooks.run`）——流程干预**
- 同一钩子键内按注册顺序执行洋葱模型；不调 `next()` 即合法截停（`hooks.run` 返回 `false`）。
- handler 抛错中断整链并上溯给 `hooks.run` 调用方（拦截者失败 = 流程该停）。
- 任何插件可驱动自己定义的钩子链；注册与执行权对称公开。

**contributions（`contributions.contribute` / `contributions.collect`）——汇集**
- 全局键 = `${lifecycle.id}/${局部id}`，由门面自动冠前缀：**spec.id 侧**构造上无法顶替他人条目
  （局部 id 禁空、禁含 `/`，注册期抛错）。该保证以这次激活的逻辑 id 为命名空间——
  调度器保证顶层 `instanceId` 不重复；`lifecycle.module` 同名重复挂载会加 `~n` 后缀；
  仍出现重复 id 的两方共用同一命名空间。
- 已关闭的激活上 `contribute` 被拒（warn + no-op），不影响同 id 的活实例。
- 同一激活内同局部 id 重复注册 = 替换（幂等）。
- `collect` 返回快照，排序是全局键的纯函数——同集合任意机器、任意重启，枚举顺序逐字节相同。
- 内核**从不执行**贡献 spec 中的任何插件代码；执行策略（并行/隔离/超时）全归收集方。

## 二、生命周期不变量

- 经这次激活的能力门面登记的一切副作用（事件监听、服务、钩子、贡献、`onDrain` / `onDispose`、`follow` / `track` / `registrar`），
  在该激活关闭后**必然消失**——包括子模块级联与寄存在枢纽服务里、按激活身份清扫的条目。
- 清理链分撤回段（`follow` 返回的 cleanup、registrar 撤回、四原语退订）与清理段（`onDispose`）：撤回段整体先于清理段，段内相对注册**逆序**执行；单个清理器抛错不影响其余。
- `onDrain` 在撤回之前执行：此刻本激活的监听、登记与声明的依赖都还在，用于停接新活、把在手的数据交给下层并等待确认。`onDispose` 在对外登记已撤回之后执行；依赖可能已不可用。异步清理在 `disposeAsync` 路径被等待（带 `disposeTimeoutMs` 护栏）；超时只是停止等待，不代表资源已释放。
- 子模块经 `lifecycle.module(definition, config?)` 挂载：独立身份与生命周期，能力按子激活重新绑定，随父关闭，不进调度器。挂载时缺 required 服务即拒绝（抛错，`apply` 不执行）；挂上之后没有独立持续激活闸，不能把它与顶层插件调度等同。
- 激活 = 提供者先于消费者（required 依赖拓扑）。关闭按每个激活的 drain 与 close 两阶段编排。普通依赖：消费者整个 close 完，提供者才 drain。父使用自己子树的服务：父 drain 先于子 close。后代使用祖先的服务：不往排序图加边，由归属树保证子 close 先于祖先 close。环内 optional 边构成的强连通分量（≥2 个激活）先让成员全部 drain，再任一 close——drain 期间对方仍活着，双方 `onDrain` 都能 `require()`；无法解除的 required 环告警后强行放行。归属约束与环外约束一条不松。依赖交接放 `onDrain`；`onDispose` 阶段依赖可能已不可用。`App.stop()` 把全部 active 插件与根激活放进同一张计划。单独 `unload` / `disable` / `bounce` 走同一套分阶段关闭，但不享有整 App 关停那一层「根绑定与全部插件同计划」的交接保证。动态查询与调用方缓存的裸引用不产生边。
- `app:stopping` 是屏障知会，不是清理通道；只在 `App.stop()` 全局停机时发一次，bounce / unload / disable 不发。清理走 `onDrain` / `onDispose`。`App.stop()` 顺序：`beginShutdown()`（冻结新增绑定并进入停机态）→ `idle()`（排干在飞重算）→ 发出 `app:stopping` → 关停计划。监听器全部返回后才执行停机计划。窗口内 `unload` / `disable` 汇入该计划后立即返回 true（不等拆卸完成）；`register` / `bounce` 返回 false（与定义或实例 id 校验失败同属政策挡下的 false 口径）。已冻激活上 `provide` 记 warn 后忽略、不抛；`lifecycle.module` 抛「已 dispose」。停机完成后：对新定义 `register` 返回 false 且不落账；对已 disposed 实例的 `enable` / `updateConfig` / `bounce` 返回 false；`idle()` 落定。
- 提供者换人（多提供者其一退出、偏好切换、更高优先级上线）不改变插件的目标状态，经 `service:registered` / `service:unregistered` / `service:preference-changed` 可观察。要跟随换人用 `follow`，不要指望消费者被级联重启。
- required 依赖缺失 → 顶层插件停在 pending（不阻塞、不轮询）；依赖就绪自动激活。初始化期间本次 required 绑定的 `require()` 原样抛出不可用错误时，先回滚资源再回到 pending；optional、自造/包装异常及其他激活的错误不适用。持续失稳的自动尝试在单次重算任务内有界，点名后暂缓，不影响其他插件与管理操作。

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
领域词汇一律经空扩展点（`AalisEvents` / `HookContextMap` /
`ContributionPointMap`）与服务描述符由 `-api` 包注入。服务类型随描述符走，不经一张全局类型表。
插件元数据（`PluginMeta`）由 schema-config / api-webui 等经 declaration merging 挂字段，core 对那些字段零感知。

## 六、公开面稳定性

| 层 | 成员 | 承诺 |
|---|---|---|
| stable | `definePlugin` / `defineService` / `optional` / `serviceRef`、`ServiceRef` 的 `current` / `require()` / `all()` / `follow()`、内置能力描述符（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）、宿主描述符（`appService` / `pluginsService` / `hostConfig`）、`App.plugin` / `App.bind` / `App.config` / `App.plugins`、`createApp` / `AppOptions` providers、`ConfigManager` 快照读写、`PluginManagerService` 接口的全部成员（接口即清单，不在此另抄一份） | 1.x 内不破坏 |
| experimental | 四个注册表类（`EventBus` / `HookRegistry` / `ServiceContainer` / `ContributionRegistry`）的直接持有面：签名随原语统一工作调整，0.13 / 0.14 各改过一轮 | 1.x 内可变，变更走 minor |
| internal | `@internal` 标注成员、私有方法、激活记录类、`DisposableChain` 等未从包根导出者 | 无承诺 |

## 七、1.0 之前的实况（避免误读上表）

**上表的承诺自 1.0 起生效。1.0 之前 core 的公开面在次版本里被删过，且不止一次：**

| 版本 | 删除的公开面 |
|---|---|
| 0.7.0 | `Context.createScope`、`ScopedConfigManager`、`ScopedServiceContainer` |
| 0.9.0 | `CORE_CONFIG_SCHEMA` / `ConfigSchema` 全家、`Context.once` / `hasService` / `getServiceEntries`、`PluginManager.createInstance` / `removeInstance`、`ServiceContainer.has`、`EventBus.removeAll`、`ConfigManager.syncPluginDefaults`、`AppOptions.configSync` |
| 0.12.0 | `ServicePriority` / `ServicePriorityValue`（0.11.0 仍从包根导出，服务优先级改为裸数字后移除） |
| 0.13.0 | 四个注册表的 `unregisterByContext`（换为 `unregisterByOwner(owner: symbol)`）；另有三处改形而非删除：`saveConfig()` 返回 `Promise<void>`、`useModule()` 返回 `ModuleHandle`、`EventBus.on` 第三参由 `string` 改为 `symbol` |
| 0.14.0 | `ServiceContainer.unregisterEntry`（`register` 改为返回退订闭包）；改形：`ServiceContainer.register(name, instance, contextId, owner?, options?)` 与 `HookRegistry.register` 的 `contextId` 必填；`ContributionRegistry` 的注册与读取动词按 `ContributionPointMap` 约束键；`ServiceContainer` 的服务名保持开放，约束落在载荷 `ServiceOf<K>` 与 `get` / `getAll` 的按键重载上；事件键 `ready` / `restarting`（改名 `app:ready` / `app:restarting`，屏障统一 `app:` 前缀）；`PluginManagerService.enablePlugin` / `disablePlugin` / `updatePluginConfig`（改名 `enable` / `disable` / `updateConfig`；类上的 `bouncePlugin` 改 `bounce`）；改形：`PluginManagerService.register` / `unload` 由 `Promise<void>` 改 `Promise<boolean>`（六个管理动作同一口径）；行为：`plugin:loaded` 不再等监听器 |
| 0.17.0 | **删除**：包根激活记录类与 `App` 上的公开激活入口、插件模块形状（具名 `name` / `inject` / `provides` 与函数 default）、全局服务类型表与 `ServiceOf`、级联 bounce 开关与 `evictDownstreamConsumers`、契约包 `useXxxService` helper、`ServiceContainer.getEntries` 与包根 `ServiceEntry`。**改形**：`apply` 入参改为 `uses` 装配出的绑定接口；四原语与配置 / 日志 / 生命周期改为显式能力描述符；按名取服务改为 `ServiceRef` 的 `current` / `require()` / `all()`，有状态跟随改为 `follow`；子模块口改为 `lifecycle.module`；`PluginEntry` 的定义字段改为 `definition`，依赖字段改为服务名数组 `required` / `optional`，公开类型不含内部激活字段；重算只分 `changed` 与 `shutdown` 两档（不从包根导出）；`schema-config` 把配置表单声明挂到 `PluginMeta.configSchema`；`hostConfig` 为须显式声明的普通宿主服务 |

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

- **资源内核** `kernel/`（`lifecycle.ts`、`disposable-chain.ts`）：父子归属、清理链、可等待关闭与逐项超时、错误隔离与上报。只认自己，不依赖类型词汇、四原语、激活记录或编排。
- **四原语** `primitives/`（events、hooks、services、contributions）：定义插件之间协作方式的四个注册表。只认 kernel 与类型词汇，不认识激活记录、Logger、Config；需要上报的诊断经注入的回调送出（`onHandlerError`、`onStall`）。
- **能力与定义** `context/`（binding、service-watch、capabilities、builtins、resources、definition、config、logger）：服务描述符、能力工厂、胜者观察与绑定交接、资源登记、插件定义、配置与日志。不 import 编排层，也不持有旧 Context 大类。
- **编排层** `orchestration/`（app、activation、activation-host、close-plan、plugin、plugin-activation、plugin-topology、host-services、providers）：由小型激活记录保存身份、资源与依赖边，由 ActivationHost 创建激活并装配能力；App / PluginManager / close-plan 负责启动、调度与关停，另含宿主 SPI 和管理服务描述符。

src 根只留 barrel（`index.ts`）。配置持久化的宿主 SPI（`ConfigProvider`）只依赖 `AalisConfig`，与 `ConfigManager` 同处 `context/config.ts`。`types/` 按种类存放类型词汇：`app.ts`、`plugin.ts` 属编排层词汇，`index.ts` barrel 会把它们一并带出，下层三者都不得引用；其余基础词汇文件只许互相引用。

层间依赖的性质（运行时值依赖与纯类型依赖分开看）：

| 从 | 到 | 性质 |
|---|---|---|
| primitives | kernel | 值：events / hooks 上报诊断用的 `reportQuietly` |
| primitives | 基础词汇 | 纯类型 |
| context | kernel | 值：`Lifecycle`、`reportQuietly` |
| context | primitives、基础词汇 | 纯类型——四原语实例由编排层构造后传给能力工厂与绑定接口 |
| context、orchestration | `@aalis/schema-log` | 仅纯类型：`LogEntry` / `LogLevel`；日志文件编解码由宿主使用，Core 不值导入 |
| orchestration | context、primitives、kernel | 值：App 构造根激活与四个注册表，上报走 kernel 的 `reportQuietly` |
| `types/app.ts`、`types/plugin.ts` | context、primitives、基础词汇 | 纯类型 |

kernel 只引用本层模块；基础词汇文件只相互引用，不引用更高层。

文件内的 import 与包根 index.ts 的导出按同一层序自下而上排列：types → kernel → primitives → context → orchestration → 同层兄弟，组间空行；由 biome 对 `packages/core/src/**` 的 organizeImports 分组配置守。同一模块既导值又导类型时写成一条语句、类型加内联 `type` 修饰符；全是类型的模块用 `export type {}`。

文件前言与分节：带前言的文件用 60 个 `=` 的 `//` 横幅夹住前言（首行「文件名 — 一句话」），无前言的文件不补；文件内分节一律一行 `// ----- 节名 -----`。JSDoc 描述在前、`@internal` 等标签收尾（单行式也展开成多行）；不用警示符号，告诫写成陈述句。

内部激活记录不通过插件能力或公开管理条目暴露；插件拿到的是窄能力对象，第三方 binder 拿到的是 BindingPort。`#` 私有字段与 TypeScript `private` 按内部封装需要使用，均不带 `_` 前缀。公开面与分层分别由 purity / architecture 测试约束。

诊断与错误的写法（文字规矩，无机器守——正则守卫经变异证明会被折行调用与含引号的英文骗过）：错误对象一律作 logger 的附加参数
（`logger.error('xxx 失败:', err)`），不内插进消息——内插只剩 message、丢 stack，logger 写入前会把换行转义成单行。宿主 SPI
（插件加载器、重启策略、配置 provider）的失败一律 `error` 级。kernel 抛出的错误信息用中文、带 `Lifecycle:` 前缀、不带节点 id
（kernel 不认识激活记录；这两条抛错是收养关系写错的编程错误，不是运行时故障，抛给调用方即止）。

不拆 kernel 包：包是发布单位不是模块化单位；维持可拆的依赖方向，出现不依赖 core 的真实使用者时再议。资源内核不从包根导出。单独关闭的级联序是子节点关闭 → 本节点 drain → 撤回对外注册 → 清理链分段排空 → afterCleanup；编排层可提前调用 drain，再按依赖图安排 close，内核不解释依赖。关闭后迟到清理仍执行，用来接住初始化或子节点关闭期间取得的资源；超时只是停止等待，不代表资源已释放；每个 Lifecycle 至多跟踪一次初始化（调用方保证，再次调用会覆盖前一次）。

没有为插件 apply 或 app 生命周期屏障新增超时；`disposeTimeoutMs` 约束清理等待，不是整个 register / stop 的总期限。若流程尚在等待永不落定的 apply 或屏障监听器，仍可能无法进入清理阶段。
