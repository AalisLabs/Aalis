# core 语义契约（1.0 承诺书）

本文是 `@aalis/core` 对插件生态的**行为承诺**。1.0 起，下列不变量在任何 1.x 版本中不变；
未列入承诺的一切（内部实现、算法、数据结构、日志文案）随时可换。守卫：
`test/core/purity.test.ts`（词汇禁令 + 公开面快照）、`test/core/architecture.test.ts`（内部分层）。

## 一、四原语行为不变量

插件在 `definePlugin({ uses })` 里声明描述符，`apply` 拿到按这次激活绑定的接口。没有默认注入。Core 默认登记的八项基础服务（`events` / `hooks` / `contributions` / `lifecycle` / `logger` / `config` / `provide` / `services`）与第三方共用容器、描述符、`bind` 和 required / optional 规则；它们由根激活经 `provide` 以通用 `exclusive` 登记策略登记（只有 `provide` 自身直接登记一次来自举），拒绝同名第二提供者；提供者只向在 `uses` 里声明了该服务的激活交出属于该激活的接口。

**events（`events.on` / `events.emit`）——广播**
- 监听器错误互相隔离：单个 handler 抛错（同步或异步）不影响其余 handler，也不使 `emit` reject。
- `emit` 按注册顺序依次调用，但**顺序不构成语义**：监听方不得依赖自己相对其他监听方的位置。
- 无返回通道、不可变更 payload 语义、不可截停。
- sticky 事件（`app:ready` / `app:started`）：注册晚于 emit 的监听器在下一个微任务收到补发。

**services（`provide` / `ServiceRef` / `services`）——供需**
- 解析顺序恒为 **偏好 > 优先级 > 注册顺序**，所有读口（`current` / `require()` / `all()` / `services.get` / `services.all`）一致。
- 非独占服务允许同名多提供者并存；独占登记与任何已有条目冲突，其存在期间也拒绝第二条登记。胜者变更经 `service:registered` / `service:unregistered` / `service:preference-changed` 事件可观察。
- `current` / `require()` 返回**当时点解析的实例**，不等待服务上线、不 await；不是自动转发所有调用的代理。把引用存起来须自行承担它失效。`require()` 在 required 依赖丢失到调度收敛之间也可能短暂抛错。
- `all()` 每次调用重新枚举全部提供者，包括非胜者。手动缓存的引用不建立关停边、不自动转发，也不保护主动提前卸载的提供者。
- `follow(attach)`：胜者不变则不动；胜者换人时先跑上次返回的清理，等其 Promise 落定之后才用新实例再挂；下线与关闭时清理。`attach` 必须同步——需要清理就返回函数，不需要就不返回；thenable 会被接住并 warn，不会当 cleanup。拒绝被隔离并报告，但不证明旧资源已释放。
- `services.get` / `services.all` 是动态查询：不增加声明、不参与激活闸、不自动跟随、不建立依赖边，关停期可能拿空。需要声明等待与跟随就把描述符写进 `uses`。动态查到的内置服务是提供者函数，只接受在 `uses` 里声明了该服务的激活身份，以其他身份调用即抛错。
- `services.inspect` / `ServiceContainer.inspect` 只投影登记元数据，不返回实例。`services.get` / `services.all` 与 `ServiceContainer.get` / `getAll` 返回登记进容器的对象本身。
- `provide(descriptor, impl, options?)` 是唯一发布入口。`options.onBehalfOf` 的条目逻辑身份取被代者，清理仍归本激活；代登记不计入代理人的 `provides`。
- 资源口的 `identity` 是这次激活的不透明资源身份，也是凭据：交给谁，谁就能以这次激活的名义调用认它的提供者。提供者据它把登记归到这次激活。
- 同版本 Core 副本的描述符、optional 包装与 required 不可用错误可互通；不承诺不同版本的协议互通或任意 Core 类实例跨副本互换。

**hooks（`hooks.middleware` / `hooks.run`）——流程干预**
- 同一钩子键内按注册顺序执行洋葱模型；不调 `next()` 即合法截停（`hooks.run` 返回 `false`）。
- handler 抛错中断整链并上溯给 `hooks.run` 调用方（拦截者失败 = 流程该停）。
- 任何插件可驱动自己定义的钩子链；注册与执行权对称公开。

**contributions（`contributions.contribute` / `contributions.collect`）——汇集**
- 全局键 = `${lifecycle.id}/${局部id}`，由门面自动冠前缀：**spec.id 侧**构造上无法顶替他人条目
  （局部 id 禁空、禁含 `/`，注册期抛错）。该保证以这次激活的逻辑 id 为命名空间——
  调度器保证 `instanceId` 不重复；仍出现重复 id 的两方共用同一命名空间。
- 已关闭的激活上 `contribute` 被拒（warn + no-op），不影响同 id 的活实例。
- 同一激活内同局部 id 重复注册 = 替换（幂等）。
- `collect` 返回快照，排序是全局键的纯函数——同集合任意机器、任意重启，枚举顺序逐字节相同。
- 内核**从不执行**贡献 spec 中的任何插件代码；执行策略（并行/隔离/超时）全归收集方。

## 二、生命周期不变量

- 经这次激活的能力门面登记的一切副作用（事件监听、服务、钩子、贡献、`onDrain` / `onDispose`、`follow` / `track` / `registrar`），
  在该激活关闭后**必然消失**——包括寄存在枢纽服务里、按激活身份清扫的条目。
- 经门面登记的四原语条目（事件监听、服务、钩子、贡献）按归属记在各自的注册表里，不逐条进清理链：退订即原语撤回这一条（同步、幂等，只撤自己那一条：条目已被同键替换时旧退订无动作）；关闭时在排空清理链之前按归属同栈整体切断。
- 清理链分撤回段（`follow` 返回的 cleanup、registrar 撤回、`track`）与清理段（`onDispose`）：撤回段整体先于清理段，段内相对注册**逆序**执行；单个清理器抛错不影响其余。
- `onDrain` 在撤回之前执行：此刻本激活的监听、登记与声明的依赖都还在，用于停接新活、把在手的数据交给下层并等待确认。`onDispose` 在对外登记已撤回之后执行；依赖可能已不可用。异步清理在 `disposeAsync` 路径被等待（带 `disposeTimeoutMs` 护栏）；超时只是停止等待，不代表资源已释放。
- 激活 = 提供者先于消费者（required 依赖拓扑）。关闭按每个激活的 drain 与 close 两阶段编排。普通依赖：消费者整个 close 完，提供者才 drain。根激活使用插件的服务：根 drain 先于该插件 close。插件使用根激活登记的服务：不往排序图加边，由归属保证插件 close 先于根 close。环内 optional 边构成的强连通分量（≥2 个激活）先让成员全部 drain，再任一 close——drain 期间对方仍活着，双方 `onDrain` 都能 `require()`；无法解除的 required 环告警后强行放行。归属约束与环外约束一条不松。依赖交接放 `onDrain`；`onDispose` 阶段依赖可能已不可用。`App.stop()` 把全部 active 插件与根激活放进同一张计划。单独 `unload` / `disable` / `bounce` 走同一套分阶段关闭：正在用该插件所提供服务的 required 下游（传递闭包）并入同一批，先收尾、先关；判据是下游此刻解析到的胜者属于要走的激活，空档里不切到后备。下线通知在提供者清理之前发出并等跟随者交接落定，提供者之后才清理。动态查询与手动缓存的裸引用不产生边。
- `app:stopping` 是屏障知会，不是清理通道；只在 `App.stop()` 全局停机时发一次，bounce / unload / disable 不发。清理走 `onDrain` / `onDispose`。`App.stop()` 顺序：`beginShutdown()`（冻结新增绑定并进入停机态）→ `idle()`（排干在飞重算）→ 发出 `app:stopping` → 关停计划。监听器全部返回后才执行停机计划。窗口内 `unload` / `disable` 汇入该计划后立即返回 true（不等拆卸完成）；`register` / `bounce` 返回 false（与定义或实例 id 校验失败同属政策挡下的 false 口径）。已冻激活上 `provide` 记 warn 后忽略、不抛。停机完成后：对新定义 `register` 返回 false 且不落账；对已 disposed 实例的 `enable` / `updateConfig` / `bounce` 返回 false；`idle()` 落定。
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
| stable | `definePlugin` / `defineService` / `optional` / `serviceRef`、`ServiceRef` 的 `current` / `require()` / `all()` / `follow()`、基础服务描述符（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）、宿主描述符（`appService` / `pluginsService` / `hostConfig`）、`App.plugin` / `App.bind` / `App.config` / `App.plugins`、`createApp` / `AppOptions` providers、`ConfigManager` 快照读写、`PluginManagerService` 接口的全部成员（接口即清单，不在此另抄一份） | 1.x 内不破坏 |
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
| 0.17.0 | **删除**：包根激活记录类与 `App` 上的公开激活入口、插件模块形状（具名 `name` / `inject` / `provides` 与函数 default）、全局服务类型表与 `ServiceOf`、级联 bounce 开关与 `evictDownstreamConsumers`、契约包 `useXxxService` helper、`ServiceContainer.getEntries` 与包根 `ServiceEntry`、子模块机制（`useModule` / `ModuleHandle`，含同步 `dispose()`）。**改形**：`apply` 入参改为 `uses` 装配出的绑定接口；四原语与配置 / 日志 / 生命周期改为显式能力描述符；按名取服务改为 `ServiceRef` 的 `current` / `require()` / `all()`，有状态跟随改为 `follow`；`PluginEntry` 的定义字段改为 `definition`，依赖字段改为服务名数组 `required` / `optional`，公开类型不含内部激活字段；重算只分 `changed` 与 `shutdown` 两档（不从包根导出）；`schema-config` 把配置表单声明挂到 `PluginMeta.configSchema`；`hostConfig` 为须显式声明的普通宿主服务 |

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

core 源码按职责分目录，依赖方向由 `test/core/architecture.test.ts` 守卫；目录边界与公开包边界无关：

- **资源内核** `kernel/`（`disposable-chain.ts`）：清理链、分段逆序排空与逐项超时、错误隔离与上报。只引用本层，不认识服务、配置或激活记录。
- **协作原语** `primitives/`（events、hooks、services、contributions）：四个注册表及登记元数据。依赖 kernel 与基础类型，不认识激活记录、Logger 或 Config；诊断经回调送出。
- **基础设施** `infrastructure/`（resources、config、config-values、logger）：一次激活的资源账与关闭过程（收尾段、初始化等待、完成信号、在飞撤回）、配置与安全值处理、日志通道。依赖 kernel、primitives 与基础类型，不负责服务装配和插件调度。
- **服务装配** `composition/`：`descriptors` 保存服务描述符、类型推导与依赖提取；`binding` 保存资源口、不可用错误与 `follow` / `registrar`；`core-services` 定义内置八项的描述符与提供者；其余包含 runtime 接线、service-watch、provide-validation 与 plugin-definition。依赖基础设施、原语和 kernel，不 import 编排层。
- **插件编排** `orchestration/`（app、activation、activation-host、close-plan、plugin、plugin-activation、plugin-topology、host-services、providers）：创建激活、经根激活登记内置服务、启动、调度、关停，以及宿主 SPI 和管理服务描述符。

src 根只留 `index.ts`。配置持久化 SPI `ConfigProvider` 只依赖 `AalisConfig`，与 `ConfigManager` 同处 `infrastructure/config.ts`。`types/` 按种类存放词汇；`types/app.ts`、`types/plugin.ts` 属编排契约，类型 barrel 会带出它们，下层不得经 barrel 反向引用。基础词汇文件只相互引用。

| 从 | 到 | 性质 |
|---|---|---|
| primitives | kernel、基础词汇 | 诊断函数的值依赖与基础类型 |
| infrastructure | kernel、基础词汇 | 资源内核的值依赖与基础类型 |
| composition | infrastructure、primitives、kernel、基础词汇 | 绑定与内置服务的实现和类型 |
| orchestration | composition、infrastructure、primitives、kernel | 应用装配与调度 |
| `types/app.ts`、`types/plugin.ts` | composition、infrastructure、primitives、基础词汇 | 纯类型 |

文件内 import 与包根导出按分层组织，Biome 的 organizeImports 分组与目录保持一致。同一模块既导值又导类型时使用内联 `type`；全部为类型时使用 `export type {}`。

文件前言与分节：带前言的文件用 60 个 `=` 的 `//` 横幅夹住前言（首行「文件名 — 一句话」），无前言的文件不补；文件内分节一律一行 `// ----- 节名 -----`。JSDoc 描述在前、`@internal` 等标签收尾（单行式也展开成多行）；不用警示符号，告诫写成陈述句。

插件能力与公开管理条目类型不包含内部激活记录；宿主三服务在容器里只放契约列出的方法，经 `pluginsService` 拿到的 `getPlugin()` 是快照，宿主侧 `app.plugins.getPlugin()` 返回现场条目、须只读。插件拿到的是窄能力对象，第三方 binder 拿到的是 BindingPort。`#` 私有字段与 TypeScript `private` 按内部封装需要使用，均不带 `_` 前缀。公开面与分层分别由 purity / architecture 测试约束。

诊断与错误的写法（文字规矩，无机器守——正则守卫经变异证明会被折行调用与含引号的英文骗过）：错误对象一律作 logger 的附加参数
（`logger.error('xxx 失败:', err)`），不内插进消息——内插只剩 message、丢 stack；日志行编码与转义由宿主负责。宿主 SPI
（插件加载器、重启策略、配置 provider）的失败一律 `error` 级。

不拆 kernel 包：包是发布单位不是模块化单位；维持可拆的依赖方向，出现不依赖 core 的真实使用者时再议。资源内核不从包根导出。单独关闭的顺序是 drain → 撤回对外注册 → 清理链分段排空 → afterCleanup；编排层可提前调用 drain，再按依赖图安排 close，内核不解释依赖。关闭后迟到清理仍执行，用来接住初始化期间取得的资源；超时只是停止等待，不代表资源已释放；每个 Resources 至多跟踪一次初始化（调用方保证，再次调用会覆盖前一次）。

没有为插件 apply 或 app 生命周期屏障新增超时；`disposeTimeoutMs` 约束清理等待，不是整个 register / stop 的总期限。若流程尚在等待永不落定的 apply 或屏障监听器，仍可能无法进入清理阶段。
