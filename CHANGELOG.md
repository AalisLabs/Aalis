# Changelog

本文件只记录**破坏性变更与迁移路径**。逐包的完整改动见 git 历史。

版本号语义：core 在 1.0 之前，次版本（`0.x.0`）可含破坏性变更并在此列出迁移路径；
补丁版本（`0.x.y`）只做修复与加法。1.0 之后按标准 semver，稳定性条款见
[`docs/design/core-contract.md`](docs/design/core-contract.md)。

---

## 未发布 · core 0.20（全面简化与服务调用形状统一）

core 0.20 收拢内核：服务调用统一成选择层与业务层两层，三个服务事件合成一个，关闭链去掉多余的内部概念并保证同一实例 id 的旧实例停下之前不起新实例，宿主与管理面每件事只留一种写法。同批迁移全部第一方契约包、插件与宿主，新增读日志的宿主服务 `@aalis/api-host-logs` 与按插件的服务偏好。core 定为 0.20.0；其余各包的档位与版本号在发布时按源码与 npm 实况核定，本节不写。

> **插件与契约包必须与 core 同批升级。** 已发布的插件与契约包的 `@aalis/core` peer 区间（`>=0.2.0`、`>=0.17.0`、`>=0.18.0`、`>=0.19.0`，上限都是 `<1.0.0`）都接受 0.20，包管理器不会拦下只升 core 的安装。配 core 0.20 时：
>
> - 旧版 api-agent 0.9.1、api-commands 0.7.0、api-doctor 0.7.0、api-tools 0.10.0、api-webui 0.11.1 以值导入已删的 `serviceRef`，加载时就失败，依赖它们的插件随之加载失败。旧版 api-hooks 的 `run` 调已删的 `port.require()`，得到被拒的 Promise（TypeError）；旧版 api-contributions 的 `collect` 同样调它，同步抛 TypeError。
> - 没有自定义绑定的旧版契约包照常加载，辅助函数会坏：旧版 api-llm 的 `resolveLLMModel` / `listLLMModels`、api-storage 的网关与 `getStorageEntries`、api-platform 的辅助函数、api-trigger 的 `createBotNames` 调已删的 `.all()`，抛 TypeError；旧版 api-process 的网关与 api-trigger 的 `isActiveTrigger`、`archiveSwallowed` 读已删的 `.current`，得到 `undefined`：网关每次调用都报「未找到 process 服务」，`isActiveTrigger` 恒为 false，`archiveSwallowed` 不归档。
> - 在 `apply` 里直接调内置项（`events.on`、`logger.info`、`lifecycle.onDispose`、`provide(...)`）或调 `.require()`、`.all()` 的插件抛 TypeError，进 `error`。`parseConfig(schema, caps.config, caps.logger)` 同样进 `error`：它把选择层当配置读，对选择层上 schema 外的键告警时调到不存在的 `warn`，抛 TypeError。
> - 以下几种不报错，静默失效：`caps.x.current?.m()` 什么都不做；`if (caps.x.current)` 的分支不再进入；直接读 `caps.lifecycle.signal`、`caps.lifecycle.id`、`caps.config.<键>` 得到 `undefined`，带这个 `signal` 的 `fetch` 永不中止；不传 logger 的 `parseConfig(schema, caps.config)` 读到的是默认配置，schema 里有没有默认值的必填字段时抛「缺少配置项」、插件进 `error`；已改成 `events.use.on` 却仍监听 `service:registered` / `service:unregistered` / `service:preference-changed` 或 `app:starting` 的纯 JS 代码不再触发（TypeScript 下事件表是封闭的，编译报错；没改写的旧插件走不到这一步，`events.on` 先抛 TypeError）。
> - 旧版契约包发布的类型声明引用已删的 `ServiceRef`，只改了注释的契约包也要重发。
>
> 发布时受影响的第一方包同批发出：带 core peer 的包下限抬到 `>=0.20.0 <1.0.0`，含新包 api-host-logs（它用到资源口的 `port.provider`，现写的 `>=0.18.0` 不够；脚手架 create-aalis-plugin 生成的项目同样要抬，它生成的代码已经是 0.20 的写法）；依赖本批改了形状的契约包（下文「公开接口有不兼容改动」一组里的契约包，以及旧版配 core 0.20 就出错的 api-hooks、api-contributions）的包，对这些契约的 `dependencies` 下限抬到本批的新版本，只更新插件时不会留下旧版契约包。第三方插件按 [插件作者指南](docs/plugin-author-guide.md) 的「从 0.19 迁移」一节改写后，把 core peer 下限抬到 `>=0.20.0`，对上述契约包的下限同样抬到本批的新版本。走插件市场的，全部插件同一批勾选更新。

待发布的包。下面的分组只按 core 0.20 线相对 Harness 节（`d2d96585b`）的改动分，共 116 个包；Harness 节的改动与它列的新包见那一节。两节合并发布，两节的说法不一致的（如 core peer 的下限、Harness 节写的不发版），以本节为准。分组里有 Harness 节的新包（如 api-approval、api-publish、api-remote-agent、plugin-paper），它们首次发布，分组与下文对它们写的「删」「改为」只相对 Harness 节的未发布版本，npm 上没有旧版。

合并之后，相对已发布的版本（tag `core@0.19.1`）有改动的包共 120 个：118 个发布到 npm，其中 18 个首次发布（本节的 api-host-logs 与 Harness 节「新包」一条的 17 个）；plugin-trigger-laya 与 plugin-webui-client-example 是 `private` 包，不发布。另有 Harness 节删除的 api-session-confirm、plugin-session-confirm，执行 npm deprecate。没有改动的 schema-log 与 6 个 util 包停在已发布版本。各包的版本号与档位在发布时按源码与 npm 实况核定。

- 公开接口有不兼容改动：core；api-agent、api-approval、api-commands、api-doctor、api-llm、api-platform、api-process、api-publish、api-remote-agent、api-session-manager、api-storage、api-tools、api-trigger、api-webui；plugin-user-relation（包根导出的类改了构造参数）。
- 行为变化或新增：runtime、create-aalis、create-aalis-plugin、api-host-config、plugin-adapter-onebot、plugin-agent、plugin-cli、plugin-commands、plugin-doctor、plugin-file-reader、plugin-media、plugin-memory-summary、plugin-memory-vector、plugin-package-manager、plugin-paper、plugin-session-manager、plugin-storage-local、plugin-tool-code-runner、plugin-tool-system、plugin-trigger-laya、plugin-user-profile、plugin-webui-client、plugin-webui-server、plugin-workflow、plugin-works-site。
- 只迁移到新的调用形状，运行时需要 core 0.20：api-hooks、api-contributions 与其余 49 个插件（plugin-asr-openai、plugin-asr-whisper-cpp、plugin-authority、plugin-checkpoint、plugin-code-sandbox-os、plugin-contributions、plugin-cron-engine、plugin-draw、plugin-embedding-ollama、plugin-embedding-openai、plugin-flow-control、plugin-gateway、plugin-hooks、plugin-image-sender、plugin-llm-deepseek、plugin-llm-ollama、plugin-llm-openai、plugin-maimai、plugin-mcp-client、plugin-mcp-server、plugin-memory-history、plugin-memory-inmemory、plugin-memory-mongodb、plugin-memory-sqlite、plugin-message-archive、plugin-office、plugin-okx-trading、plugin-persona、plugin-process-local、plugin-prompt-budget、plugin-publish-review、plugin-reach、plugin-remote-agent-cursor、plugin-scheduler、plugin-session-server、plugin-skills、plugin-subtask、plugin-todo-list、plugin-tool-browser、plugin-tool-math、plugin-tool-onebot、plugin-tool-search、plugin-tool-session、plugin-tools、plugin-trigger-policy、plugin-usage-stats、plugin-vectorstore-flat、plugin-vectorstore-lancedb、plugin-websearch-serper）。
- 只改注释或 README（类型声明里的描述符类型随 core 变化，同样重发）：api-asr、api-authority、api-checkpoint、api-code-sandbox、api-cron-engine、api-embedding、api-flow-control、api-gateway、api-host-paths、api-media、api-memory、api-message-archive、api-package-manager、api-persona、api-plugin-source、api-reach、api-session-history、api-session-protocol、api-todo-list、api-user-relation、api-vectorstore、api-workflow。
- 只改 README：schema-config。它的类型声明不引用 core 的服务类型，本节不要求重发；它在 Harness 节另有改动。
- 新包：api-host-logs 0.1.0。

### 不兼容变更与迁移

插件作者要改的写法逐条对照见 [插件作者指南](docs/plugin-author-guide.md) 的「从 0.19 迁移」，本节不重复那张表。多数旧写法编译不过；编译得过、行为却变了的有：两参的 `parseConfig(schema, caps.config)`（第二参类型是 `unknown`）、拿句柄比对象身份或当 WeakMap 的键、缓存 `getPlugin()` 的返回值再读状态、按 `service:changed` 的次数记账，以及不经编译器的纯 JS 代码。

#### 服务调用的两层形状（@aalis/core；全部契约包、插件与宿主）

- 删 `ServiceRef` 类型与 `serviceRef` 函数，选择层上没有 `current`、`require()`、`all()`。`uses` 里每一项装配成选择层 `ServiceSelection<B>`：`list()`、`use`、`of(id)`、`present`、`follow(attach)`，由 core 定义、每个服务一样、只读。业务层 `B` 是契约的接口（不给 `bind` 时就是提供者接口），经活句柄调用。规则见 [插件定义与能力](docs/core/context.md)。
- 内置六项同样两层：`logger.use.info`、`events.use.on`、`lifecycle.use.onDispose` / `id` / `signal`、`provide.use(desc, impl)`、`config.use`、`services.use.get`。内置项的业务句柄在装配时取好本次激活的门面，拆卸之后照常可用；`of(非根 id)` 当场抛错。
- 业务句柄是活的转发句柄：每次访问成员重新解析到当前那一家，已经开始的调用在原来那一家上完成。选不到提供者时，访问转发到提供者的成员同步抛 `ServiceUnavailableError`（不导出，按 `err.name` 认），与成员本身同步还是异步无关；契约 `bind` 定义的成员按契约行事：经 `registrar` 的登记方法缺席时照收、上线后挂上，写成 async 函数的（如 `hooks.use.run`）得到被拒的 Promise。可选依赖先看 `present`。句柄是代理：`then`、symbol 键、`toJSON` 不转发，展开、`Object.keys`、`JSON.stringify` 看不到提供者的成员；不给 `bind` 时 `typeof` 句柄为 `'function'`、`Object.keys` 列不出成员；给了 `bind` 的句柄是 `bind` 的返回值，按 `Object.create(port.provider)` 加成员的写法，`typeof` 为 `'object'`，`Object.keys` 只列出 `bind` 自己加的可枚举成员。每个激活、每个目标各有自己的句柄，拿句柄比对象身份或当 WeakMap 的键不再成立。边界的完整清单见 [句柄的边界](docs/core/context.md)。
- 三种句柄的目标：`use` 是本插件此刻选中的那一家；`of(id)` 按 id，同一个 id 换了新实例照常打到；`list()` 条目的 `use` 与 `follow` 交给 `attach` 的句柄钉在那一条登记上，那一条撤回后访问抛错（`follow` 的到这次挂载的清理落定为止）。一段操作要固定同一家，取 `list().find(p => p.selected)?.use`；比身份比条目的 `id`。
- 宿主：`app.bind(uses)` 返回的也是选择层，写 `app.bind({ events }).events.use.on(...)`、`app.bind({ provide }).provide.use(...)`。`BoundOf<U>` 映射到 `ServiceSelection<B>`。
- 契约作者：
  - `defineService<P>(name)` 返回 `ServiceDescriptor<P, P>`（此前是 `ServiceDescriptor<P, ServiceRef<P>>`），`ServiceDescriptor<P, B>` 的 `B` 缺省为 `P`。
  - `bind` 改为每个目标调一次（`use`、每个 `of(id)`、每个 `list()` 条目、每次 `follow` 挂载），不再每次激活调一次。钉住的目标退役时，它的 `bind` 经资源口登记的跟随、登记与 `track` 随之撤回。
  - `BindingPort` 的成员只剩 `id`、`identity`、`logger`、`present`、`provider`、`follow`、`track`、`registrar`：删 `name`、`current()`、`require()`、`all()`，新增 `provider`（目标那一家的活句柄）与 `present`。`port.follow` 的 `attach` 与 `registrar` 的 `register` 收到的是提供者实例。
  - 加登记方法或包装业务方法的绑定写 `Object.assign(Object.create(port.provider), { ... })`；`Bound*` 接口 `extends` 提供者接口。写新契约照 [契约约定](docs/design/contract-conventions.md)。
- 包根新增类型导出 `ServiceSelection`、`ProviderEntry`、`SelectionBasis`、`PreferenceScope`。

#### 服务事件与偏好（@aalis/core、@aalis/api-host-config、@aalis/runtime、@aalis/plugin-webui-server）

- 删 `service:registered`、`service:unregistered`、`service:preference-changed`，合成 `service:changed(name)`：这个服务的提供者或选择可能变了，请重读。可能变化时就发，不保证恰好一次，也不说明变了什么；`provide`、退订、激活拆卸、激活转入后台与完成后上线、全局与本插件偏好的切换都发，转入后台的激活期间登记的服务同样发（此前不发，重读照样看不到它）。监听旧事件名的代码不报错、不再触发。
- 删屏障事件 `app:starting`。
- `services.prefer` / `unprefer` 返回 `void`（此前是 `boolean`），一律记下并发 `service:changed`。独占服务存续期间也接受偏好（此前拒绝），指向别家的偏好在那期间不生效；内置服务上的偏好按排名落回根。
- 偏好分两级：`services.prefer(name, id, { for })` 给 `for`（插件实例 id）是那个插件的本插件偏好，不给是全局偏好；`unprefer`、`preferred`、`inspect` 同样收 `{ for }`。挑选规则是本插件偏好 > 全局偏好 > 优先级 > 注册顺序；`services.get` / `all` 与不给 `for` 的 `inspect` 按全局口径。`ServiceInfo` 新增必有的 `selected` 与选中那一条才有的 `basis`（`'plugin'` / `'global'` / `'rank'`）。
- 删 `ProvideOptions.onBehalfOf`，并入 `entryId`：托管自己不运行代码的包时，`entryId` 取被托管包的 id。core 不检查 `entryId` 的格式，也不再对它的前缀告警。纯 JS 调用方仍传 `onBehalfOf` 时被静默忽略，条目 id 回落为本激活 id。
- api-host-config：`HostConfig` 的 `getServicePreferences`、`setServicePreference`、`removeServicePreference` 加可选的 `scope`（同 `{ for }`），`AalisConfig` 加 `pluginServicePreferences`（插件实例 id → 服务名 → 偏好的 contextId）。自行实现 `HostConfig` 的宿主要认这个参数，否则按插件设的偏好会写成全局偏好。

**迁移**：

- 监听三个旧服务事件的改听 `service:changed`，在回调里重读 `list()`、`present` 或 `services.use.get` / `all`，不要按事件次数记账。
- 监听 `app:starting` 的改挂 `app:ready`。
- 依赖 `prefer` / `unprefer` 返回值的调用方删掉这层判断。偏好只由用户经管理面写（WebUI、配置文件），普通插件不调它们；插件要用某一家，在文档里写明，由用户设本插件偏好。
- 传 `onBehalfOf` 的改传 `entryId`。

#### 插件状态与管理动作（@aalis/core、@aalis/runtime、@aalis/plugin-webui-server、@aalis/plugin-package-manager）

- 旧实例停下之前不起新实例：激活关完仍有工作没落定（`apply` 或清理超过 `disposeTimeoutMs` 被放弃等待，或关闭后就地执行的清理还在跑）时，条目照写目标态，`PluginStatusEntry.lingering` 为 true，记一条 warn；这些工作落定之前同一 id 不起新实例（`bounce`、`updateConfig`、`enable`、依赖恢复与卸载后同 id 重新登记都一样），落定后按目标态继续，管理动作与 `idle()` 不等它。此前被放弃的初始化转 `error`（「未在宽限内停止」）、依赖恢复后不自动重试，清理超时只记 warn，新旧实例可能并存。永不落定的工作会让这个 id 一直等下去，只有重启进程能解决。
- 删 `PluginStatusEntry.requiredServices` / `optionalServices` 与公开的 `PluginEntry.required` / `optional`。依赖信息只在 `getStatus()` 条目的 `uses` 里（每项 `{ key, service, kind }`）。webui-server 的 `/api/plugins` 照旧在服务端派生 `requiredServices` / `optionalServices`，HTTP 格式不变；市场依赖图与 package-manager 改从 `uses` 派生。
- `bounce(instanceId)` 不再收 `{ config }`，只按现有配置重启，换配置走 `updateConfig`。纯 JS 调用方仍传 `config` 时被忽略、按旧配置重启。禁用态的 `bounce` 记 warn、返回 false；禁用态的 `updateConfig` 只换配置、保持禁用、返回 true。
- 宿主侧 `app.plugins.getPlugin()` 交调用时刻的浅快照（此前是运行中的内部记录）：之后的状态变化不改它，缓存返回对象再读 `state` 会读到旧值；写它进不了注册表。`config` 与 `definition` 仍是运行中的同一对象，只读。插件经 `plugins` 服务拿到的此前已是快照。
- 删 `AppOptions.now`。要固定日志时间戳，注入 `new DefaultLogger(name, level, hub, now)` 作 `AppOptions.logger`。
- 注入的 logger 由 App 包一层再用：日志方法抛错或返回被拒的 Promise、`child` 派生失败都不传进 core 与插件；`app.logger` 不再是传入的那个对象。
- App 只有一轮生命周期：`start()` 单飞（重入返回同一 Promise）；停机开始后再调记 warn 后直接返回；启动途中停机开始则不再发后续事件（不发 `app:started`）。`restart()` 每个 App 只受理一次：已受理过的再调记 debug 后返回，未受理过而停机已开始时抛错。要重新跑一轮就新建 App。
- 内置服务不再核对 `uses` 声明：经 `services.use.get(events)` 动态查到的是提供者函数，以调用方自己的身份调用得到它自己的门面；认不出的身份抛「内置服务 "x" 收到的身份不属于任何在册的激活」。资源口的 `identity` 是调用方身份，不是凭据。

**迁移**：

- 读 `requiredServices` / `optionalServices` 或 `PluginEntry.required` / `optional` 的，改为 `status.uses.filter(u => u.kind === 'required').map(u => u.service)`（optional 同理）。
- `bounce(id, { config })` 改为 `updateConfig(id, config)`。
- 缓存 `getPlugin()` 返回值再读状态的，改为每次现取或读 `getStatus()`。
- 传 `AppOptions.now` 的改为把时钟交给注入的 `DefaultLogger`。
- 靠「未在宽限内停止」的 `error` 发现卡住清理的，改看 `getStatus()` 的 `lingering` 与 doctor 的 `plugins.lingering`；清理里不要放永不落定的工作。
- 停机后再 `start()` 一个 App 的嵌入宿主改为新建 App。

#### 契约包

- **api-storage**：删函数 `createStorageGateway`、`getStorageEntries`、`aggregateStorageRoots`、`getStorageRootConflicts`、`resolveStorageEntryForRoot`、`resolveStorageByPath`，常量 `StorageCapabilities`，类型 `StorageProviderEntry`、`AggregatedStorageRoot`、`StorageRootConflict`、`StorageCapabilityRegistry`、`StorageCapability`；直接调 `caps.storage.use`。业务层不再跨提供者聚合存储根：此前网关枚举全部 storage 条目，按 URI 的根名路由到登记那个根的条目，`listRoots` 合并各条目的根；现在调用只转发给选中的那一家，由它按根名路由。往只读根写的报错随之由网关的「存储根 X 不支持 write」变为提供者的「存储根 X 不允许该操作 (writable)」，按文案匹配的要改。业务层 `BoundStorage` 恒有 `resolveLocalPath`、`readFileRange`、`watch`，选中的那一家不支持时调用同步抛「存储提供者不支持 x」。新增 `own`（类型 `OwnStorage`）：插件私有目录 `pluginData:/<目录名>/` 的视图，目录名在 `@aalis` 与不带作用域的包是包名去掉开头的 `plugin-`，别的作用域写成 `<作用域>+<名>`（`@acme/plugin-x` 是 `acme+x`）；只收相对路径，越出目录、宿主绝对路径、存储地址都抛错，`own.uri(path)` 给完整地址。插件名取不出目录名时绑定抛错，声明了 `storage` 的插件激活失败，不论用不用 `own`。第一方插件原有的数据路径不变。第三方存储提供者：按旧约定只登记几个根、与 storage-local 并存的，升级后只有选中的那一家生效，不报错；一个提供者要提供全部根，要换掉整套存储就做完整的提供者，由用户经服务偏好选中（见 [storage 服务](docs/services/storage.md)）。
- **api-process**：删 `createProcessGateway`，改用 `caps.process.use`（缺席时抛 `ServiceUnavailableError`）。
- **api-platform**：删 `PlatformAdapterEntry`、`getPlatformAdapterEntries`。辅助函数改收 `Pick<ServiceSelection<PlatformAdapter>, 'list'>`，返回的条目是 `ProviderEntry`（`use` / `id`，原 `instance` / `contextId`）。
- **api-remote-agent**（首次发布，以下相对 Harness 节的未发布版本）：删 `RemoteAgentEntry`；`resolveRemoteAgent` 收选择层的 `list`，返回 `ProviderEntry`。
- **api-llm**：删 `LLMModelEntry`（api-webui 的同名 REST 类型保留）。`resolveLLMModel` / `listLLMModels` 收选择层的 `list`，返回 `ProviderEntry<LLMModel>`；不给模型引用时先取调用方插件选中的那一条。按模型取写 `caps.llm.of('<provider>/<model>')`。绑定不再按实例缓存盖过章的对象，只在 `chat` / `chatStream` 的请求上盖调用方。
- **api-trigger**：`isActiveTrigger(phase, trigger, self)` 的第二参改为 `Pick<ServiceSelection<TriggerService>, 'list'>`，第三参由实例改为触发插件自己的条目 id。`createBotNames`、`archiveSwallowed` 改收选择层。生效者表改记条目 id，进程里有两个不同版本的 api-trigger 时彼此认不出。
- **带登记方法的契约**（api-agent、api-approval、api-commands、api-doctor、api-publish、api-session-manager、api-tools、api-webui）：`Bound*` 改为 `extends` 提供者接口，登记方法在业务层上（`caps.tools.use.register`、`caps.commands.use.command`、`caps.webui.use.definePage`、`caps.agent.use.registerPreprocessor` 等）。
- **api-commands**：指令登记改走资源口的 `registrar`。同一激活再登记同名指令是替换（只留一层），此前叠层；提供者在场时它拒收的登记（如指令名不合法）原样抛给调用方，此前只记 warn；本激活关闭时登记与原语同一拍撤回，不再等下游交接。缺席时登记照收，上线时重放失败只记 warn，重放到一半压上的那一层随之撤掉。
- **api-doctor**：`UnmetRoot` 新增 `{ kind: 'lingering', instance }`（「等待 X 的旧实例停下」），`PluginSnapshot` 带 `lingering`。按 `kind` 穷举的消费方补上这一支。
- **api-webui**：`PluginListItem` 新增必有的 `servicePreferences`（本插件偏好）与 `serviceSelections`（声明的服务此刻各落到哪一家、依据是什么），以及 `lingering`；REST 契约新增 `POST` / `DELETE /api/plugins/:instanceId/services/:name/prefer`。

#### 插件

- **plugin-storage-local**：只登记一个 `storage` 提供者（label「本地存储」，条目 id 即实例 id），全部根就绪后才登记，根在它内部路由。此前按根各登记一条（`${实例 id}/${根名}`），这些条目 id 与按根设的 storage 偏好随之失效：偏好不报错，按排名落回这唯一的一家，plugin-doctor 的 `services.preferences` 检查会报出，升级后从配置文件的 `servicePreferences` 里删掉。未知根同步抛「未知存储根: x（已注册根: …）」；跨根移动的报错改为「不能跨根移动」。
- **plugin-file-reader**：删去 agent 不支持预处理器时退到 `agent:input:before` 中间件的回退，不再声明 `hooks`。agent 提供者不支持预处理器时，文件附件不被处理，插件也不记日志。
- **plugin-user-relation**：包根导出的 `RelationStore` 构造参数由 `() => MemoryService` 改为 `MemoryService`，传业务句柄 `caps.memory.use`；`RelationService` 的构造参数 `embedding`、`consolidate` 选项里的 `llm.models` 与 `platform`、`findEventDuplicates` 选项里的 `llm.models` 由 `ServiceRef` 改为选择层 `ServiceSelection`。

### 行为变化

- **core**：关闭一律异步，清理回调（`onDrain`、撤回、`onDispose`）不再在发起关闭的调用方的栈上执行（abort 监听器除外）；未 await 的管理动作返回时，目标可能尚未下线。
- **core**：关停依赖边对声明的服务（required 与 optional）在编排那一刻的全部对外提供者建，此前只对选中的那一家。整机停机时，经 `of(id)` 或 `list()` 条目用到的非选中者也等消费者关完才收尾。
- **core**：纯 required 依赖环里的成员先全部收尾再关，并记 warn（此前强制放行其中一边）。提供者因 required 依赖丢失退场时，随它一起失去全部提供者的 required 下游按传递闭包并入同一批。后一份关闭计划要等前一份计划里还没关完、依赖本计划成员所提供服务的消费者，加入在飞关闭不另设时限。
- **core**：偏好切换触发一次重算；外部 `prefer` 之后 `follow` 的重挂晚一个微任务。
- **core**：管理动作（`bounce`、`updateConfig`、`disable`、`unload`）的退场批另并入这样的 required 依赖方：去掉本批与别的计划正关着的提供者之后，它的服务无人提供（与依赖丢失同一判据）。偏好刚切到别的计划正关着的提供者时再关剩下那家，依赖方随这批先于提供者收尾，此前它不进任何一份计划。钉住的句柄（`list()` 条目、`follow` 的挂载句柄）失效时，`ServiceUnavailableError` 的消息改写成「钉住的那条登记已失效」。
- **core**：sticky 事件（`app:ready` / `app:started`）的补发在 App 存续期间一直有效，重启与停机都不清空。
- **core**：`provides` 按归属核对：本次激活以任何逻辑身份登记的条目都计入它；重复 `provide` 的劝告（devMode）只在同一激活、同一服务、同一 contextId 时出现。
- **core**：同一服务名以不同的描述符对象登记时照常登记，记一条 warn 点名两边（不看 devMode）。第三方契约的服务名带包名前缀，见 [契约约定](docs/design/contract-conventions.md)。
- **core**：插件 `name` 与实例 id 删去 `#` 禁令与 trim 后的危险键复查（只放宽）：规则只剩 trim 后非空、不是 `__proto__` / `constructor` / `prototype`，`name` 另不含 `:`。
- **core**：`provide` 处不再检查描述符是否来自另一份 core（定义校验处照旧拒绝）；内部的 `ForeignCoreError` 删除。注册被拒、插件或实例因此不会运行的一律记 error（定义或实例 id 校验失败、未声明 `reusable` 的多实例、注册时配置无法拷贝）；重名、禁用态的 `bounce`、`updateConfig` 的新配置无法拷贝仍记 warn。「装了两份 @aalis/core」的报错改指文档站地址。
- **runtime**：在根上提供 `host-logs`；启动与配置热重载时应用 `pluginServicePreferences`，全局 `servicePreferences` 同样随热重载生效，从文件里删掉的偏好同时从运行态撤回（此前手改需重启）。
- **plugin-webui-server**：插件列表带本插件偏好与此刻的选择；新增按插件设偏好的两条路由；全局偏好路由删去拒绝偏好时的 409 分支，配置文件拒写时回执改写「修好该文件后会按文件内容重载」（此前说以重启为准）；读日志改走 `host-logs`，宿主不提供时 `/api/logs/*` 回 503；`app:ready` 里先等插件状态静置再发现前端，bounce 不再误报未声明的服务；声明 `optional(contributions)` 与 `optional(hostLogs)`。
- **plugin-webui-client**：插件详情新增「服务偏好」一块与「现在用」一行；插件列表显示旧实例未停下的原因。
- **plugin-cli**：日志页读 `host-logs`，先补最近 2000 条再接实时；宿主不提供时日志页为空。
- **plugin-commands**：声明 `optional(tools)`（`@aalis/api-tools` 进 dependencies），`/status` 的工具数经它取。
- **plugin-session-manager**：会话的默认模型按 agent 插件的选择显示（含它的本插件偏好）。
- **plugin-agent**：默认模型与「偏好未生效」的提示按本插件偏好算。
- **plugin-doctor**：新增按插件的偏好检查 `services.preferences.<插件>.<服务>`（全局的仍是 `services.preferences.<服务>`）与 `plugins.lingering`。
- **plugin-tool-code-runner、plugin-tool-system**：激活前只看 `storage` 在不在；提供者不支持 `resolveLocalPath` 时，改为调用时报错，不再在激活时失败。
- **plugin-workflow**：每次运行带一个 `AbortSignal`，取消与拆卸会打断等待中的 `wait`、`agent`、`tool` 节点（`tool` 节点的 `toolCallContext.signal` 即它，覆盖调用方传入的；agent 回合本身不中止），拆卸等进行中的运行落定。
- **plugin-trigger-laya**（`private`）：托管的侧车停止宽限由 5 秒改为 3 秒，在 core 默认 5 秒的清理宽限内停下；`uses` 声明 `lifecycle`。
- **plugin-works-site**：`uses` 由 `app` 改为 `services`，按宿主实例认领目标的判据随之改为 `services.get(appService)`（每个激活的句柄各不相同）；同宿主同目标的第二个实例照旧激活失败。

### 新增

- **@aalis/api-host-logs**（新包）：`hostLogs` 描述符（服务名 `host-logs`），`recent(limit, { before?, match? })` 取本轮启动以来最后若干条，`subscribe(listener, { history? })` 先补发最近若干条再送此后的每一条，按 `seq` 递增、不重不漏，订阅归本次激活。由宿主提供，runtime 的 `createHostLogs()` 是 Node 宿主的实现（历史读家目录的 `logs/latest.log`），runtime 导出的 `FileLoggerHandle` 为此新增 `path`（日志文件的绝对路径）。插件读日志流改走它，不再直接订阅 core 的 `LogHub`（architecture 守卫拦下 core 与 runtime 之外的引用）。
- **本插件偏好**：`services.prefer(name, id, { for })`、配置文件的 `pluginServicePreferences`、WebUI 插件详情的「服务偏好」。说明与「哪些服务不宜按插件分开选」见 [运行态与配置文档](docs/core/config.md) 的「服务偏好」一节。
- **`services.inspect(key, { for })`**：按那个插件的口径排列，选中的那一条带 `selected` 与 `basis`。
- **api-storage 的 `own`**：插件私有目录的视图，见上文契约包一节。
- **契约约定**：[docs/design/contract-conventions.md](docs/design/contract-conventions.md) 写下服务名、业务层、登记方法、在场判断、同步与异步、本插件偏好与业务调用入口的约定；现有契约与它不一致的地方另批收敛。

### 修复

- 注入的 logger 抛错不再卡住插件状态机，`child` 派生失败也不外传。
- 清理超时之后新旧实例不再并存（见上文「旧实例停下之前不起新实例」）。
- 依赖丢失引起的连带退场按传递闭包成批，下游收尾时不再失去上游；前一份管理计划里还没收尾的消费者不再被后一份计划越过。
- plugin-webui-server：`app:ready` 里等待期间本实例被 `bounce`、`disable` 或 `unload` 关掉，醒来不再登记前端、不再监听端口（此前再 bounce 报 EADDRINUSE、停用后端口仍应答）。
- 一段操作固定在同一家：memory-vector（算向量与记 `modelId`、判方法与删除落盘）、user-profile、adapter-onebot 的合并转发展开、media 的描述回写、memory-summary 的压缩、paper 的发布与提名，在换提供者的空档里不会一半打到旧的、一半打到新的。
- WebUI 页面里的文件单元格在 storage 缺席时不再回 500。
- plugin-workflow 拆卸之后不再补触发过期的单次任务、不再写盘。
- plugin-doctor：`plugins.pending` 在没有缺服务的插件时写「无缺服务的插件」。此前写「无未就绪插件」，而在等别的插件启动、在等自己的旧实例停下的插件仍是 pending，与这句不符；它们照旧分别在 `plugins.waiting` 与 `plugins.lingering` 里报。
- plugin-webui-server：启用、改配置、重载与新建实例之后，插件不缺服务、在等自己的旧实例停下时，回执写「尚未激活：等待 <实例> 的旧实例停下」，此前只写「尚未激活，结果以插件列表为准」。设服务偏好（全局与按插件）时提供者不存在，404 的说明改为中文。
- create-aalis：full 档查插件目录时，`--registry` 指向的源回 200 却没有官方插件（镜像源多不支持检索），提示是哪个源、可以加 `--registry https://registry.npmjs.org` 重试；此前不提示，只有检索才列得出的官方插件一个都不装。

## 2026-10-01（core 0.19.1 patch；schema-config 0.14.0 minor；60 个包：9 minor / 51 patch）

插件配置统一通过 `defineConfig` / `ConfigOf` / `parseConfig` 声明类型与读取值。Core 仍只交付原始配置；解析规则属于 schema-config，插件保留夹紧、哨兵和跨字段约束。Core 同批修复 `uses` 类型错误定位、停机队列、服务归属校验、sticky 事件重复送达与配置拷贝失败的回执，并统一停机后的管理回执。停机回执的变化修的是「返回 true 却没有做任何事」的缺陷，core 按 patch 发布 0.19.1；core 0.20 留给内核全面简化。

- 按次版本发布（9 个）：schema-config 0.14.0（字段类型表改为取值类型，`dynamicOptions` / `allowCustom` 移入）、api-llm 0.13.0（`llm-ref` 改为 `ModelRef`）、plugin-checkpoint 0.14.0、plugin-flow-control 0.13.0、plugin-trigger-policy 0.15.0（`scopes` 统一为数组，删除默认对象与 resolver）、plugin-mcp-client 0.13.0、plugin-mcp-server 0.13.0（args/env 与 `toolGroups` 的解析）、plugin-scheduler 0.14.0（`resolveConfig` 输入改为解析后的配置）、plugin-session-manager 0.14.0（平台 `think` 改为选项）。
- 按 patch 发布（51 个）：core 0.19.1、runtime 0.15.1、api-agent 0.9.1、api-media 0.11.2、api-webui 0.11.1、create-aalis-plugin 0.11.1，以及其余 45 个只迁移配置读取或修复解析的插件。plugin-webui-server 0.14.1 与 plugin-webui-client 0.14.1 须同批升级。
- plugin-trigger-laya 0.2.0 是 `private` 包，不发布到 npm。

- `beginShutdown()` 后新发起的 `register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig` 一律返回 `false`，不修改插件状态或配置。此前停机中的 `unload` / 部分 `disable` 返回 `true`，`enable` 还可能把条目改回 `pending`。调用方应以 `app.stop()` 的完成判断停机结束，不再把这些管理动作的回执当作清理成功；正常运行时的幂等与在途 `unload` 合流行为保持不变。
- `provides` 校验同时核对实际登记的激活身份与条目的逻辑 id。由其他激活代登记同名 id 的服务，不再替当前插件满足声明；声明方应自己登记服务，纯代理登记方不要把代登记项写进自己的 `provides`。
- sticky 事件（`app:ready` / `app:started`）派发进行中登记的监听器只收到一次。此前本轮派发与补发各送一次，在 `app:ready` 里建连接的 OneBot 适配器会因此建出两条连接。派发结束后才登记的仍在下一个微任务收到补发。
- 配置无法拷贝（环状引用、getter 或 Proxy 抛错）时，`register` / `registerAll` / `bounce` / `updateConfig` 对该条返回 `false` 并记 warn，不再整体拒绝；`registerAll` 的其余条目照常登记，`bounce` 保留旧配置。
- **字段类型扩展**：`SchemaFieldTypes` 的值由占位标记改为实际取值类型。自定义字段将 `custom: true` 改为 `custom: MyValue`；`api-llm` 0.13.0 已将 `llm-ref` 改为 `ModelRef`。依赖新版类型的消费者必须同步升级。`dynamicOptions` / `allowCustom` 由 schema-config 声明，`secret` 仍由 api-webui 声明；api-webui 0.11.1 的最终字段形状不变。
- **配置解析行为**：`undefined` / `null` 表示缺省；有限数字和数字字符串按中立标量规则转换。普通无效字段按 schema 默认值回落或省略并告警；敏感地址、命令参数与启用边界使用 `onInvalid: 'error'`，显式无效时拒绝。提供拒绝规则的插件例外：tool-onebot 的开关写坏时按默认值处理并告警，插件照常激活，以免 OneBot 会话历史的访问限制随插件一起消失。MCP client 的坏 server 单独跳过，合法空字符串 argv 保留；storage-local 与 OneBot 的连接/根数组按整体严格策略处理，不会把坏项丢成默认配置后运行。
- **旧作用域与平台模板**：flow-control 0.13.0、trigger-policy 0.15.0、trigger-laya 0.2.0、checkpoint 0.14.0 的 `scopes` 统一为数组。前三者旧 `null` 表示空范围，需转换为 `[]`；旧字符串按原分隔规则转换。session-manager 0.14.0 的平台 `think: true/false` 转为 `on/off`。运行时不拦截旧写法：旧字符串与 `''` 会告警并回落默认值，`null` 不告警、直接取默认值。升级前请用离线工具的检查模式核对配置，并且在升级后第一次经 WebUI 保存这些插件之前完成；详见 [配置迁移](docs/guide/config-migration.md)。
- **MCP 暴露范围**：mcp-server 0.13.0 的 `toolGroups: null` 按缺省解析为 `[]`（全部组），旧版对此会拒绝启动。离线工具将其标为需人工处理，升级前明确允许的组或先禁用插件。数字组名会归一为字符串后精确匹配。mcp-client 0.13.0 的 args/env 使用数组/映射，旧文本须手工核对参数边界。
- **配置 helper**：删除仅供取值的 flow-control / trigger-policy / trigger-laya 默认对象与 resolver、checkpoint 的 `resolveConfig`；配置类型从 schema 派生。scheduler 0.14.0 保留导出的 `resolveConfig`，输入改为 schema 解析后的配置，并导出配套的 `configSchema`；需要直接调用的代码先执行 `parseConfig(configSchema, raw)`。scheduler 补齐 `runAt` 的 schema 声明，保留原有 sessionId 派生规则，只写一半的 actor 照旧告警后按未指定处理（owner）；静态任务的 `actorPlatform` / `actorUserId` 写成布尔、数组、对象时拒绝激活（数字按字符串处理），不按留空处理成 owner 身份。
- **安装下限**：55 个 schema-config 运行时消费者下限抬至 0.14.0；api-llm 消费者下限抬至 0.13.0。其余未删除有效配置形式或公开 API 的迁移包按 patch 准备。版本准备不代表已经发布。
- **WebUI 配置修复**：secret 掩码只用于展示，不写回原值；实例配置按分组深合并默认值，清空顶层 number / llm-ref 字段能回到缺省。已有配置的保留键过滤规则不变，限制见迁移说明。停机中或插件正在卸载时，启用、禁用、改配置被拒绝，返回 409 并说明配置未更改；插件不存在才返回 404。

## 未发布 · Harness

删除跨会话委派工具，`recent_messages` 提档，在线白纸（第一批），房间会话钉死出生平台、会话列表分区与停止键停掉子进程，后台命令结束通知，send_attachment 的格式签名移入新包，作品提名与上站，家目录（第一部分与第二部分），会话协议与会话服务（新 WebUI 的第一部分），审批（新 WebUI 的第二部分，取代 session-confirm 的确认链），新 WebUI 的其余各部分（管理推送与登录加固、外壳与会话设置、页面契约第二版、插件前端、控件比例、插件区与深度思考档位、需要处理与用量、后台任务），删除自档案，删除第三方行为指令，单元 7 收尾第一批，改用 node:sqlite，上手与故障说明，报错普查第二批，单元 7 第六步整批收尾，全量压缩与按比例触发，会话来源字段，真实用量、裁剪标记与条数线，工作会话的结构性放行，结构化摘要，触及解析与受保护清单，设置层表与场所，以及凭据文件的权限与时间线里的图片。Harness 的发布档位尚待统一确认；已合入 2026-10-01 发布的 core 0.19.1 与 schema-config 0.14.0，最终发布时按合并后源码与 npm 实况核定，以下版本基线仅用于标明 Harness 接口新增的位置。删除跨会话委派工具与 `recent_messages` 提档两节不需要抬包间依赖下限。其余各节要抬的下限列在各节里，一律抬到本批的新版本，即高于现已发布的 `@aalis/schema-message` 0.9.1、`@aalis/schema-config` 0.14.0、`@aalis/api-tools` 0.10.0、`@aalis/api-session-manager` 0.10.0、`@aalis/api-webui` 0.11.1、`@aalis/api-host-config` 0.1.0、`@aalis/api-gateway` 0.8.0、`@aalis/api-process` 0.8.0、`@aalis/api-code-sandbox` 0.6.0、`@aalis/api-memory` 0.7.1、`@aalis/api-agent` 0.9.1、`@aalis/api-platform` 0.9.0、`@aalis/api-authority` 0.10.0、`@aalis/api-storage` 0.7.0；新包对其余既有包的下限（如 plugin-paper 对 `@aalis/api-gateway` 写 `>=0.7.0`、plugin-remote-agent-cursor 对 `@aalis/util-network-guard` 写 `>=0.6.2`）用到的接口在已发布版本里都有，不必抬。带 `@aalis/core` peer 的包沿用已发布的区间，新包里带 core peer 的十五个写 `>=0.18.0 <1.0.0`；只有 plugin-code-sandbox-os 由 `>=0.17.0 <1.0.0` 抬到 `>=0.18.0 <1.0.0`（见「房间会话钉死出生平台、会话列表分区与停止键停掉子进程」一节）。core peer 这一条已被 core 0.20 节取代：发布时带 core peer 的包一律抬到 `>=0.20.0 <1.0.0`。

待发布的包：

- 有代码或契约改动（46 个）：schema-message、schema-config、runtime、create-aalis、api-code-sandbox、api-gateway、api-host-config、api-persona、api-process、api-session-manager、api-tools、api-webui、plugin-adapter-onebot、plugin-agent、plugin-asr-whisper-cpp、plugin-checkpoint、plugin-cli、plugin-code-sandbox-os、plugin-draw、plugin-flow-control、plugin-image-sender、plugin-llm-deepseek、plugin-mcp-client、plugin-media、plugin-memory-history、plugin-memory-mongodb、plugin-memory-summary、plugin-memory-vector、plugin-message-archive、plugin-package-manager、plugin-persona、plugin-process-local、plugin-session-manager、plugin-skills、plugin-storage-local、plugin-subtask、plugin-tool-browser、plugin-tool-code-runner、plugin-tool-session、plugin-tool-system、plugin-user-profile、plugin-user-relation、plugin-webui-client、plugin-webui-server、plugin-workflow
- 按次版本发布（28 个）：runtime（家目录；删掉 `startAalis` 的 `configPath`、`projectDir`、`subcommands` 等选项；`createConfigStore` 增加密钥存储参数，`createPluginDiscovery` 改收配置存储）、schema-config（新增字段属性 `format`；`secret` 改为语义属性，新增 `SecretRef` 等导出）、api-host-config（`HostConfig` 新增必需的 `applyPluginConfig`，读写改为文档形态）、api-webui（删除向 `SchemaField` 注入的 `secret`）、create-aalis（生成的项目带家目录 `home/`）、plugin-package-manager（删掉配置项 `projectRoot`，改为依赖 `host-paths`）、plugin-asr-whisper-cpp、plugin-draw、plugin-tool-browser、plugin-mcp-client（路径类配置不再收相对路径；`env` 改为密钥字段）、plugin-skills（`skillsUri` 默认改为 `skills:/`）、plugin-memory-mongodb（库名加 profile 一段、库的归属记录与新配置项 `claimFrom`；`uri` 改为密钥字段）、schema-message（删除 `IncomingMessage.proactiveDepth`）、api-persona（删除 `PersonaService.getSessionState`）、api-session-manager（删除 `resolveInheritedDefaults`，`SessionInfo.kind` 必填）、plugin-persona（删除 `getSessionState` 的实现；`personasDir` 默认改为 `personas:/`）、plugin-tool-session（删除跨会话委派工具组与两个配置项）、plugin-memory-history（`recent_messages` 提档）、plugin-session-manager（删除页面动作 `getInheritedDefaults`，`getSessionTree` 的回包改为分区）、plugin-adapter-onebot（出站媒体按文件头分流）、plugin-storage-local（依赖 `host-paths`；内置根按家目录布局，保留 data、pluginData、tmp、cache、logs、personas、skills、workflows、paper、public 十个根名；宿主控制文件兜底）、plugin-agent（`/session` 改调 `resolveInheritance`，须与 plugin-session-manager 同批升级；输出格式同改）、plugin-tool-system（`process_kill` 删除 `signal` 参数）、plugin-webui-server（删除导出函数 `resolveSessionPlatform`；插件配置接口改回引用、不回原值）、plugin-webui-client（密钥字段只显示「已设置」，认引用）、plugin-workflow（agent 节点的默认会话 ID）、plugin-code-sandbox-os（`@aalis/core` peer 下限抬到 0.18）、plugin-image-sender（交给平台适配器的附件改为 storage URI）
- 按 patch 发布（18 个）：api-code-sandbox、api-gateway、api-process、api-tools、plugin-checkpoint、plugin-cli（附件与纯文本消息的投递回执；日志位置的说明）、plugin-media（图片来源的裸路径不再路由到插件私有的内置根；说明里的临时目录）、plugin-llm-deepseek、plugin-memory-vector、plugin-message-archive、plugin-process-local、plugin-subtask、plugin-tool-code-runner、plugin-user-profile、plugin-user-relation、plugin-flow-control（只改 `scopes` 的配置说明，去掉「委派闸门」）、plugin-memory-summary（`summaryTokenRatio` 标 `secret: false`）
- Harness 的改动不需要为它们发版：plugin-embedding-openai、plugin-websearch-serper 只删了为 `secret` 写的类型导入（编译后擦除）与 api-webui 开发依赖，编译出的 JS 与类型声明不变（只差 source map 行号与 devDependencies），运行行为不变。两者在 core 0.20 节另有改动，随它发布。
- 上面的档位是各节合起来定的；各节末尾的「发布档位」只按那一节的改动说，同一个包在几节里都有改动的，以这里为准。
- 新包：api-remote-agent 0.1.0、plugin-remote-agent-cursor 0.1.0、plugin-paper 0.1.0、util-media-signature 0.1.0、api-publish 0.1.0、plugin-publish-review 0.1.0、plugin-works-site 0.1.0、util-offline-render 0.1.0、api-host-paths 0.1.0、api-checkpoint 0.1.0、api-session-protocol 0.1.0、api-todo-list 0.1.0、plugin-session-server 0.1.0、api-approval 0.1.0、plugin-usage-stats 0.1.0、api-reach 0.1.0、plugin-reach 0.1.0
- plugin-session-confirm 与 api-session-confirm 在「审批」一节删除，发布时对它们执行 npm deprecate，不再发新版。
- plugin-asr-openai、plugin-llm-openai、plugin-maimai、plugin-okx-trading 在后面几节另有改动（深度思考档位、上手与故障说明、报错普查第二批），按那几节发版。
- 「会话协议与会话服务」「审批」及其后各节的包还没并进上面三张清单：api-agent、api-tools、api-platform、api-session-manager、schema-message、plugin-agent、plugin-checkpoint、plugin-todo-list、plugin-tool-onebot、plugin-adapter-onebot、plugin-session-manager、plugin-storage-local、plugin-tool-system、plugin-image-sender、plugin-paper、plugin-webui-server；api-approval（新包）、api-authority、api-commands、api-gateway、plugin-authority、plugin-commands、plugin-gateway、plugin-tools、plugin-cli、plugin-webui-client、create-aalis。档位按各节末尾的说明，新 WebUI 各单元做完后统一并账。
- plugin-trigger-laya 是 `private` 包，只改了说明与注释，不发布到 npm。
- 上面的清单没收的：api-trigger、plugin-draw、plugin-tool-search 自上次发布以来也有源码改动（plugin-draw 见「作品提名与上站」；api-trigger、plugin-tool-search 的改动还没有写进本节），发布时按源码与 npm 实况核定档位并补写说明。
- api-agent、api-authority、api-flow-control、api-platform、api-storage、api-workflow、plugin-authority、plugin-scheduler、plugin-trigger-policy 只改了注释（去掉跨会话委派的提法；api-platform 写明会话 ID 约定，api-agent、api-workflow 改了 `token:request` 与会话 ID 的说明；api-storage 的 URI 示例改为 `skills:/`），Harness 的改动不需要为它们发版；它们在 core 0.20 节都另有改动，随它发布。

### 删除跨会话委派工具（@aalis/plugin-tool-session、@aalis/schema-message、@aalis/api-persona、@aalis/plugin-persona、@aalis/plugin-agent）

plugin-tool-session 删除跨会话委派工具组 `session-delegate` 及其两个工具，出于安全原因，不提供开关：

- `list_known_sessions` 不按调用者过滤，把最近活跃的全部会话连同各自最后一条消息的前 80 字交给任何触发者。群成员让 bot 列出会话，owner 的 WebUI 聊天和其他人私聊的最新一句都会显示出来。
- `delegate_to_session` 让多人平台上的任何人都能把任务派进任意已知会话，包括 owner 的 WebUI 会话。目标会话按自己的记忆与工具组推理，回复最多 2000 字原样交回发起会话。按发起者回填的授权身份（`actor`）只挡住需要等级的工具，目标会话里不需要等级的工具和它的聊天内容照样可达。它还能借 bot 向别的群或私聊发消息（私聊默认不在 flow-control 的限速作用域内），任务正文会永久写进目标会话的历史。

会话之间的协作将以「会话间消息」重新设计：权限跟随消息链的源头，工具取接收会话自己的，会话之间互不信任。新接口按那时的形态提供，不恢复这两个工具。

对用户的影响：

- 这次删除没有覆盖跨会话读取：plugin-memory-history 的 `recent_messages` 与 `list_known_sessions` 用同一个后端查询，同样不按调用者过滤。它在本批另行提档，见下文「`recent_messages` 提档」。
- QQ（onebot）与 WebUI 里都不能再列出会话、向别的会话派发任务。在私聊里让 bot「去某个群禁言某人」这类用法随之失效；plugin-tool-onebot 的群管理工具接受 `group_id`，当前会话开了对应工具组时可以直接指定目标群。
- session-manager 平台档或会话配置的 `enabledToolGroups` 里写着 `session-delegate` 的，这一项变为无效项：启动与热重载都不报错、不告警（数组项不按 schema 裁剪，`multiselect` 只校验元素类型），该项不再匹配任何工具，可以手动删掉。
- plugin-tool-session 的配置项 `crossSessionEnabled` 与 `crossSessionDefaultTimeoutSec` 删除。runtime 在启动与热重载时按 schema 裁掉这两项并写回配置文件，记一条 warn。
- plugin-tool-session 不再依赖 `events`、`hooks`、`platform`、`persona`、`flow-control` 服务，也不再挂 `agent:input:before` / `agent:turn:after` 中间件。
- plugin-agent 对 `triggerType: 'proactive'` 的消息不再解析 `proactive:from:<sid>` 形式的 `source`：系统块里不再有「源会话 ID」一行和读取源会话历史的提示，消息 `metadata` 不再带 `sourceSessionId`（第一方没有读取方）。workflow agent 节点的消息不带这种 `source`，呈现不变。

**破坏性变更与迁移**：

- **`@aalis/schema-message` 删除 `IncomingMessage.proactiveDepth`**：委派链深度，唯一的写入方与读取方都是委派工具。读写它的代码删掉该字段。`source` 字段说明里的 `'proactive:from:<sid>'` 示例一并删除。`triggerType: 'proactive'` 保留，第一方的生产者现在只有 workflow 的 agent 节点。
- **`@aalis/api-persona` 删除 `PersonaService.getSessionState`**：唯一的调用方是委派工具，用来把目标会话的结构化状态附在委派结果里；plugin-persona 的实现一并删除。会话状态持久化（`statePersistence`）与「上一轮状态」注入不变。自研 persona 实现可以删掉这个方法；调用过它的第三方代码改为自己保存需要的状态。
- 调用 `list_known_sessions` / `delegate_to_session` 的 skill、workflow `tool` 节点或提示词需要删掉相应步骤，工具不存在时调用会返回「工具未找到」。

要发布的包与档位（0.x 次版本可删公开 API）：plugin-tool-session、schema-message、api-persona、plugin-persona 按 minor 发布；plugin-agent 按 patch 发布。plugin-flow-control 的 `scopes` 配置说明去掉了「委派闸门」，只改说明文字，按 patch 发布。本节不需要抬任何包间依赖下限：删掉的字段与方法在第一方已没有使用方，plugin-tool-session 去掉了对 api-flow-control、api-hooks、api-persona、api-platform 的依赖。暂不升级 plugin-tool-session 的，委派工具仍在。要在旧版里关掉委派，把 plugin-tool-session 的 `crossSessionEnabled` 设为 `false`（旧版默认 `true`），或从多人平台的 `enabledToolGroups` 里去掉 `session-delegate`。

### `recent_messages` 提档（@aalis/plugin-memory-history）

`recent_messages` 改为声明 `risk: 'sensitive'`，与 plugin-tool-session 的 `session_get_history` 同档：等级 0 的调用者被权限守卫拒绝（返回「权限不足」），等级 1 起照常可用，不弹确认。此前不声明 risk，按 public 处理，开了 `session-history` 组的会话里任何触发者都能调用。

原因：这个工具查的是别的会话。它默认排除当前会话；`scope: 'same-platform'`（默认）返回同平台别的群与别人私聊的消息原文，`scope: 'cross-platform'` 不按平台过滤，还包括 owner 的 WebUI 会话，每次最多取到 memory 后端的 `crossSessionMaxLimit` 条（默认 1000）。2026-08-23 的复核曾以跨群感知为由维持 public；删除跨会话委派工具后，owner 改判：它与 `session_get_history` 同属跨会话读取，按读类工具的约定定为 sensitive。

对用户的影响：

- 裁决按授权身份：多人会话里未被点名的 interval 回合，授权身份为无主体，按默认等级裁决，模型在这类回合里同样调不到它。
- 未装 plugin-authority 的部署，执行守卫缺席时按 fail-closed 处理，`recent_messages` 对所有调用者都不可用，与 `session_get_history` 相同。
- plugin-workflow 从 WebUI 的运行按钮或 workflow 自己的触发器（cron、interval、once、event）启动时没有调用者，以匿名身份运行，按默认等级裁决：调用 `recent_messages` 的 `tool` 节点被拒，`agent` 节点里的模型同样调不到它。经 `workflow_run` 工具启动的 workflow 以调用者的授权身份运行各节点，由等级 1 起的用户触发时照常可用。
- plugin-mcp-server 默认不再暴露 `recent_messages`：`sensitive` 展开后的可见性是 `restricted`，而 `allowRestricted` 默认关闭，ListTools 不列出、CallTool 拒绝。只打开 `allowRestricted` 还不够，MCP 调用的身份是 `mcp` / `mcp-client`，默认等级 0，仍会被拒；要用须同时把这个身份设为等级 1，或按下文设置 `authorityOverrides`。
- 被动注入不变：`injectEnabled` 开启（默认）时，其他会话的近期消息原文照常注入每个回合的提示词，不经工具与权限守卫。注入范围跟随 `scope`，这一项同时是工具的默认作用域：默认 `same-platform` 取同平台其他会话，含别人与 bot 的私聊；设为 `cross-platform` 时还包括 WebUI 等其他平台的会话，这部分同样不受本次提档约束。注入内容另受 `limit`、`maxAgeMinutes`、`perSessionLimit`、`excludeCurrentSession` 约束。私聊内容经注入进入群回合这一点本批维持原样，是否保留尚未定案；不需要的关掉 `injectEnabled`。

**迁移**：要让等级 0 的调用者继续使用，把需要的用户设为等级 1，或在配置文件的 `authorityOverrides` 里把 `tool:recent_messages` 设为 `0`。后者按能力全局生效，会同时对多人平台上等级 0 的群成员放开，等于撤销这次提档。匿名运行的 workflow 没有单独放行的办法，要保留这类用法，改由等级 1 起的用户经 `workflow_run` 触发。

发布档位：plugin-memory-history 按 minor 发布。这是有意收窄一项经裁定维持 public 的能力，属于要附迁移路径的行为变化；0.9.1 那批按 patch 发布的收紧修的是非预期的默认值，性质不同。本节不需要抬任何包间依赖下限。

### 在线白纸（第一批）（新包 @aalis/api-remote-agent、@aalis/plugin-remote-agent-cursor、@aalis/plugin-paper；@aalis/schema-message、@aalis/api-tools、@aalis/api-session-manager、@aalis/api-webui、@aalis/plugin-agent、@aalis/plugin-message-archive、@aalis/plugin-memory-vector、@aalis/plugin-memory-history、@aalis/plugin-tool-session、@aalis/plugin-user-relation、@aalis/plugin-user-profile、@aalis/plugin-llm-deepseek、@aalis/plugin-session-manager、@aalis/plugin-subtask、@aalis/plugin-storage-local、@aalis/plugin-checkpoint、@aalis/plugin-adapter-onebot、@aalis/plugin-webui-client）

房间里真人提需求，模型调 `paper_task` 把任务交给远端编码代理（第一个提供者是 Cursor 云端代理）；宿主在房间里回显原文、排队、按天记账，跟踪每一轮到终态、取回成品、按轮入账，完成后以宿主通知回到房间，模型用 `paper_send` 把图片、GIF、MP4 或单个网页发回。说明见 `docs/plugins/plugin-paper.md`，安全边界与残余风险见 `docs/concepts/security-model.md`「远端代理与白纸」一节。

新包：

- `@aalis/api-remote-agent` 0.1.0：`remote-agent` 服务描述符与提供者接口 `RemoteAgentProvider`；`resolveRemoteAgent` 按提供者实例 id 精确取，取不到返回 `undefined`，不回落到偏好胜者或别的提供者；`egressWithin`（出网判定，`unknown` 按 `open` 算）、`artifactRelProblem`（成品相对路径的净化规则，提供者与写入口共用）、`isTerminalRun`、`RemoteAgentError` 与 `isRemoteAgentError`（按 `name` 认，装有两份契约包时也认得）。每轮费用 `RunCost` 只有计入额度的花费 `cents`，不带 token 数。
- `@aalis/plugin-remote-agent-cursor` 0.1.0：Cursor Cloud Agents API v1 提供者，可多实例。激活时不连网；首次 `ready()` 校验鉴权与模型参数（参数须写全并等于 `/v1/models` 的某个变体，默认 `grok-4.7`、`reasoning_effort: high`、`context: 256k`、`fast: 'false'`）；账号标识取 `/v1/me` 的 `userId`（整数）的哈希；每轮花费取 `chargedCents` 与 `rawCostCents` 的较大者（文档写计划内额度的用量 `chargedCents` 为 0），`/usage` 里的 token 数是一轮里全部模型调用的累计、不是上下文长度，不交出；出网方式取自配置 `egressMode`（默认 `unknown`），标「未核实」。key 只在宿主进程里用，错误与日志去掉 key 片段与查询串；成品经 `safeFetch` 下载、边读边计字节，单个成品取不到下载链接时只拒收这一件。列代理、列轮次按 `nextCursor` 取完所有页（每页 100 条），取不全时整次抛错（响应形状认不出、超过 50 页、下一页标记出现过时抛 `unavailable`，带标记取到空页时抛 `transient`），不把已取到的当完整列表；产物列表形状认不出时同样抛 `unavailable`。
- `@aalis/plugin-paper` 0.1.0：白纸枢纽。工具 `paper_task`、`paper_status`、`paper_cancel`、`paper_send`（`paper` 分组，不声明 risk）；运行驱动（每块白纸一条队列、出队时重跑受理的核对、先落盘再调远端、开轮认领（结果未知时轮次列不出来、或重启接回时提供者等满上限仍不在场，就留在开轮中等下次认领，不重发、不判失败；第一次认领失败挂 `claim-failed` 告警，owner 可以放弃跟踪，之后列得出轮次时那一轮记到这件任务名下、不当成自唤醒，还没到终态的请远端取消）、单轮时长计时器、对账与自唤醒处置、删代理前结清费用（取不到的按估计入账）、换新（代理累计花费超过 `rotateAfterCents` 或 owner 操作；不按 token 数）、闲置归档、定期清空、重启接回）；完成通知（失败原因与白纸停开的说明只写宿主撰写的类别，提供者报错的原文只进日志）与待交付提示；WebUI 白纸页（白纸、任务、成品、账本、告警；任务表可取消、放弃跟踪、核销预留）与诊断项 `paper.config`（对账时列代理或列轮次连续 3 次失败报 warn，写类别与次数，提供者停用或移除后不再报；认领失败后仍在开轮中的任务报 warn，与放弃跟踪同一判据）。`paper_cancel` 远端取消失败时回包只写类别，提供者报错的原文只进日志。账本在 `pluginData:/paper/ledger.json`，读不出时远端任务一律不开、原文件不覆盖。

契约新增：

- `@aalis/schema-message`：`IncomingMessage.hostNotice?: { kind; id?; untrusted? }` 标记宿主撰写的事件通知；`WellKnownKinds.HostNotice`（`'host-notice'`），出口前缀 `[宿主通知]`；常量 `DIRECTIVE_KINDS`（`CrossSessionDelegation` 与 `HostNotice`），表示宿主或系统撰写、不是任何人发言的指令类 kind。
- `@aalis/api-tools`：`ToolCallContext.inbound?: { source?: string }`，只由 plugin-agent 的工具循环填写，`source` 取本回合入站消息的 `source`。workflow 节点、mcp-server 等自造上下文的调用方不填。需要「真人当面发起」判据的工具应把缺省当作不满足。
- `@aalis/api-session-manager`：`SessionConfig` 新增 `paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentUserDailyCents`、`remoteAgentUserDailyTasks`、`remoteAgentRoomDailyCents` 与 `memoryRecallScope`（类型 `MemoryRecallScope`：`'session' | 'platform' | 'all'`）；导出 `ROOM_ONLY_CONFIG_KEYS`（前六个键）与 `omitRoomOnlyKeys()`。复制生效配置建新会话的路径都要经 `omitRoomOnlyKeys`；`memoryRecallScope` 随子会话复制。
- `@aalis/api-webui`：表格列新增 `method`，`render` 可取 `'file'`；导出 `WebuiFilePayload { name; mime; base64 }`。

行为变化：

- plugin-agent：带 `hostNotice` 的消息以一条 system 消息呈现（`[宿主通知]`、正文，再接 `untrusted`），不推当前 user 消息；`turn-context` 与 `turn-hint` 两个锚位先找本轮指令块（`metadata.injector` 属于 `DIRECTIVE_KINDS`）、落在它之前。顺带修正：proactive 回合里 `turn-hint` 此前落在最后一条 user 之前，即历史内部，现在落在任务块之前。工具调用上下文填写 `inbound`。
- plugin-message-archive：宿主通知归档为 `role: 'notice'`、`kind: 'host-notice'`，不带 `name`，`metadata.hostNoticeKind` 记子类；只归档 `content`，`untrusted` 不写进消息与 metadata。flow-control 禁言期的影子归档走同一条路径。
- plugin-memory-vector：宿主通知不入向量库；被动召回与 `memory_recall` 的上下文扩窗不再把指令类消息作为邻居带出，因此 workflow agent 节点代发的任务指令也不再随扩窗出现。按会话配置 `memoryRecallScope` 收窄召回：取插件配置与房间范围中较窄的一个，`memory_recall` 的 `scope` 参数放不宽。新增可选依赖 `session-manager`。
- plugin-memory-history：房间 `memoryRecallScope` 为 `session` 时不做跨会话注入，`recent_messages` 返回「本房间的召回范围限于本会话…」；为 `platform` 时插件配置或工具参数写 `cross-platform` 也按 `same-platform` 查。跨会话注入与 `recent_messages` 按 `DIRECTIVE_KINDS` 排除别的会话的宿主通知与代发任务指令：此前试点群的宿主通知正文会进同平台其他会话（包括 owner 私聊）的注入，workflow 代发的任务指令也一样。新增可选依赖 `session-manager`，依赖加 `@aalis/schema-message`。
- plugin-tool-session：`session-history` 服务在插件 `scope` 与平台规则之前先按当前房间的 `memoryRecallScope` 裁决（`session` 时只能读本会话，`platform` 时跨平台拒绝），一处管住 `session_get_history` 与 `onebot_get_session_history`。新增可选依赖 `session-manager`。
- plugin-user-relation：宿主通知不计入提取计数；三条读取路径的历史窗口改按 `DIRECTIVE_KINDS` 过滤（跨会话读取的 `excludeKinds` 同样）。房间 `memoryRecallScope` 为 `session` 时，注入只留本会话的事件，不出「所属跨会话话题」与「最近热点（全局）」；人际关系与关注的事物照常注入，查询工具不受影响。新增可选依赖 `session-manager`。
- plugin-user-profile：用户事实提取、自反思、指令提取三处的历史窗口改按 `DIRECTIVE_KINDS` 过滤。不读 `memoryRecallScope`，参与者事实照常跨会话注入。
- plugin-llm-deepseek：system 位置归一化的豁免由「injector 为代发任务」扩为「injector 属于 `DIRECTIVE_KINDS`」，宿主通知块保持 system。
- plugin-session-manager：平台档表单新增上述七个键，加载时逐键核对类型（上限只收有限且不小于 0 的数，`memoryRecallScope` 只收三个取值），类型不对的丢弃并记 warn，`null` 与空串按未设置处理；页面动作 `createSession` 的两种复制都去掉房间键；页面动作 `getInheritance` 取代 `getInheritedDefaults`（见下文破坏性变更）。
- plugin-subtask：`create_subtask` 复制父会话配置时去掉房间键。
- plugin-storage-local：新增内部根 `paper`（`<cwd>/data/stage/paper`，kind `paper`，不在文件页出现），在用户根之后注册、不受 `roots` 影响；激活时会建这个目录。
- plugin-checkpoint：kind 为 `paper` 的根不记账。
- plugin-adapter-onebot：
  - `kind: 'file'` 的出站附件在文字与消息段之后上传：群会话调 `upload_group_file`，私聊调 `upload_private_file`；内容只用 `base64://`，超过 10 MiB 的 storage 文件、超限的 http 链接拒发；文件名去掉 `/` 与 `\`；上传不重试；v12 连接不支持。适配器对象新增非标准扩展方法 `uploadFile`（不进 `@aalis/api-platform` 契约）。此前 file 附件只打 debug 后跳过。
  - 视频不超过 10 MiB 时改为 `base64://` 内联（此前 storage 视频交宿主的 `file://` 路径，http 视频原样交 URL，实现端在容器里时读不到宿主路径）；http 视频现在由 Aalis 流式下载，超过上限的仍交原 URL。storage 附件先量大小再读，超限的不整份读进内存。
  - 图片、语音、视频按文件头分流（格式签名在新包 `@aalis/util-media-signature`，与 `send_attachment` 的白名单是同一份）：能内联的格式走消息段；认得出、但不能内联的（BMP、AVIF、HEIC 图片，MKV、AVI 视频，以及与附件 `kind` 不符的媒体）改经群文件、私聊文件上传，没有名字时文件名为类型加格式（如 `image.bmp`）；都认不出的拒发并记 warn（见下文破坏性变更）。超过 10 MiB 的 storage 媒体改交宿主路径之前同样核对（按字节区间读出开头 4 KiB），超过 10 MiB 又不能内联的不发。依赖加 `@aalis/util-media-signature`。
  - 投递失败记录（`outbound-delivery-failed`，只对 `source: 'agent'`）覆盖文字发送、附件物化（含文件头不符的拒发）与上传三处失败，每条出站消息至多一条；正文由「经多次重试仍未能送达」改为「(可能包含图片、媒体或文件)未能送达对方」。
- plugin-webui-client：会话页新增「白纸与远端」一组，每项显示继承值与来源（默认、平台档或父会话），`remoteAgentTypes` 来自平台档时显示告警；取继承值改调 `getInheritance`。声明式表格支持文件单元格：只有 PNG、JPEG、GIF、WebP 能在页面里查看，其余只能下载，下载一律按 `application/octet-stream` 保存。

**破坏性变更与迁移**：

- **plugin-session-manager 删除页面动作 `getInheritedDefaults`**：改用 `getInheritance({ sessionId })`，返回 `{ platform, values, sources }`。会话所属平台由服务端推出（会话 metadata 记下的平台 → 接管这个会话 id 的平台适配器 → `webui`），动作不再收平台参数；`sources` 给出每个键来自全局默认、平台档还是父会话。自己调用过 `getInheritedDefaults` 的 WebUI 客户端改调新动作。同批的「房间会话钉死出生平台、会话列表分区与停止键停掉子进程」一节又改了三处：IM 房间的平台取出生平台，回包另带 `audience`，来源层多出 `audience`；服务接口上的 `resolveInheritedDefaults` 在那一节删除。
- **plugin-adapter-onebot 出站媒体按文件头分流**：以消息段发出的只有图片 PNG、JPEG、GIF、WebP，语音 WAV、MP3、OGG、FLAC、AMR、SILK、M4A，视频 MP4、MOV、WebM。BMP、AVIF、HEIC 图片与 MKV、AVI 视频此前按图片、视频消息段发出，现在以群文件、私聊文件发出，超过 10 MiB 的不发；认不出的格式（如 SVG、TIFF 图片）此前照发，现在拒发并记 warn。`send_attachment` 发出的同样受约束。要以图片、视频消息发出，先转成上面的格式。视频与文件改走 `base64://` 依赖实现端接受这种形态；未确认过的实现端，升级后先在测试会话里发一次视频与文件核对。
- **plugin-storage-local 保留根名 `paper`**：`roots` 里名为 `paper` 的用户根会被跳过并记 warn，内部根优先。自建了同名根的，改名后同步修改引用它的 URI。
- plugin-memory-vector 的扩窗不再带出 workflow 代发的任务指令，proactive 回合的 `turn-hint` 落点前移，都是行为变化，无需迁移。

要抬的依赖下限：

- `@aalis/schema-message`（`hostNotice`、`WellKnownKinds.HostNotice`、`DIRECTIVE_KINDS`）：plugin-agent、plugin-message-archive、plugin-memory-vector、plugin-memory-history、plugin-user-relation、plugin-user-profile、plugin-llm-deepseek、plugin-paper 抬（plugin-memory-history 是新增依赖，现写 `>=0.9.0`）。`DIRECTIVE_KINDS` 是运行时导入，装到旧版 schema-message 时这些包加载失败。
- `@aalis/api-tools`（`ToolCallContext.inbound`）：plugin-agent、plugin-paper 抬。
- `@aalis/api-session-manager`：plugin-session-manager、plugin-subtask 抬（运行时导入 `omitRoomOnlyKeys`，装到旧版时加载失败）；plugin-memory-vector、plugin-memory-history、plugin-tool-session、plugin-user-relation、plugin-paper 抬（新键与 `MemoryRecallScope` 类型）。
- `@aalis/api-webui`（`render: 'file'`、`method`、`WebuiFilePayload`）：plugin-paper 抬。
- 三个新包之间与新包对既有包的下限，现写的是开发时的当前版本号（如 plugin-paper 对 api-session-manager 写 `>=0.10.0`），发布时按上面各条一并抬到本批的新版本。

发布档位：三个新包按 0.1.0 首发。plugin-session-manager（删页面动作）、plugin-adapter-onebot（媒体格式收窄）、plugin-storage-local（保留根名）按 minor 发布，附上面的迁移；schema-message、plugin-memory-history、plugin-tool-session 在本节之前已定为 minor。api-tools、api-session-manager、api-webui 只做加法，plugin-agent、plugin-message-archive、plugin-memory-vector、plugin-user-relation、plugin-user-profile、plugin-llm-deepseek、plugin-subtask、plugin-checkpoint、plugin-webui-client 是修复与加法，按 patch 发布。

### 房间会话钉死出生平台、会话列表分区与停止键停掉子进程（@aalis/api-gateway、@aalis/api-platform、@aalis/api-session-manager、@aalis/plugin-session-manager、@aalis/plugin-agent、@aalis/plugin-persona、@aalis/plugin-memory-history、@aalis/plugin-memory-vector、@aalis/plugin-tool-session、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-workflow、@aalis/api-process、@aalis/plugin-process-local、@aalis/plugin-tool-system、@aalis/api-code-sandbox、@aalis/plugin-code-sandbox-os、@aalis/plugin-tool-code-runner）

IM 房间（群与私聊）不论从哪个入口驱动，都按房间自己的出生平台与受众选平台档，跨会话召回的同平台也按出生平台算，入口平台只用来认出说话的人；会话带上种类、受众与出生平台，WebUI 会话页分「我的会话」「IM 房间」两区，IM 房间按首条真人入站收录；停止键能停掉 exec 与代码执行的子进程；code-sandbox-os 的启动探测不再拖满停机宽限。不需要改配置。

行为变化：

- 房间会话钉死出生平台：`@aalis/api-gateway` 新增 `resolveSessionOrigin`，按会话 ID 推出出生平台（第一个 `:` 之前的一段，子任务按父会话算）与受众（第三段为 `private` 的是私聊，其余按群）。session-manager 对有出生平台的会话按出生平台选档、忽略传入的入口平台，入口平台只对没有出生平台的会话（WebUI、CLI 等）起作用。从 WebUI 往 QQ 群或私聊插话，这一轮按 onebot 的平台档选工具组、人设与模型，回复照常发进群里；此前按 webui 档运行，拿得到 webui 档开放的全部工具组。会话页的继承提示、`/session` 的来源、persona 的会话环境与 token 快照都按同一口径。钉死只管继承链，会话自身配置里的覆盖仍然优先：此前从 WebUI 驱动群回合时建出的子任务，若已把 webui 档复制进自身配置，要在会话页里清掉这些键或归档这些子任务。
- 会话 ID 约定写进 api-platform 的 `PlatformAdapter.canHandle` 说明：多人房间的会话 ID 以 `<平台名>:` 开头，实现了 `canHandle` 的适配器也要遵守；非房间的内部会话 ID 不含单冒号，要分段用 `::`。ID 前缀与平台名不一致的第三方适配器，它的房间按那个前缀对应的平台档选档（多半不存在，落到全局默认），session-manager 按前缀告警一次，不纠正。
- 平台档新增受众条目：`platformProfiles` 的条目可带 `audience`（`group` 为群与频道，`private` 为私聊），只列与同平台基础档不同的键，叠加在基础档之上，只对有出生平台的房间生效；取值无效的条目整条丢弃并告警。`getPlatformProfiles()` 只回基础档。plugin-paper 的诊断项 `paper.config` 与白纸页「共用的房间」改为对已登记的 IM 房间逐个看 `resolveInheritance` 的值与来源，受众条目里写的 `remoteAgentTypes`、`paperName` 同样报出与列出（此前只看 `getPlatformProfiles()`，受众条目里的看不到）；受众条目要等这个受众有房间登记后才看得到。
- persona 的会话环境按出生平台取当前平台、自己的账号与会话类型，说话人信息照旧取自消息；入口与出生平台不同时加一行「当前消息经 `<入口平台>` 发来」。此前从 WebUI 往群里插话时写的是「当前平台：webui」，没有会话类型与 bot 在群里的账号。
- 跨会话召回按出生平台：plugin-memory-history 的被动注入与 `recent_messages` 的 `same-platform`、plugin-memory-vector 被动召回与 `memory_recall` 的同平台可见范围、plugin-tool-session 的 `session-history` 服务的同平台裁决（插件的 `scope: platform` 与会话配置 `memoryRecallScope` 为 `platform` 时），对 IM 房间都取出生平台作当前平台，不论从哪个入口驱动；没有出生平台的会话（WebUI、CLI 等）照旧取入口平台。此前从 WebUI 往群里插话时按 webui 算：同平台注入与 `recent_messages` 取的是 owner 其他 WebUI 会话的原文，同平台别的群反而不在；向量召回取的是 WebUI 会话的记忆，本群与同平台别的会话的记忆被滤掉；`session_get_history` 拒读同平台别的群。消息落库记下的平台仍是入口平台，owner 从 WebUI 往房间插的话与那一轮的回复记为 `webui`，不进同平台别的房间的 memory-history 注入。
- 自动标题：从 WebUI 往 IM 房间插话不再给房间生成标题，也不经标题路径建档；此前会用 owner 的那句话给房间起标题。
- IM 房间收录：有出生平台的房间，首条真人入站（不带 `source`）到达即登记（`createdBy: 'system'`、状态 `waiting`）；群取群名、私聊取对方昵称，只采信出生平台自己的入站带的名字，缺省用会话 ID，名字还是 ID 时由后到的原生入站补上。带 `source` 的内部注入（workflow、定时任务、空闲开话题、宿主通知、好友申请等合成通知）不登记。部署后来过真人消息的群与私聊都会列进会话页的「IM 房间」区；此前只有执行过 `/session.set`、开过子任务或从 WebUI 插过话的房间才登记。`createChildSession` 兜底建档的房间以会话 ID 为名。
- 会话状态：`inbound:message` 不再把会话翻成 `active`，改为回合开始时（`agent:input:before`）翻转，同一个中间件在回合结束时把仍为 `active` 的根会话收口为 `completed`，这是唯一的收口。群里只有消息、bot 没开口的房间不再显示「进行中」；被后面的输入中间件拦下或抛错的回合也不再停在「进行中」。未装 agent 时会话不再翻 `active`。同一会话并行多轮（后台命令结束通知、白纸通知与真人回合各占一条 lane）时按会话计在飞的回合，最后一轮结束才收口；回合中途发出的出站消息不再收口。此前 `outbound:message` 与 `agent:turn:after` 也各收口一次：`send_attachment`、`paper_send` 在工具执行中发出附件时会话就显示已完成，并行的另一轮结束时同样提前收口。`ensureSession` 未命中建档时 `status` 缺省按有没有回合在跑定，有为 `active`，否则为 `waiting`（此前一律 `active`，首条消息是指令的 CLI 会话靠指令回复的出站收口）。
- 会话页：分「我的会话」「IM 房间」两区，分区在服务端判定；子会话默认收起；批量模式的「全选」只选所在分区，页头的跨区全选删除；删除确认写明会清空消息历史与长期记忆（摘要、向量记忆等）、会话里仍在运行的 `exec_background` 后台进程一并终止（见下文「后台命令结束通知」），删除 IM 房间时另写明聊天平台里的消息不受影响、房间之后再来消息会重新出现且记忆从零开始，批量删除含 IM 房间时写出其个数。
- 停止键停掉子进程：exec、run_python、run_javascript 把回合的中止信号交给子进程，按进程组停掉（POSIX 先 SIGTERM、宽限 2000ms 后 SIGKILL，Windows 立即结束整棵进程树），回合随即结束；此前要等命令跑完或超时（`maxTimeout` 默认 300000ms）。被信号结束的结果带 `aborted: true` 与 `message`（exec 为「命令已随回合中止」，代码执行为「代码已随回合中止」），不标 `timedOut`；中止前已自行退出、或结束时没有终止信号的，按实际退出回报并加 `note: '回合已中止'`。停止键不杀 `exec_background` 起的后台进程：在对话回合里起的进程自行退出时通知起它的会话，要停时由她用 `process_kill` 直接停，见下文「后台命令结束通知」。中止与超时只打原进程组：主动脱离进程组的后代（`setsid` 等守护化写法）在 exec、无沙箱与 macOS 沙箱路径上停不掉，Linux bwrap 路径有 pid 命名空间。Windows 中止路径只有单元用例，未在 Windows 上实测；Linux bwrap 路径的中止已在 Docker 容器里实测（arm64，Debian 12 的 bubblewrap 0.8.0，非 root 用户）：外层 bwrap 被 SIGTERM 结束，结果带 aborted，沙箱内的脚本随即停止，用 setsid、detached: true 脱离进程组的后代也一并结束。
- code-sandbox-os 的启动探测改经 `spawn` 并带本次激活的 `lifecycle.signal`，退出码为 0 才算有后端。启动器挂住时停用或停机随即中止探测，不再等满 5000ms 的探测超时，也不再因此被判「未在宽限内停止」转为 error。Linux 的探测命令补上 `--dev /dev --proc /proc`，与正式运行的挂载一致：只放开 seccomp、挂不了 `/proc` 的容器里此前探测报 bwrap 可用、之后每次运行都失败，现在探测为 none，按规则失败关闭。
- token 快照：plugin-webui-server 发 `token:request` 不再带 `platform`；plugin-agent 缺省时依次取会话的出生平台与 `webui`。此前 webui-server 自己按已注册的平台名解析会话 ID 前缀。

新增：

- `@aalis/api-gateway`：`resolveSessionOrigin` 与类型 `SessionOrigin`。
- `@aalis/api-session-manager`：`SessionInfo` 的 `kind`（必填）、`originPlatform`、`audience`；类型 `SessionKind`、`RoomAudience`、`InheritanceSource`、`SessionInheritance`（后两个从 plugin-session-manager 移入）、`SessionListSection`、`SessionTreeSection` 与纯函数 `sessionListSection`；服务方法 `resolveInheritance`。
- `@aalis/api-process`：`SpawnOptions.signal`。plugin-process-local 实现它，并导出宽限常量 `ABORT_KILL_GRACE_MS`（2000）。
- `@aalis/api-code-sandbox`：`SandboxRunRequest.signal`，plugin-code-sandbox-os 转交给 process 服务。
- plugin-session-manager：平台档条目的 `audience`。
- plugin-tool-code-runner：`RunResult` 的 `aborted`、`message`、`note`；`runCode` 末尾新增可选参数 `signal`。

**破坏性变更与迁移**：

- **`@aalis/api-session-manager` 删除 `SessionManagerService.resolveInheritedDefaults`**：改用 `resolveInheritance(sessionId, platform?)`，原返回值即它的 `.values`，另回选档平台、受众与每个键的来源层。自研 session-manager 要实现 `resolveInheritance`，并按出生平台钉死平台档，否则新版 plugin-agent 的 `/session` 调用会抛 TypeError。
- **`SessionInfo.kind` 为必填字段**：自研 provider 建档时按 `parentId` 填（有为 `task`，否则为 `room`），并按会话 ID 填 `originPlatform`、`audience`；手写 `SessionInfo` 对象的代码（如测试夹具）要补上 `kind`，否则类型检查不过。`createSession`、`createChildSession` 的参数不再接受这三个字段。
- **页面动作 `getSessionTree` 的回包由 `SessionTreeNode[]` 改为 `SessionTreeSection[]`**（`{ key, label, nodes }`，我的会话在前，空区不回）；服务方法 `getTree()` 不变。自研前端调这个页面动作的，按分区读。
- **`/session` 输出格式**：每个字段一行「生效值 + 来源」，来源标签为「会话覆盖」「父会话」「平台档 `<平台>`」「平台档 `<平台>`（私聊）」「平台档 `<平台>`（群）」「默认」（原为「父会话 sessionDefaults」「平台 profile (`<平台>`)」）；会话有覆盖时第二行列出被覆盖的继承值；不再列「解析链」。按文本解析 `/session` 输出的脚本要改。
- **会话状态的翻转时机**：依赖「来消息即 `active`」的第三方代码，改为看回合（`agent:input:before` / `agent:turn:after`）。`ensureSession` 建档时 `status` 缺省不再一律为 `active`，要 `active` 的显式传入。
- **workflow agent 节点的默认会话 ID**：省略 `sessionId` 时由 `workflow:agent:<runId>:<nodeId>` 改为 `workflow::<runId>::<nodeId>`。按旧前缀匹配会话 ID 的代码要改。旧 ID 按新约定会被认作出生平台为 `workflow` 的群房间，此前以旧 ID 建过档的会话（如在其中开过子任务的）会列进「IM 房间」区，可以删除或归档。
- **plugin-webui-server 删除导出函数 `resolveSessionPlatform`**：`token:request` 的平台兜底移到 plugin-agent。
- **第三方 process 提供方要实现 `SpawnOptions.signal`，code-sandbox 提供方要转交 `SandboxRunRequest.signal`**：不实现时调用方的中止静默失效，停止键停不掉命令，也不报错。
- **plugin-code-sandbox-os 的 `@aalis/core` peer 抬到 `>=0.18.0 <1.0.0`**（用到 `lifecycle.signal`），`package.json` 的 `aalis.service.required` 加了 `lifecycle`：core 0.17 上不能用新版。
- 回退到旧版时，新版登记的 IM 房间记录会留在会话表里，旧版的入站监听对非 `active` 的会话一律翻成 `active`（包括已归档的），这些房间每来一条消息就显示「进行中」。这只影响会话页的显示；从会话页删除房间会清空它的记忆，不建议用来清理。

发布时要抬的包间依赖下限（抬到本节的新版本）：`@aalis/api-process`（`SpawnOptions.signal`）由 plugin-process-local、plugin-tool-system、plugin-tool-code-runner、plugin-code-sandbox-os 抬；`@aalis/api-code-sandbox`（`SandboxRunRequest.signal`）由 plugin-tool-code-runner、plugin-code-sandbox-os 抬；`@aalis/api-session-manager`（`resolveInheritance`、`SessionInfo` 新字段与分区类型）由 plugin-agent、plugin-session-manager、plugin-paper 抬（plugin-paper 在运行时导入 `sessionListSection`）；`@aalis/api-gateway`（`resolveSessionOrigin`）由 plugin-session-manager、plugin-persona、plugin-agent、plugin-memory-history、plugin-memory-vector、plugin-tool-session 抬，其中 plugin-session-manager 与后三者是本节新增的依赖，现写 `>=0.7.0`。plugin-webui-client 不依赖 api-session-manager，没有下限要抬。版本号与档位发布时按 release 流程定。

其余说明：

- api-agent（`token:request` 的说明）、api-workflow（`AgentNodeSpec.sessionId` 的说明）、api-platform（`canHandle` 的说明）在本节只改了注释，列在上文「只改了注释」里。
- api-code-sandbox、plugin-process-local、plugin-tool-code-runner 本节有改动，但不用 core 0.18 的接口，`@aalis/core` peer 仍是 `>=0.17.0 <1.0.0`。

### 后台命令结束通知（@aalis/plugin-tool-system、@aalis/schema-message、@aalis/plugin-agent、@aalis/plugin-subtask、@aalis/plugin-webui-client）

本节的 `exec_background`、`process_*` 工具与按进程发的结束通知，已在「后台任务」一节由后台任务取代；最终形态以那一节为准，本节保留 `hostNotice.callerUserId`、通知回合的身份与中止规则。

`exec_background` 起的后台进程在本次运行期间自行退出时，她会自己开口说结果；让她停时她直接停，不再弹确认。不需要改配置。

行为变化：

- 结束通知：在对话回合里起的后台进程自行退出（包括出错退出）时，plugin-tool-system 向起它的会话注入一条宿主通知（`source` 为 `exec-bg:<进程 id>`，`hostNotice.kind` 为 `exec-background`），agent 随即开一轮回复。通知只带进程 id、退出码（或结束它的信号名，或「出错结束」）与用时，命令与输出不进通知，她用 `process_read` 读输出。身份跟起进程的那次调用：`actor` 为那次调用的有效授权身份，`hostNotice.callerUserId` 为那次调用的 `userId`，这一轮的等级、确认由谁应答、会话授予都与起进程的那一轮相同。不在 agent 回合里起的（mcp-server、workflow 的 tool 节点）、在由结束通知开启的回合里起的、被 `process_kill` 终止的、会话已删除的、插件停用或停机时收掉的，都不通知。长驻进程正常运行时不会退出，也就没有通知。
- `process_kill` 不再需要确认，仍为 restricted；删除 `signal` 参数，按进程中止契约终止整组（POSIX 先 SIGTERM、宽限后 SIGKILL，Windows 立即结束整棵进程树），最多等 3000ms 再如实回报是否已停（`stopped: true` 或 `running: true`）；只能终止与调用者同一身份起的进程，owner 除外。此前需要会话级确认，只发一个信号（默认 SIGTERM，可传任意信号名）、不看是否退出。要恢复确认，在 authority 的 `confirmOverrides` 里给 `tool:process_kill` 配上。
- 后台进程的收尾：插件停用、bounce 时按中止契约整组收掉（此前只发 SIGTERM、不升级）；删除会话时该会话仍在运行的后台进程一并终止，登记记录清空（此前继续运行，重建的房间还能用 `process_list`、`process_read` 看到删除之前的进程与输出）。停止键仍不杀后台进程。
- `exec_background` 创建失败（如 cwd 不存在）直接回 `后台进程启动失败：<原因>`，不再先回「已启动」。
- 后台进程 id 由 `proc_<序号>` 改为 `proc_<本次启动的 6 位十六进制>_<序号>`，Aalis 重启之后不会与历史里的旧 id 撞号。`process_read` 的结果加 `command` 字段。
- plugin-agent：宿主通知回合的工具调用上下文 `userId` 取 `hostNotice.callerUserId`；真人消息（不带 `source`）到达时，中止同一会话里 `callerUserId` 等于这条消息 `userId` 的通知回合，别人的消息与不延续任何人身份的通知不受影响。
- plugin-subtask：`create_subtask` 派发、`send_to_subtask` 追问的消息带 `source: 'subtask'`，按内部注入处理：确认相位不把它们当作应答，不经触发判定、不查回复后冷却，白纸的交任务与取消拒绝子任务回合。此前它们不带 `source`，入站相位按真人消息处理：子任务回合发起的确认与父会话发来的追问 `userId` 同为 `parent:<父会话 id>`，父会话里的模型用 `send_to_subtask` 发一句 `y` 或 `ys` 就能批准子会话里的确认（包括子会话里后台命令结束通知回合发起的）；触发插件的作用域里会话类型段为通配（`*`、`onebot:*` 等）时派发会被计数判定吞掉、子任务不启动，flow-control 的作用域为通配时子会话冷却期内的追问也会被吞。子任务回合发起的确认仍以 `parent:<父会话 id>` 为应答者，没有真人能应答，60 秒后按拒绝结算。
- plugin-webui-client：收到流式片段或工具调用开始时显示停止键，不是从输入框发起的回合（她被结束通知唤起）也能停；工具调用只接到进行中的流式气泡上，上一条回复已完成时另起一条。
- 通知回合与同一会话的其他回合并行（各占一条 lane）：owner 正在聊，或起进程的那一轮还没结束时，可能两轮各回复一次、各改同一批文件；WebUI 里先结束的一轮的最终消息会覆盖共用的流式气泡，刷新后正确。

新增：

- `@aalis/schema-message`：`IncomingMessage.hostNotice.callerUserId`。宿主通知的 actor 约定改为：不延续某次调用的用 `selfInitiatedActor`、不设 `callerUserId`；延续某次工具调用的沿用那次调用的身份并设 `callerUserId`。

**破坏性变更与迁移**：

- **`process_kill` 删除 `signal` 参数**：工具参数声明了 `additionalProperties: false`，带 `signal` 的调用（如 workflow 的 tool 节点里写死的参数）会被参数校验拒绝，去掉这个参数即可。
- plugin-tool-system 的插件声明 `required` 加 `events`、`optional` 加 `authority`，依赖加 `@aalis/schema-message` 与 `@aalis/api-authority`。

发布时要抬的包间依赖下限：plugin-tool-system 对 `@aalis/schema-message`（新增依赖，现写 `>=0.9.0`）、plugin-agent 对 `@aalis/schema-message`，都抬到含 `hostNotice.callerUserId` 的版本。

### send_attachment 的格式签名移入新包（@aalis/plugin-image-sender、新包 @aalis/util-media-signature）

- 格式签名表移入新包 `@aalis/util-media-signature` 0.1.0（`detectMediaFormat`、`checkMediaHead`、`MEDIA_HEAD_BYTES`），plugin-adapter-onebot 的出站分流（见「在线白纸（第一批）」一节）用同一份；plugin-image-sender 依赖加这个包。
- 核对通过的文件以 storage URI 交给平台适配器，不再预先换成 `file://<宿主路径>`：超过 onebot 适配器落盘上限（`attachmentCache.maxBytes`，缺省 10 MiB）的文件，此前 `file://` 原样交给实现端、适配器不核对，现在适配器按字节区间读出文件头再核对一次才交宿主路径。实现端在容器里时读不到宿主路径，超过 10 MiB 的本机文件照旧发不出去（送达方式未变）。

**行为变化**：

- 第三方平台适配器收到的 `send_attachment` 附件，取自存储库的一律是 storage URI（如 `data:/images/…`），要经 storage 服务读取；此前解析得到本机路径时是 `file://<宿主路径>`。`@aalis/schema-message` 的 `MessageAttachment.data` 说明同步补上 storage URI（第一方生产者早已在发这种形式）。

### 作品提名与上站（新包 @aalis/api-publish、@aalis/plugin-publish-review、@aalis/plugin-works-site、@aalis/util-offline-render；@aalis/plugin-paper、@aalis/plugin-draw、@aalis/plugin-storage-local、@aalis/plugin-checkpoint、@aalis/api-webui、@aalis/plugin-webui-client）

作品提名与上站新增 `api-publish`、`plugin-publish-review`、`plugin-works-site` 和 `util-offline-render`。白纸增加提名与撤下工具；审核、隔离预览和作品站操作有 WebUI 入口。`manualReview` **默认关闭**，自动通过可继续发布；自动拒绝、不确定或模型调用失败先拦截并等待人工裁决。开启后，自动通过也须等待人工。结构检查与内容净化失败始终阻断。先前施工方案中的跳过自动分类选项未作为兼容配置保留。详见[审核配置](docs/plugins/plugin-publish-review.md)与[作品站配置](docs/plugins/plugin-works-site.md)。启用作品站后才会在后台部署，此处的本机测试不代表真实项目已经上线。

- **存储根保留名**：新增内部 `public` 根（`data/stage/public`），与 `paper` 一样不参与会话 checkpoint；自建同名用户根会被跳过并告警，升级前请改名。白纸提名的文件仍先走独立审核，不因位于该目录就自动上线。
- **绘图引擎**：plugin-draw 改用 util-offline-render，默认尝试 Chromium 沙箱，失败后告警回落；作品审核要求沙箱。浏览器不再接管宿主 SIGINT，网络由请求拦截、解析规则和代理共同限制。
- **WebUI 页面契约**：api-webui 新增表格 `render: 'image'`、`render: 'time'`、`render: 'link'` 与页面级 `refresh`（秒）。作品站、审核历史与白纸任务的时间列改用 `time`（此前直接显示毫秒数），作品网址改用 `link`。审核、作品站、白纸与对应客户端须同批升级，避免图片单元格不可用、时间与网址按原值显示或后台状态不刷新。已发布的 api-webui 0.11.1 不含这几项：Harness 发布时 api-webui 须另升版本，审核与作品站的 api-webui 下限随之抬到该版本，不能只升级插件实现。

### 看板已定的几项白纸与发布收尾（@aalis/plugin-paper、@aalis/plugin-publish-review）

- 待提交的自动发布最长等 24 小时：创作结束后一直没能提交（发布目标或发布服务一直不可用）的，转为失败并通知来源房间，不再无限期挂着。经 `works_nominate` 重新提名的，24 小时从重新提名时起算；重新提名时发布服务暂时不收（展示面暂未登记、待审额度或每日提名配额用完）的，保留待提交、按发布服务给的时间自动重试，工具回执写明已排队，不记成审核没通过；已写成待提交、随后读不到成品或提交出错的同样回已排队，稍后自动重试。暂时不可用时按 30 秒重试，不被别的任务的长时间等待推迟。
- 多目标作品的某个展示面暂时缺席（重启、重载还没重新登记）时，沿用它上次核验过的地址，「已上线」保持不变；此前会短暂变成未上线。
- 全局每日额度留空仍是不限额（语义不变），doctor 给出一条「不限额」提示，白纸页的额度列与账本也写明「不限额」。
- 具名白纸的出网上限、发布目标写错（或整条不合配置规则）时，这块白纸停用并在日志与 doctor 报错，同名的后续条目不能顶替（同名写了多条、其中有写错的，整块停用）；此前写错的出网上限按默认属性照用，可能比本意宽。默认属性里的发布目标含无效 ID 时拒绝启用（此前忽略无效的 ID 后照用）。
- 自动发布在提交前就失败、而且是发布环节本身的问题（挑不出成品、目标未获准、24 小时没能提交）时，宿主在失败通知前先把能发的成品（规则同 paper_send，最多 4 件）直接发回发起房间并等平台确认，通知写明结果；审核没通过（含发布检查不通过）只通知原因，成品不发出去、paper_send 也拒绝。发布环节出问题的任务，成品此后也能用 paper_send 发回，并进入待交付提示（此前这些成品既不能提名、也不能发回）。发送逻辑移到新文件 deliver.ts，paper_send 与直接发送共用。
  - 审核没通过的任务重新提名后即使再次失败，成品仍不发出去（账本记下审核结论，期限与其它提交前失败都不会把它改成可直接发）。
  - 宿主直接发送成品期间，待交付提示不列这件任务，paper_send 也拒绝，避免同一份成品发两遍。
  - 重新提名后在后台于提交前再次失败时，来源房间会再收到一条完成通知；成品此前已发出或结果未知的不再直接发，通知写明不要重发。当场被拒的仍只由工具回执告知。
  - `works_nominate` 在写账本、提交之前核对所选成品的公开路径，不合规的当场拒绝并说明原因。
  - `paper_status` 只给创作完成、发布在提交前失败的上线任务列成品编号（供重新提名）；创作失败或取消的不列，这类任务 paper_send 的拒绝理由如实写创作没完成，不再说没通过审核。
- 作品上线等通知以平台确认收下为准：此前进了出站总线就记已发，平台发送失败时通知就丢了。现在等适配器回执，没确认就留待重发；她已经转述过的，重发直接派发宿主原文，不再多跑一轮模型（看板「作品上线通知要不要等平台确认」定甲）。
- 作品通知连续发不出去满 24 小时后放弃，不再无限重试：审核页新增「没发出的通知」可手动重发，doctor 报出条数（失败起点落盘，重启照算）。批准后复制时完整性失败的通知改为「作品已通过审核，但上线前的文件完整性校验失败」。
- 白纸页加「不带旧工程继续」：换新后旧工程包永久取不到时，owner 可以放弃交接，新代理接着用自己的工作区（或下一次新建不带旧包），成品与记录保留；此前只能清空白纸。

### 作品集重做外观（@aalis/plugin-works-site）

- 首页改为作品卡片网格：缩略图、类型、标题、日期与摘要，没有缩略图时用标题首字作封面，跟随系统深浅色，手机单列；此前是浏览器默认样式的竖排链接，摘要不显示。
- 首页与作品页加分享信息（Open Graph），绝对地址取 `siteOrigin`；作品页只带标题与缩略图，仍然铺满视口、不显示标题与摘要。
- 下架页与 404 套站点样式并能回到作品集；日期固定为「2026 年 10 月 1 日」格式，不再随宿主 locale 变。

### WebUI 里的图片：没开页面照样保存，存储地址能显示，历史里能看到（@aalis/plugin-webui-server、@aalis/plugin-webui-client）

- 发往 WebUI 会话的消息，没有在线页面时此前报「没有在线收件方」、不归档，定时任务、白纸通知或刷新那一刻发的图会丢。现在会话历史就是收件箱（看板「WebUI 没开页面时的图片与成品」定甲）：webui-server 先把别处不会存档的部分写进会话历史，写成了才回执送达。
  - 系统提示、作品通知、指令回复记成事件分隔条（不进模型上下文），文件记一行「[文件] 名称」，图片、视频、音频记成附件，她发出的也由 webui-server 自己记，不再取决于是否装了 image-sender；`history_ref` 重发的不再记一遍。
  - 她自己的文字仍由 agent 存档。装着 image-sender 时，它不再为发往 WebUI 的媒体另记一条，也不再为其中的网址图片与视频在后台补视觉描述。
  - 一条消息要写多条记录时逐条写入：中途写入失败、又没有在线页面时回执失败，已写成的几条不撤回，发起方重发会重复记。
  - 存档服务不在场、也没有在线页面时，回执报失败，不谎报已送达。回执不再等页面写出，页面卡住时作品通知与 paper_send 不会因此被报成未确认。
  - plugin-webui-server 依赖加 `@aalis/api-message-archive`（可选服务 message-archive），`@aalis/schema-message` 改为运行时依赖。
- 聊天里附件给的是存储地址（`send_attachment` 发本机文件、`paper_send` 都是）时，浏览器拿它当不了图片地址，图显示不出来。新增 `/api/media`：owner 才能取，按文件头判定类型，只提供图片、视频与浏览器能播的音频；客户端把存储地址换成这条路由。plugin-webui-server 依赖加 `@aalis/util-media-signature`。读文件出错只断开这次请求并记一条警告，页面中途断开不记；文件管理页与已上传文件的下载同样处理，此前这两处读流出错会让进程退出。
- 回看历史时，她发出的附件此前显示成 `[图片: … | ref:…]` 占位符原文；现在还原成图片、视频或音频，按相对路径（`data/images/…`）记的图片也能显示。

### CLI 会话里的附件（@aalis/plugin-cli）

- `send_attachment`、`paper_send` 发往 CLI 会话的附件，此前没有平台认领投递回执，工具一律报失败、也不归档。现在终端每件写一行说明（类型、名称、大小、本机路径），写出即算送达并照常归档（看板「CLI 会话里发附件」定甲）。音频的说明行写作「[音频]」，与归档占位符一致。
- 发往 CLI 会话的纯文本消息（如作品通知）写到终端即算送达；此前没有认领回执，作品通知会在 24 小时里重复打印约 30 次。plugin-cli 的 `@aalis/schema-message` 改为运行时依赖（用到的导出在已发布的 0.9.1 里都有，不必抬下限）。

### paper_send 等平台确认收下（@aalis/plugin-paper、@aalis/schema-message、@aalis/plugin-image-sender、@aalis/plugin-adapter-onebot、@aalis/plugin-publish-review、@aalis/plugin-webui-server）

- `paper_send` 此前交给网关就把成品记为已交付，平台下载或上传失败时她仍会说发出了，待交付提示也随之消失。现在与 `send_attachment` 一样等平台适配器确认：确认收下才记已交付；发送失败返回原因；没有适配器接手时直接报没有发出；等不到确认（最多 90 秒，或这一轮被中止）时返回「结果未确认，请勿重发」，当场按结果未知记下；迟到的确认补记已交付，迟到的确定失败撤掉结果未知。
- 等回执的写法移进 `@aalis/schema-message`：新增 `awaitDelivery` 与 `DELIVERY_WAIT_MS`，plugin-image-sender 改用它，行为不变。
- `OutboundDeliveryResult` 的失败分支新增可选的 `unconfirmed: true`，表示结果未知、可能已经送达。plugin-adapter-onebot 只在失败全部由上传超时造成时带上它。plugin-paper 按成品记下结果未知：这件成品 paper_send 拒绝再发，同一任务的其他成品照常可发；这件任务不再进待交付提示，宿主也不再直接发送，完成通知写明已发出、平台没确认、不要重发；plugin-publish-review 的作品通知按已发出处理；send_attachment 不报告成功，也不劝重发。
- 新增 `outboundMediaMessage`：出站图片、音频、视频的归档写法，plugin-image-sender 与 plugin-webui-server 共用，归档格式不变。

### 家目录（第一部分）：从任何目录启动同一个实例（新包 @aalis/api-host-paths；@aalis/runtime、@aalis/schema-config、@aalis/create-aalis、@aalis/plugin-storage-local、@aalis/plugin-checkpoint、@aalis/plugin-persona、@aalis/plugin-skills、@aalis/plugin-media、@aalis/plugin-memory-mongodb、@aalis/plugin-package-manager、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-process-local、@aalis/plugin-asr-whisper-cpp、@aalis/plugin-draw、@aalis/plugin-tool-browser、@aalis/plugin-publish-review、@aalis/plugin-mcp-client、@aalis/plugin-cli）

- **家目录**
  - 实例的配置、数据与日志此前放在启动时的当前目录里：换个目录启动就是另一个（空的）实例，生产实例住在仓库里，一次 `git clean -fdx` 就会删掉。现在它们都在家目录里。
  - runtime 在启动时按 `--home`、`AALIS_HOME`、`--profile` / `AALIS_PROFILE`（`~/.aalis-<名>`）、宿主代码的 `defaultHome`、`~/.aalis` 的顺序解析一次，进程的 cwd 不再带任何语义。
  - `--home` 与 `AALIS_HOME` 开头的 `~` 展开成用户主目录；环境变量设成空串视同没设。profile 名只能用小写字母、数字与连字符；profile 与 `--home` / `AALIS_HOME` 同时给出时报错退出。家目录是 `~/.aalis-<名>` 时就是 profile `<名>`，经 `--home` 选中它也一样；按写法认不出时再按真实路径认，所以大小写写法不同或经指向它的别名选中时同样是这个 profile。交给插件的家目录取真实路径（符号链接已解开）。
- **初始化**
  - 家目录没有初始化（里面没有 `aalis.config.yaml`）就拒绝启动，只提示怎样初始化，不会静默起一个空的家。
  - 在启动命令里、子命令之前加上 `--init` 运行一次即可初始化：建目录（0700），写默认的 `aalis.config.yaml` 与空的 `secrets.yaml`（0600），建布局里的子目录。目标目录里已有布局以外的东西时拒绝初始化。
  - `secrets.yaml` 的读写见「家目录（第二部分）」一节。
- **实例锁**：同一家目录只许一个守护进程。手动在终端再起一份时，此前会与服务并存、每条消息回两遍；现在打印占用者的 pid 与锁文件后以 1 退出，不碰正在用的日志。
  - 以 `--service` 启动时改以 0 退出，配合 launchd 的 `KeepAlive={SuccessfulExit=false}`，不会被反复拉起。
  - 锁在家目录的 `run/instance.<n>.lock`，按代号 link 取得，两个进程同时启动也只有一个拿到；家目录所在的文件系统要支持硬链接。
  - 判活用开机标识、pid 与进程启动标识，与墙上时钟无关；SIGKILL 留下的锁下次启动时按残留接手。开机标识不同（宿主机重启过）的一律按残留接手，容器里也一样；同一次开机里容器被强杀后重启（pid 命名空间不同），判不了原进程是否还活着，按占用处理，要按报错提示手动删锁文件。Windows 与没有 `ps` 的环境只看 pid。锁只在同一台主机内有效：两台主机经网络盘共用一个家目录时开机标识不同，会互相按残留接手，不要这样部署。
  - `/restart` 与市场更新引起的前台重启经环境变量 `AALIS_LOCK_HANDOFF` 把锁交给新进程，新进程读到即从环境里删掉。以 `--service` 运行时，重启改为停掉后以 75 退出、由服务管理器拉起，不自己起新进程；服务形态下市场更新没有「新版起不来就回滚」。子命令不取锁。
- **安装集**：默认的插件加载器从安装集（`appDir`）的 `package.json` 找插件。安装集里没有 `package.json` 时拒绝启动，并说明要传 `appDir`；此前这种情况会一个插件都不加载、照样起来。缺省的 `<家目录>/app` 留给以后的全局启动器，现在的入口都要自己传 `appDir`。
- **日志**：文件日志改写到家目录的 `logs/latest.log`，WebUI 与 CLI 的日志页读的就是这一份。
- **存储根按家目录布局**：plugin-storage-local 的内置根按家目录派生，不再受 `roots` 配置影响：
  - `data` → `state/`（根名保留，历史里的附件句柄照常解析）、`pluginData` → `state/plugins/`、`tmp` → `tmp/`、`cache` → `cache/`、`logs` → `logs/`（只读）；
  - self 下各一个根：`personas` → `self/personas/`、`skills` → `self/skills/`、`workflows` → `self/workflows/`；
  - `paper` → `stage/paper/`、`public` → `stage/public/`。
  - `roots` 配置缺省只剩 `workspace`；与内置根同名的项（升级前持久化的 data、tmp、pluginData、logs 等）被跳过并告警，可以删掉。用户根一个都没有时只告警，不再拒绝激活。
  - plugin-persona 的 `personasDir` 默认改为 `personas:/`，plugin-skills 的 `skillsUri` 默认改为 `skills:/`。plugin-checkpoint 不给 `cache` 与 self 根记账（技能、人设此前在 `data` 根里，同样不记账）。编排定义的目录在这一部分不动。
- **记忆库按家目录区分**（plugin-memory-mongodb）
  - `database` 留空时库名加 profile 一段：主家目录 `aalis`，profile 家目录 `aalis_<profile>`，后缀实例再加后缀（`aalis-<后缀>`、`aalis_<profile>_<后缀>`）。
  - 库里记着它归哪个家目录（真实路径）与实例：不同家目录连同一个 MongoDB、派生出同一个库名时（例如 `.aalis-dev/` 与 `~/.aalis`，或复制出来的测试实例），后来的那个以一行配置错误激活失败，不会共写。库里任一集合已有数据却没有归属记录时也不默认认走。路径只在一台机器上有意义：家目录路径相同的两台机器或两个容器连同一个 MongoDB 时认不出来，要各自写明 `database`。
  - 新增配置项 `claimFrom`：家目录搬了位置后，先停掉原家目录的实例，再填原家目录的路径认领；认领已有数据的旧库填 `unowned`。认领后删掉这一项。
  - 激活失败时本插件不提供记忆服务；同时启用了 memory-sqlite 或 memory-inmemory 的，记忆改由它们提供。
- **宿主控制文件兜底**：不管经哪个根进来，存储都不许读写家目录的 `secrets.yaml`、不许改 `aalis.config.yaml`（按 dev 与 ino 比，Windows 上按完整的 64 位文件 ID 比，硬链接与符号链接都挡得住）；删除、移动、改名一个含它们的目录，或以写、删的方式交出这类目录的本地路径，同样拒绝（按目录身份比，firmlink 与 bind mount 的别名也认得出）。它们不存在时，往它们的位置写、在下面建目录都拒绝。只有宿主自己读写它们；以读的方式交出目录（命令的工作目录）不查子树，挡命令读文件靠以后的沙箱。
- **新契约包 `@aalis/api-host-paths`**：服务 `host-paths` 给出家目录、安装集与家目录布局的绝对路径，runtime 在根上独占提供，交给插件的对象是冻结的。
  - plugin-storage-local 依赖它，存储根的相对路径按家目录解析；
  - plugin-package-manager 依赖它，往安装集里装卸插件。原来要与宿主手动对齐的配置项 `projectRoot` 删掉了：配置里残留的这一项会被忽略，可以删掉；要装到别处，改由入口给 `startAalis` 传 `appDir`；
  - plugin-webui-server 可选依赖它：市场、系统组件与前端发现都读安装集，宿主不提供时这几页回 503、也找不到前端，只剩 HTTP API。
- **cwd 守卫**：新增 architecture 守卫，runtime 与两个脚手架以外的包不得读 cwd（`process.cwd()`、`process.env.PWD` 等）。
- **runtime 的接口**
  - `startAalis` 删掉 `configPath`、`projectDir` 与字符串形态的 `fileLog`，新增 `appDir` 与 `defaultHome`；`subcommands` 改名 `argv`，开头的宿主参数（`--home`、`--profile`、`--init`、`--service`）先取走。
  - `createFsYamlConfigProvider`、`createFsPluginLoader`、`createNodeModulesPluginLoader`、`setupFileLogger` 的路径参数改为必填，且必须是绝对路径（相对路径直接抛错）。`appendCrashLog` 的路径参数改为必填。
  - `createProcessRespawnStrategy` 必须传 `appDir` 与 `cwd`（新进程在启动时的 cwd 里起，命令行里相对的 `--home` 才解析到同一处），可选 `env`（交给新进程的环境变量，startAalis 用它交接实例锁）。新增 `createServiceRestartStrategy` 与 `SERVICE_RESTART_EXIT_CODE`（75）。`buildRespawnCommand` 的第一个参数改为 `appDir`。删掉导出常量 `DEFAULT_LOG_FILE`。
  - 新增导出 `parseHostArgs`、`resolveHome`、`profileOfRealHome`、`derivePaths`、`isHomeInitialized`、`initHome`、`HomeArgsError` 与类型 `HostArgs`、`ResolveHomeInput`。`resolveHome` 按写法认 profile，认不出时 startAalis 用 `profileOfRealHome` 按家目录的真实路径补认，自组装宿主可以照做。
- **路径字段的 `format`**
  - schema-config 新增字段属性 `format`（string 与 textarea 适用）：`'absolute-path'` 只收绝对路径，`'executable'` 另收按 PATH 查找的命令名。判定忽略首尾空白，交给插件的值也去掉首尾空白；空串照常表示未填，只有空白的必填字段同样算没填；只按写法判定，与宿主平台无关。plugin-webui-client 的表单给这类字段显示写法提示。
  - 下面这些字段都声明了它：whisper-cli 与模型路径、绘图 / 浏览器 / 审核渲染用的 Chrome 路径、审核的 ffmpeg 路径、MCP server 的 `command`。它们此前收相对路径并按启动目录解析；现在写了相对路径的插件拒绝激活，MCP 只跳过那一个 server。改成绝对路径即可。whisper-cli 与 ffmpeg 的路径改为必填加默认值，留空时用默认的命令名，不再拿空串去执行。
- **其余修复**：plugin-process-local 的 `readExternalFile` 拒收相对路径：契约本来只收绝对路径或 `file://`，相对路径此前按 cwd 读。plugin-webui-server 还没有选中前端时，不再按 cwd 找 `index.html`。
- **脚手架**：create-aalis 生成的项目带家目录 `home/`（配置与空的 `secrets.yaml` 都在里面），入口传 `appDir` 与 `defaultHome`，`.gitignore` 改为忽略整个 `home/`。用 npm 启动时，宿主参数要写在 `--` 之后：`npm start -- --home <目录>`。
- **从源码运行**：`pnpm dev` 的家目录是仓库里的 `.aalis-dev/`（第一次先 `pnpm dev --init`）；`pnpm start` 不带 `--home`，用 `AALIS_HOME` 或 `~/.aalis`。
- **旧项目升级**（create-aalis 生成的项目）。先停掉实例并整体备份项目目录，下面几步都在第一次用新版启动之前做：
  1. 把 `index.mjs` 改成按入口所在目录传安装集，并把项目目录本身当家目录：

     ```js
     import { dirname } from 'node:path';
     import { fileURLToPath } from 'node:url';
     import { startAalis } from '@aalis/runtime';

     const here = dirname(fileURLToPath(import.meta.url));
     startAalis({ appDir: here, defaultHome: here });
     ```

  2. 在项目目录里按新布局搬目录：先 `mkdir -p self stage`；`data/` 改名为 `state/`（如果新版已经启动过、建出了空的 `state/`，先删掉它）；再把 `state/stage/paper`、`state/stage/public` 移到 `stage/paper`、`stage/public`，`state/personas` 移到 `self/personas`，`state/skills` 移到 `self/skills`；`workspace/.tmp` 可以删掉（临时区改在 `tmp/`）；`state/latest*.log` 不再使用。
  3. 改 `.gitignore`：原来只忽略 `data/`，现在实例数据在 `state/`、`self/`、`stage/`、`tmp/`、`cache/`、`run/`、`logs/` 里，把这几项加上（`aalis.config.yaml` 照旧忽略，另加 `secrets.yaml`）；下次提交前先看一眼 `git status`，别把数据库、WebUI 凭据与 `users.json` 提交进去。
  4. 改 `aalis.config.yaml`：用 MongoDB 记忆库的，在 `@aalis/plugin-memory-mongodb` 下加 `claimFrom: unowned`（旧库里已有数据、还没有归属记录，不写会拒绝激活），启动一次、日志里出现「归属改到家目录」或「记下归属」后删掉它；同时确认 `@aalis/plugin-memory-sqlite` 与 `@aalis/plugin-memory-inmemory` 在 `disabledPlugins` 里，否则认领失败时记忆会悄悄改由它们提供；`@aalis/plugin-storage-local` 的 `roots` 只留 `workspace` 与自己加的根。data、pluginData、tmp、cache、logs、personas、skills、workflows、paper、public 现在是内置根：同名的项会被跳过、它的 `path` 不再生效；以前把 data、pluginData 或 tmp 指到别处的，先把那个目录搬到 `state/`、`state/plugins/` 或 `tmp/`；自己加的根若用了这十个名字之一，改个名字。`@aalis/plugin-persona` 的 `personasDir` 若还是 `data/personas`、`@aalis/plugin-skills` 的 `skillsUri` 若还是 `data:/skills`，删掉这两项用新的默认值；`@aalis/plugin-package-manager` 残留的 `projectRoot` 删掉。
  5. 密钥不用手动搬：第一次用新版启动时自动从 `aalis.config.yaml` 移进 `secrets.yaml`，其余步骤见「家目录（第二部分）」一节的升级步骤。
- **发布时要抬的下限**
  - plugin-persona、plugin-skills 对 `@aalis/plugin-storage-local` 没有包依赖，但新的默认目录要新版 storage-local 提供的 `personas`、`skills` 根，见「必须同批升级的包」。
  - plugin-asr-whisper-cpp、plugin-draw、plugin-tool-browser、plugin-publish-review、plugin-mcp-client 对 `@aalis/schema-config` 的下限，抬到含 `format` 的新版本：旧版不认这个属性，相对路径会照旧放行。plugin-mcp-client 删掉了自己对 `command` 的去空白与空值判断，改由新版 schema-config 做，配旧版时带空白的命令会原样拿去执行。
  - plugin-storage-local、plugin-package-manager、plugin-webui-server、plugin-memory-mongodb 对 `@aalis/api-host-paths` 写 `>=0.1.0`。
  - runtime 对 schema-config 的下限这一部分不用抬，第二部分要抬，见下一节。

### 家目录（第二部分）：密钥存进 secrets.yaml（@aalis/schema-config、@aalis/api-host-config、@aalis/api-webui、@aalis/runtime、@aalis/create-aalis、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-mcp-client、@aalis/plugin-memory-mongodb、@aalis/plugin-agent、@aalis/plugin-memory-summary、@aalis/plugin-adapter-onebot、@aalis/plugin-asr-openai、@aalis/plugin-embedding-openai、@aalis/plugin-llm-deepseek、@aalis/plugin-llm-openai、@aalis/plugin-maimai、@aalis/plugin-okx-trading、@aalis/plugin-remote-agent-cursor、@aalis/plugin-tool-system、@aalis/plugin-websearch-serper、@aalis/plugin-works-site）

- **`secret` 改为语义属性**
  - `SchemaField.secret` 此前是 api-webui 经 declaration merging 注入的 WebUI 呈现属性，只让表单遮住值，值照旧以明文写在 `aalis.config.yaml` 里。现在它由 schema-config 声明，表示「这个字段的值是凭据」，各宿主都按它处理：值存进宿主的密钥存储，配置文档里只写引用 `{ $secret: '<键>' }`，展示与回传都不给原值。api-webui 删掉了同名注入。标在 map、list 上时整个值算一个密钥。
  - schema-config 新增导出 `SecretRef`、`isSecretRef`、`mapSecretFields` 与类型 `SecretPosition`。`validateConfig` 校验的是文档，密钥字段上的引用算合法。`parseConfig` 遇到密钥字段上仍是引用（宿主没能解析，键不在密钥存储里）时一律不可恢复，不看 `default` 与 `onInvalid`，在数组元素里也让整次解析失败，消息点名键名。`defaultsFrom` 不再产出密钥字段：密钥的默认值不写进文档，`parseConfig` 照常补上。
  - 名字像凭据却不是凭据的字段写 `secret: false` 表明已判断过：plugin-agent 的 `memoryTokenBudget`、plugin-memory-summary 的 `summaryTokenRatio`、plugin-webui-server 的 `tokenMode`。
- **secrets.yaml**
  - runtime 启动时读家目录的 `secrets.yaml`（「键 → 值」的映射）并监听改动，把配置交给插件之前解析引用，插件经 `parseConfig` 读到的仍是原值。
  - 缺省键是 `<实例 id>.<字段路径>`，数组元素里的字段路径不带下标；已被占用（配置里有引用指向它，或 `secrets.yaml` 里已有）时依次加 `-2`、`-3`。几处配置可以手写成指向同一个键。
  - 引用的键不在 `secrets.yaml` 里时，记一条错误（点名实例、字段与键）。用 `parseConfig` 读取、且装的是新版 schema-config 的插件激活失败，消息点名键名，不回落默认值；不走 `parseConfig` 的插件会拿到引用对象，由诊断检查 `config.secrets` 报出（runtime 登记给 doctor，每个有悬空引用的实例报一条 error，点名字段与键）。
  - 保存时先写 `secrets.yaml`、再写主配置；`secrets.yaml` 的临时文件一律以 0600 创建，不沿用原文件的权限位。与主配置一样，盘上有尚未生效的外部修改时拒写。
  - 宿主经自己的写入（WebUI 改配置、删除实例、卸载插件、同步裁剪）换掉或删掉引用后，不再被任何配置引用的键在保存时删除；宿主新建、后来又没人引用的键同样删除。删除在主配置写成之后做，这一步写 `secrets.yaml` 失败不让保存报错，键留到下次保存再删。手改配置文件不会触发删除，手加进 `secrets.yaml`、还没被引用的键不动。
  - 外部修改 `secrets.yaml` 后只重新加载解析结果变了的实例；配置热重载同样改为拿解析后的配置与运行态比较。宿主写 `secrets.yaml` 被拒（盘上有尚未生效的外部修改）之后，下一次文件变更按两个文件对账：被拒的那次改动作废，文档退回配置文件上的内容，插件按文件重载，与主配置被拒写时一致；你在文件里写的值以文件为准。因为别的原因没写成的密钥不会丢，并进新读到的内容，下次保存时写入。运行中把它改成空文件或只剩注释，按空的密钥文件处理，不当作坏内容忽略。监听的目录被删除或不可访问时停止监听并告警，不让进程退出。
  - 两个文件的 YAML 解析错误在日志里只写错误码与行列，不再带报错消息的首行（其中可能有原文，原文可能就是密钥）。YAML 的警告（例如把 `!xxx` 当成标签、以集合作键）也不再经 Node 的 process warning 带原文打到 stderr，改为记错误码与行列。启动时两个文件里有一个写坏，打印一行错误（错误码、行列与文件路径）后退出，不带调用栈。
  - 自组装宿主创建配置存储时不给密钥存储的，密钥照旧以明文留在文档里；没有 `configSchema` 的插件、没标 `secret` 的字段也照旧是明文。没装上或加载失败的插件，宿主不处理它们的配置段，明文原样保留；这类残留段冷启动时逐段告警，要手动删掉，或装好插件后再启动一次。
- **配置文件里的明文会被自动移走**：配置同步（启动、热重载、市场装载插件）遇到密钥字段上的非空明文，把它移进 `secrets.yaml`、原处换成引用。这会改写用户的 `aalis.config.yaml`，日志只写实例、字段路径与键名，不写值，在写成之后才记。运行中把已有的引用改成明文时，新值写回原来那个键（与 WebUI 里替换一致，旧值不留在 `secrets.yaml` 里；这个键被别的插件共用时，它们一起换成新值并重载）；启动前改的、数组元素里的照旧新建键。`''`、空 map、空 list 不算密钥值，原样留着。移走之前的明文仍可能留在编辑器的备份文件、同步盘的历史版本与 git 历史里（配置文件曾经提交过的话），需要自行清理；曾经外泄过的密钥应当轮换。
- **host-config 读写文档形态**（api-host-config）
  - 新增 `applyPluginConfig(instanceId, submitted)`，返回 `{ status: 'refused' }` 或 `{ status: 'applied', reloaded, saveError? }`：拆出密钥、更新运行态（未登记的后缀实例按同模块的定义登记，先写文档再登记，没登记上时撤回文档与密钥）、写文档，让共用了被替换的键的其他实例按新值重载，最后落盘。
  - 写入规则：密钥字段上的引用表示保持；非空明文在顶层与分组字段上写进该实例当前文档在同一位置引用的键（被共用时一并影响共用者），没有引用时新建键；数组元素里的一律新建键；`''` 与空值不是密钥。本次提交新引入的悬空引用（键不在 `secrets.yaml` 里、也不是这次写入的）被拒绝：抛错，WebUI 回 400，运行态与文档都不动；提交前就悬空、原样带回的不拦。
  - `getPluginConfig` 返回文档形态（引用，不是原值），插件要原值读自己的 `config`。`setPluginConfig` 遇到密钥字段上的非空明文抛错（宿主有密钥存储、且查得到该实例的 schema 时）。`save()` 先写密钥、再写文档。「调用方两边都写」的约定只剩启停与服务偏好。交给插件的 `set` 不能整块替换 `plugins`（会绕过上面的形态检查），宿主抛错；改插件配置用 `applyPluginConfig` 或 `setPluginConfig`。
- **WebUI**
  - `GET /api/plugins` 的 `config` 改为文档形态，密钥字段上是引用，不再回原值；顶层新增 `secretRefCounts`（键 → 引用处数）。宿主不提供 host-config 时给运行态配置并去掉密钥字段。`GET /api/config` 与 `GET /api/plugins/:name/config` 读的是文档，同样只有引用。
  - `PUT /api/plugins/:name/config` 与 `POST /api/plugins/:name/instances` 改经 `applyPluginConfig`。PUT 只改已登记的实例，没登记的照旧返回 404，不借 `applyPluginConfig` 新建（建实例走 POST）。
  - 改配置、启用、停用与新建实例几条路由统一为「回 2xx 即已写进配置文件」：已写入但插件激活失败（或没在宽限内停下）时，由 500 改为 200 `{ ok: true, message }`，原因在 `message` 里；按 0.19.0 一节的写法把 500 当作「已写入、激活失败」处理的调用方要改。没写成的情况照旧：400、404、409，以及落盘失败时带 `applied: true` 的 409、500（运行态已生效、文件没写成）。plugin-webui-client 认得 `applied`：新建实例在这种情况下也收起表单、刷新列表，不会再因重复点「创建」得到「已存在」；服务偏好切换同理会刷新卡片；插件配置页保存或删除实例出错后也刷新插件列表，与启停一致。停机进行中删除实例时，配置段照样从文件删掉、回 200，回执写明「停机中，未卸载运行中的实例」。拒写的回执改为「修好该文件后会按文件内容重载」，不再一律说成配置文件。
  - plugin-webui-client 的配置表单对已设置的密钥字段显示「已设置」和键名，不显示值；输入新值即替换，不动则保持原值，可清除、可撤销；顶层与分组字段的键被几处配置共用时提示替换会一并影响它们（数组元素里的替换另建新键，不提示）；map、list 上的密钥字段整个只写不回显；「恢复默认」保留顶层与分组里已存的密钥（数组整份换成默认值，元素里的密钥随之删除）；密码框不让浏览器自动填入登录口令。
- **第一方插件补标**
  - plugin-webui-server 的 `fixedToken` 标 `secret: true`。
  - plugin-mcp-client 的 `servers[].env` 标 `secret: true`：每个 server 的整份 `env` 是一个密钥，WebUI 里看不到变量名，要改就整份重填。token 放进 `env`，不要放进 `args`：连接成功时的日志会写出全部 `args`。`mcp_set_server_enabled` 改用 `applyPluginConfig`；可选依赖 `plugins` 从 `uses` 与 `package.json` 清单里删掉了。
  - plugin-memory-mongodb 的 `uri` 标 `secret: true`（连接串可能带账号密码），缺省连接串不再写进配置文档。旧配置里回填过的 `mongodb://localhost:27017` 也算明文，首次启动时同样移进 `secrets.yaml`。
  - adapter-onebot、asr-openai、embedding-openai、llm-deepseek、llm-openai、maimai、okx-trading、remote-agent-cursor、tool-system、websearch-serper 删掉了只为 `secret` 写的 `import type {} from '@aalis/api-webui'` 与 api-webui 开发依赖；works-site 删掉了这一行导入，api-webui 仍是它的正式依赖。其中 asr-openai、embedding-openai、llm-openai、maimai、okx-trading、websearch-serper 编译出的 JS 与类型声明因此不变（只差 source map 行号与 devDependencies），运行行为不变，本批不发版。
- **破坏性变更与迁移**
  - 第三方插件：`secret: true` 现在会让值搬进 `secrets.yaml`。只为了在表单上遮住、值并不是凭据的字段，去掉 `secret`。只为 `secret` 写的 `import type {} from '@aalis/api-webui'` 与 api-webui 开发依赖可以删掉；schema-config 与 api-webui 一起升级，否则类型上可能找不到 `secret`。对 `@aalis/schema-config` 的依赖写成范围、下限抬到本批的新版本：装到旧版时，悬空的引用按普通无效值处理，不会被拒。
  - 读写配置文档的插件：`getPluginConfig` 拿到的密钥字段是引用。把 `config`（或 `parseConfig` 的结果）经 `setPluginConfig` 写回的会抛错，改用 `applyPluginConfig`，或以 `getPluginConfig` 的文档为底只改目标字段再写回。此前「`updateConfig` 后 `setPluginConfig` 再 `save()`」的改配置写法，改为一次 `applyPluginConfig`。
  - 自己提供 `host-config` 的宿主要实现 `applyPluginConfig`。
  - 嵌入式宿主：`createConfigStore(initial, provider?, secrets?)` 的第三个参数是密钥存储 `{ values, provider? }`，`createFsSecretsProvider(absPath)` 是读写 `secrets.yaml` 的实现，类型 `SecretProvider`、`SecretStoreInit` 一并导出；不给第三个参数时行为与此前相同；给了密钥存储却没给它的 `provider.save`、配置又会落盘（给了 `provider.save`）时直接抛错，否则密钥只在内存里，重启后引用落空。`createPluginDiscovery(app, loader, doc)` 的第三个参数改为配置存储（要有 `resolvePluginConfig`，登记时由它解析引用），不再收 `HostConfig` 形状的对象。主配置与密钥文件的读写、拒写与监听改为同一份实现。
  - 读 `/api/plugins`、`/api/config` 的第三方前端与脚本拿到的是引用，不再是原值。
- **已有实例的升级步骤**
  1. 停掉实例，备份整个家目录。
  2. 按「必须同批升级的包」把 runtime、schema-config、api-host-config、plugin-webui-server、plugin-webui-client、plugin-mcp-client 一起升级。
  3. 第一次用新版启动时，`aalis.config.yaml` 里密钥字段上的明文自动移进 `secrets.yaml`，日志里每处有一行「配置同步：已把 <实例> 的 <字段> 移进 secrets.yaml（键 <键>）」。启动后看一眼配置文件，确认这些位置已换成引用。没装上或加载失败的插件，配置段不处理、明文原样保留（冷启动时逐段告警）：删掉这些段，或装好插件后再启动一次。
  4. 删掉明文的旧副本：编辑器的备份文件，同步盘或备份工具里的旧版本，家目录里迁移工具留下的 `aalis.config.yaml.before-schema-0.14` 等备份（启动验证后删掉）；配置文件进过 git 的，历史里仍有明文，应当轮换这些密钥。
  5. 备份从此要连同 `secrets.yaml`（0600）。只恢复 `aalis.config.yaml` 时引用落空：用 `parseConfig` 读配置的插件激活失败，`/doctor` 的 `config.secrets` 也会点名；按日志或诊断点名的键在 WebUI 重新填写，或在 `secrets.yaml` 里补上即可。
  6. 手改配置时，密钥照旧可以直接写成明文，下次热重载时会被移走（原处已有引用的，写回原来那个键，可以这样轮换密钥；共用这个键的插件一并换成新值，只想换其中一个时，把它的字段改成指向新键的引用，并在 `secrets.yaml` 里加上这个键）；要让几个插件共用一个密钥，把它们的字段写成指向同一个键的引用。
- **发布时要抬的下限**
  - runtime、plugin-webui-server 对 `@aalis/schema-config` 的下限，抬到含 `isSecretRef`、`mapSecretFields` 的新版本：旧版没有这两个导出，加载时报错。
  - plugin-memory-mongodb 对 `@aalis/schema-config` 的下限可以一并抬到新版本，只为改进报错：旧版的 `parseConfig` 遇到落空的引用同样拒绝激活（`uri` 声明了 `onInvalid: 'error'`），只是报 `uri` 期望 string、得到 object，不点名缺的键。
  - runtime、plugin-webui-server、plugin-mcp-client 对 `@aalis/api-host-config` 的下限，抬到含 `applyPluginConfig` 的新版本。

### 会话协议与会话服务（新包 @aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/api-checkpoint、@aalis/api-todo-list；@aalis/api-agent、@aalis/api-tools、@aalis/api-platform、@aalis/api-session-manager、@aalis/schema-message、@aalis/plugin-agent、@aalis/plugin-checkpoint、@aalis/plugin-todo-list、@aalis/plugin-adapter-onebot、@aalis/plugin-tool-onebot、@aalis/plugin-session-manager、@aalis/plugin-storage-local、@aalis/plugin-tool-system、@aalis/plugin-image-sender、@aalis/plugin-paper、@aalis/plugin-webui-server）

新 WebUI 的第一部分：owner 的客户端与守护进程之间改用一套公开的会话协议。旧的 `/ws` 与旧前端暂留，随新前端一起删除（见后续各节）。

- **会话协议**（新包 api-session-protocol，实验性）：JSON-RPC 2.0 帧、握手（主版本不同即断开并给原因）、错误码，以及会话列表、订阅与条目、回合控制的 zod schema，类型由 schema 推导；服务描述符 `sessionProtocol`，接口为 `connect(peer, send)`。第一版在终端客户端接入之前允许不兼容的修改，之后只做加法。第三方前端照 [api-session-protocol](docs/api/api-session-protocol.md) 实现即可。
- **会话服务**（新包 plugin-session-server）：
  - 会话列表分「我的」与房间两区，房间按适配器实例分组；状态有出错、完成未读、运行中；支持排序、搜索、分页，增量经 `sessions/changed` 推送。「我的」区的已读时间记在 `pluginData:/session-server/seen.json`，换设备一致。
  - 会话的新建、改名、归档（连同子会话）、删除与批量；会话配置一次给出生效值、继承来源与可选项。
  - 订阅一个会话先回快照（最近一页历史、在途回合已产出的条目），再推条目；推送带 `epoch` 与按会话递增的 `seq`，只用于去重，重连一律重新取快照。一条连接可以订阅多个会话。
  - 条目种类：用户消息、她的回复、思考、工具调用（exec 的输出边跑边推）、宿主通知、计划、用量、回合起止。房间里没发出去的话（静默、工具调用之前说的话）标「未发出」，经平台工具发进房间的消息在工具卡上标「已发到群」；这两种标记来自投递回执，刷新后历史里只保留「工具调用之前说的话」。
  - 历史由存档归并，归并逻辑从前端搬到服务端；`/clear` 或回滚改写历史时推 `session/resync`，客户端重新取快照。
  - 回合控制：发送（只有附件、没写文字的消息照常送出）、继续、停止（带 `turnId` 时只停那一轮）、压缩、回滚、清空计划。
- **回合 id**：agent 在回合开始时生成 `turnId`，贯穿 `agent:input:before`、`outbound:stream`、`tool:execute`、`token:usage` 与 `agent:turn:after`；工具调用由 agent 生成全局唯一的 `callId`（不用模型给的 id，几家模型的 id 在并发回合里会撞），写进工具结果的 `metadata.callId` 与时间线的 `tool_call` 段。工具参数是 `null`、数组或原始值时不执行，错误回给模型。
  - 破坏性：`agent:input:before`、`agent:turn:after`、`tool:execute`（另加 `callId`）、`StreamChunkMessage` 的 `turnId` 必填，自己实现 AgentService 或发这些事件的插件要带上；`AgentService.abort(sessionId, turnId?)` 改为返回是否停下。
  - api-tools 新增 `tool:output` 事件；schema-message 的 `OutgoingMessage` 与时间线 `tool_call` 段新增可选的 `callId`，`send_attachment` 与 `paper_send` 发出的消息带上它。
- **检查点**（新包 api-checkpoint）：`checkpoint` 服务描述符与回滚结果类型从 plugin-checkpoint 移出，契约只留 `beforeMutate`、`rollback`、`rollbackWithChat`。plugin-checkpoint 不再导出它们，自定义存储后端改为每次写入前直接调 `beforeMutate`（`isActive` 已删）。回合 id 就是 agent 的 `turnId`：同一会话并发的回合改同一个文件时按写入所在的回合归属，回合外的写入不再记账（此前记进所有在跑的回合，回滚会误删无关文件）；回滚时另有回合也改过同一文件，结果的 `alsoChangedBy` 列出它们；被入站钩子拦下的回合照样结束并提交；提交失败只告警，不再把已经回复成功的一轮变成错误。
- **房间按适配器实例路由**：api-platform 的 `resolvePlatformBySession` 改为返回带 `contextId` 的适配器条目（破坏性，原来的用法改成 `.instance`）；能装多个实例的适配器必须实现 `canHandle`。onebot 适配器按会话 id 里的账号认领自己的房间，配置里写明、还没连上的账号也认；认不出时报错列出已知账号与连接状态。session-manager 收录房间时记下 `originInstance`（只用于分组），回合结局为 replied 时记 `lastReplyAt`，最近一轮出错时会话状态记为 `error`。tool-onebot 改走平台路由，修好多实例时动作总发到第一个实例的缺陷；撤回、好友与加群申请按实例处理，自身禁言列表汇总所有实例。
- **待办**（新包 api-todo-list）：`todo-list` 服务描述符与 `TodoItem`、`todo:updated` 从 plugin-todo-list 移出（破坏性，不再从插件包导出）；工具关掉时也提供服务。
- **WebUI**：新增 WebSocket 端点 `/session`，用现有 token 认证后接到会话协议，只搬运文本帧；会话服务不在时以 1013 关闭并写明原因。WebSocket 的未知路径由 400 改为 404，未登录一律 401。
- **升级**：已有房间还没有 `originInstance`，等它下一次有消息进来时补记；在那之前列在所属平台下不归实例的一组里。不需要手动迁移。
- **发布档位**：次版本：api-agent、api-tools、api-platform、schema-message、plugin-checkpoint、plugin-todo-list、plugin-session-manager；其余为 patch。plugin-agent、plugin-session-manager、plugin-checkpoint、plugin-storage-local、plugin-session-server 对 api-agent、api-tools、schema-message、api-platform、api-checkpoint 的下限抬到本批的新版本。

### 审批（新包 @aalis/api-approval；@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/api-authority、@aalis/plugin-authority、@aalis/api-commands、@aalis/plugin-commands、@aalis/api-gateway、@aalis/plugin-gateway、@aalis/api-tools、@aalis/plugin-tools、@aalis/plugin-agent、@aalis/plugin-cli、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-session-manager、@aalis/create-aalis；删除 @aalis/plugin-session-confirm、@aalis/api-session-confirm）

需要确认的工具调用改为请 owner 审批：审批是一个有 id、有状态、成对审计的对象，只推给在场的 owner，任务绝不因等审批而挂起。旧的文本确认链（session-confirm、确认相位、确认通道、临时授予、`/auto`）整套删除。

- **谁能产生审批**：只有 owner 本人在自己会话里发起的回合，以及 owner 链的延续（后台任务完成后的续做）。子任务、定时任务与它触发的编排、房间里的回合（包括 owner 在 WebUI 里驱动房间）、群成员发起的回合，一律当场拒绝，不推给任何界面；房间里只回一句通用拒绝，不透露 owner 的文件布局。判据是回合的发起类别，不是 `actor`：owner 建的定时任务会把创建者回填成 actor。
- **在场才问**：WebUI 页面可见且 10 分钟内有键盘或指针活动，或终端 10 分钟内有输入，才算在场。没人在场时当场按拒绝回给模型，任务继续；等满 300 秒、或等待中在场的界面全部断开或转到后台，也立即按拒绝结算。只推给身份是 owner 的界面。
- **排队与上限**：同一会话的审批排队，一轮里并行的几次调用同一时刻只出一张卡；同一会话 10 分钟最多 10 张，超出的直接拒绝并说明。回合结束、中止或会话服务停用时，未结的审批按撤销结算。
- **应答**：先答先得，服务端核三件事：应答人是 owner、审批由本服务签发且未结算、内容哈希一致；后到的回 `approval-settled`。卡片只有批准与拒绝（可附理由），不设会话级或限时授予。
- **卡片上的事实**：逐字命令、工作目录、由 `file_edit`、`file_write`、`file_append` 参数生成的 diff；疑似密钥的内容只给路径。显示前清洗控制字符、ANSI 转义、双向控制符与零宽字符，截断保留首尾并写明省略多少，清洗函数 `sanitizeForCard` 在 api-approval 里供各界面共用。批准后执行的参数与卡上的事实逐字一致。
- **审计**：请求与决定成对追加到家目录的 `state/audit/approvals.jsonl`，记应答人、审批面（取登记身份，不取客户端自报）、决定来源、命中的规则、等待时长，不进模型上下文。
- **审批面**：WebUI 经 `/session` 连接、终端经 plugin-cli 登记审批面。终端里审批卡是模态的：←/→ 加 Enter 或 Ctrl+Y / Ctrl+N 应答，卡片在时打字与回车不算应答。
- **指令的确认**：声明了 `confirm` 的指令改为向发出者本人确认意图：只认这个人在这个会话里的下一条消息，`y` 确认，其余取消，60 秒超时；带 `source` 的注入直接拒绝。群成员用 `/clear` 清自己的记忆照常可用。指令插件停用或重载时，等待中的确认当即取消。
- **会话列表**：有未结审批的会话显示「需要我处理」，排在「我的」区最前；会话协议加 `presence/update`、`approval/respond`、`approval/requested`、`approval/settled`，快照带未结的审批，工具卡带 `approvalId`。
- **破坏性**：
  - api-authority 删掉 `isPreApproved`、`requestAccess`、`setConfirmHandler`、`listTemporaryGrants`、`revokeTemporaryGrant`、`revokeGrantsOfCapability`，以及 `AccessRequest`、`AccessDecision`、`TemporaryGrant`、`TemporaryGrantSpec`、`AccessConfirmHandler` 与配置项 `autoConfirmUntil`；新增 `InboundTurn`，`ExecutionGuardContext` 加 `turnId`、`callId`、`inbound`、`confirmIntent`。`restrictedPolicy` 只免掉会话档的确认，不放宽授权。
  - plugin-authority 删掉 `/auto`、`setAutoConfirm` 与 `revokeTemporaryGrant` 页面动作；`getOverview` 不再返回 `autoConfirmUntil`、`temporaryGrants`。
  - api-gateway 删掉 `inbound:confirm` 相位与 `INBOUND_PHASE.CONFIRM`，入站剩四个相位。
  - api-session-protocol 的 `SessionPeer.surface` 改为审批面登记得到的句柄。
  - plugin-session-server 现在必须有 host-paths 才能启动（审计写在家目录）。
  - plugin-session-confirm 与 api-session-confirm 删除；create-aalis 的预设不再含 session-confirm。配置里残留的 session-confirm 条目与 `autoConfirmUntil` 要手动删掉（宿主冷启动时会对没装上的插件配置段告警）。
- **发布档位**：次版本：api-authority、api-gateway、api-commands、api-session-protocol（实验性）、plugin-authority、plugin-commands、plugin-gateway、plugin-cli、plugin-session-server；其余为 patch。

### 管理推送、登录加固与会话文件（@aalis/api-webui、@aalis/plugin-webui-server、@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/schema-message）

新 WebUI 的第三部分：会话之外的变化改由推送送达，登录与 WebSocket 握手加固，会话里她发出的文件可以按句柄下载。旧的 `/ws` 与旧前端暂留，随新前端一起删除。

- **管理推送**：WebUI 新增 WebSocket 端点 `/admin`，用现有 token 认证，推四类事件：订阅后的实时日志（`log`）、插件状态或页面登记表变了（`plugins.changed`）、即将重启（`app.restarting`）、换了前端（`client.reload`）。前端发 `log.subscribe`、`log.unsubscribe` 订阅与退订日志。事件只是「变了」的信号，断线期间的不补发，重连后重取。类型 `WebuiAdminEvent`、`WebuiAdminClientMessage` 在 api-webui，第三方前端照 [api-webui](docs/api/api-webui.md) 的「管理面推送」一节实现。
- **来源校验**：`/ws`、`/session`、`/admin` 的握手与登录接口只收与本服务同源的浏览器请求，同一主机别的端口上的网页也算跨源，回 403；不带 Origin 的客户端（脚本、命令行）照常按 token。Origin 与 Host 去掉默认端口后再比。经反向代理访问时，代理要转发原始的 Host。
- **token 比较**：cookie、`?token=` 与登录接口都改为定时安全比较，耗时与 token 的内容和长度无关。
- **登录失败限速**：同一来源地址 10 分钟内登录失败满 10 次（`?token=` 与登录接口合计），到窗口结束前一律回 429，正确的 token 也不收；登录成功清零。本机回环同样计数（经同机反向代理来的请求都是回环地址）。别的网页借浏览器发起的登录（跨源的 POST、从别的站点打开的 `?token=` 链接）不比对也不计数，免得别人替你把地址锁住。带 cookie 的请求不计数，靠 token 的长度防猜。
- **会话文件**：她发到 WebUI 会话的文件，条目里给会话服务签发的句柄，不给存储地址；`GET /api/session-file?sessionId=&handle=` 按句柄下载，一律以附件、`application/octet-stream`、`nosniff` 下发。句柄绑定会话，只在会话服务这次启动内有效，重启后重新订阅即可拿到新句柄；伪造、改动过或别的会话的句柄回 403，文件已不在回 404。插件状态与插件私有数据两个根里的文件不签发。api-session-protocol 的 `SessionProtocolService` 新增 `resolveFile(sessionId, handle)`，自己实现会话服务的要补上。
- **WebUI 会话里的文件进入上下文**：发到 WebUI 会话、给的是存储地址的文件，改按 schema-message 新增的 `outbound-file` 记进会话历史（此前只记一行文件名的事件标记），因此会进入这个会话的模型上下文与向量记忆，与图片的做法一致；给的是网址或 data URL 的仍只记文件名。`outboundMediaMessage` 接受 `file`。
- **破坏性**：`tokenMode` 为 `fixed` 时，`fixedToken` 去掉首尾空白后至少要 32 个字符，短了插件不启动并写明原因（留空仍按 persist 处理）。**升级前配了短 token 的，先换成更长的随机字符串。**
- **发布档位**：次版本：api-webui、api-session-protocol（实验性）、schema-message、plugin-webui-server；plugin-session-server 为 patch。

### 新 WebUI：外壳、会话与插件登记的会话设置（@aalis/plugin-webui-client、@aalis/plugin-webui-server、@aalis/api-webui、@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/api-session-manager、@aalis/plugin-session-manager、@aalis/api-approval、@aalis/api-memory、@aalis/plugin-memory-summary、@aalis/api-tools、@aalis/plugin-tools、@aalis/plugin-tool-system、@aalis/api-agent、@aalis/plugin-agent、@aalis/api-persona、@aalis/plugin-persona、@aalis/plugin-memory-history、@aalis/plugin-memory-vector、@aalis/plugin-tool-session、@aalis/plugin-user-relation、@aalis/plugin-paper、@aalis/plugin-subtask、@aalis/plugin-checkpoint、@aalis/plugin-todo-list、@aalis/plugin-adapter-onebot、@aalis/plugin-cli、@aalis/schema-message、@aalis/schema-config、@aalis/create-aalis）

新 WebUI 的第四部分：前端整套重写，接上会话协议与管理推送；会话设置改由插件登记。旧的 `/ws` 协议与旧前端在这一批删除。插件管理、设置、运行状况与插件页面在后续各节补上。

- **外观与主题**：深浅两套，默认跟随系统。主题是独立的单位（名字、深或浅、一套颜色令牌），内置 8 个：偏中性、品牌柔和、文档站原色、安静中性各出深浅两个，默认跟随系统用偏中性。主题只改颜色，不改间距、圆角、字号与布局。令牌表 `THEME_TOKENS`、主题文件格式与 `parseTheme`、内置主题 `BUILTIN_THEMES`、对比度检查 `themeContrastIssues` 在 api-webui（实验性），以后导入第三方主题用同一套校验。首帧前写好主题，刷新不闪。
- **布局**：最左侧图标栏、左栏、主区、右侧面板（两侧栏宽在后面「隔离的插件前端」一节改为可拖动）；48em 以下是手机三层（按地址逐层进入，系统返回逐层退回），平板宽度两侧是覆盖式抽屉。不用卡片样式，圆角 4px 与 6px，阴影只给浮层。尺寸用 rem，跟随浏览器字号；触屏下控件自动放大。图标统一为线性图标，界面上没有 emoji。
- **会话列表**：「我的」与按适配器实例分组的房间，组默认折叠；组内只露出需要处理的与近 7 天她开过口的房间，其余收在「其余 N 个」里。房间组可以打开主区的房间表（`/rooms?instance=`），按类型与状态筛选、按列排序、批量归档与删除。底部有「已归档」，可以恢复。Cmd/Ctrl+K 搜索会话。
- **会话工作台**：时间线按条目渲染（流式、思考、工具卡、通知、回合分隔），每张可折叠；工具卡按工具声明的展示种类画命令或文件改动；审批卡挂在工具卡上，只有批准与拒绝（可附理由），出现时不抢输入框焦点、没有批准的快捷键，结算后收成一句写明结果、原因与时间，刷新后仍在；回合可回滚（两种范围都先确认）。头部有上下文用量百分比，点开是拆分表（桌面在右侧面板，手机从底部弹出），有压缩服务时写明压缩线、达到时换色。右侧面板有计划、设置、用量。输入框附件一律接收，只有附件也能发，正确处理输入法组字时的回车，触屏上回车换行、按钮发送。
- **会话设置由插件登记**：api-session-manager 新增 `registerSetting`、`listSettings`，设置项（字段、适用的会话种类、显眼程度、是否只按继承链实时解析）由拥有功能的插件登记，随它的激活撤回；`SessionConfig` 不再列具体的键，各插件经 declaration merging 加。没装或停用的插件的键原样保留，但不显示、不参与解析，重新启用后恢复。界面只列适用于这个会话种类的项：常用的在前，其余收进「高级」并按插件分组；每项显示生效值与来源，就地修改、改完即存，可以恢复继承。模型等 `composer` 档的项同时出现在输入框旁。登记的插件：agent（模型、深度思考、工具迭代上限）、persona（人设、额外提示、两个结构化输出开关）、tools（工具分组）、记忆与关系图等（召回范围，定义在 api-memory 的 `MEMORY_RECALL_SCOPE_SETTING`）、paper（白纸与远端代理六项，只对房间）。
- **会话种类与默认层**：api-session-manager 新增纯函数 `sessionKind`，给出 `owner`、`room`、`task` 三种（owner 自己的 QQ 私聊算房间），列表分区、设置项的适用范围与协议共用它。全局默认、平台档与受众条目改存宿主配置文档顶层的 `sessionConfig`（`defaults`、`platforms`、`audiences`），协议新增按层读写；保存失败时撤回并报错。
- **会话协议**：握手回包加 `features`（发送、回滚、压缩，按服务在场算出）与通知 `features/changed`；会话设置按登记项给出各行，新增 `session/config/layers`、`session/config/layer/get`、`session/config/layer/update` 与通知 `session/config/changed`；`sessions/list` 加 `instance`、`platform`、`archived`，新增 `session/unarchive`，`RoomGroup` 加显示名；工具调用条目加 `display` 与审批结算 `settlement`，用量条目加 `compressAt`，`approval/settled` 加 `source` 与 `at`；删除 `SessionSummary.paper` 与写死的配置字段、`options`。
- **审批**：在场的界面全部断开或转到后台之后，有 30 秒重连宽限，宽限内回来卡片照常等着（等待总时长仍是 300 秒）；发起时就没人在场的仍立即拒绝。审批结局（含发起时就被拒的）写进工具结果的元数据，刷新后历史显示真实结局，不再显示成「失败」。卡上的事实按工具声明的展示种类取（api-tools 新增 `display`，exec、exec_background、file_edit、file_write、file_append 已声明）；没声明的工具逐字列出全部参数。
- **压缩服务**：api-memory 新增服务 `compression`（`compress(sessionId, reason)`、`autoThreshold`），memory-summary 提供；手动压缩改调它，`session:compress` 事件删除。`autoCompressThreshold` 不在 0 到 1 之间时按不自动压缩处理并告警。
- **历史**：刷新后能还原「已发到群」、审批结局、平台没收下与重试丢掉的几版；重试的各版不再连成一条。静默或重复跳过的那一轮说的话不落库，只在实时推送里标「未发出」。
- **安全**：所有响应带文档级 CSP；改状态的请求（含页面动作、配置写入、插件启停、登录与注销）校验来源，同一主机别的端口上的网页发不进来；Markdown 不渲染原始 HTML，外站图片显示成链接、不发请求，链接只许 http、https、mailto；`/assets/` 下缺失的文件回 404。
- **修复**：agent 给发往模型的历史加时间标注时不再改写记忆服务交出的对象（用内存记忆后端时，会话历史里的用户消息此前会被永久加上时间前缀）。
- **删除**：旧 `/ws` 协议与它的全部推送；`/api/status`、`/api/tool-groups`、`/api/llm-models`、`/api/files*`、`/api/uploaded-files*` 与配置项 `fileRoot`（通用文件管理页不再提供）；session-manager 的会话页与 14 个页面动作、checkpoint 的 4 个、todo-list 的 2 个页面动作（都由会话协议取代）。webui 平台适配器仍然登记（平台名 `webui` 标明说话的是 owner），但不再经它收发消息。
- **破坏性**：
  - api-session-manager 删除 `ROOM_ONLY_CONFIG_KEYS`、`omitRoomOnlyKeys`、`sessionListSection`、`PlatformProfile`、`getPlatformProfiles`、`getDefaults`、`SessionTreeSection`，`MemoryRecallScope` 移到 api-memory；自研 session-manager 要实现设置登记与按层读写。
  - plugin-session-manager 不再有插件配置：`defaults` 与 `platformProfiles` 搬到宿主配置的 `sessionConfig`（见下面的升级须知）。
  - api-approval 的 `ApprovalSink.settled` 改为接收结算对象 `{ state, source, at }`。
  - api-memory 删除 `session:compress` 事件，改用 `compression` 服务。
  - 会话设置写入改为按登记的字段校验：没有登记的键被拒绝（例如没装人设插件时 `/session.set -p` 会失败），外来字段类型的设置项必须提供 `validate`，不适用于这个会话种类的项写不进去。
  - 第三方前端：旧 `/ws` 协议已删除，改按 [api-session-protocol](docs/api/api-session-protocol.md) 与 [api-webui](docs/api/api-webui.md) 的管理推送实现。
- **升级须知**：session-manager 插件配置里的 `defaults` 改放到宿主配置的 `sessionConfig.defaults`；`platformProfiles` 里不带 `audience` 的条目改放到 `sessionConfig.platforms.<平台>`，带 `audience` 的改放到 `sessionConfig.audiences.<平台>.<group 或 private>`；`think` 的 `'on'`、`'off'` 改成 `true`、`false`，空串与 null 删掉，`llm` 要 provider 与 model 都有才保留。会话库里每个会话自己的配置不用改。
- **发布档位**：次版本：api-session-manager、plugin-session-manager、api-session-protocol（实验性）、api-approval、api-memory、api-tools、api-webui、plugin-session-server、plugin-memory-summary、plugin-webui-server、plugin-webui-client、create-aalis；其余为 patch。只改注释的 api-doctor、plugin-doctor、plugin-llm-openai、plugin-commands 可以不发。

### 删除自档案（@aalis/plugin-user-profile、@aalis/schema-message）

user-profile 不再让模型反思自己的输出、生成「自档案」再注入回所有会话。

- **删除**：配置项 `enableSelfProfile`、`selfReflectEveryNMessages`、`selfReflectHistory`、`maxSelfFacts`，以及自反思与 `__self__:<人设名>` 档案的写入和注入；指令 `/profile.self` 与 `/profile.self.clear`；`user_profile_lookup` 的 `self` 参数，返回值不再带 `isSelf`。旧配置里的这四个键启动时按 schema 裁掉并告警。
- **跨会话补齐**：开着 `allowGlobalBackfill` 时，补齐「在场参与者」跳过平台段以 `__` 开头的保留键，旧版本留下的自档案不会被当成一位参与者注入。
- **升级须知**：存量的自档案不会自动清理。开过自档案的实例用 `/profile.forget __self__:<人设名> <事实id>` 逐条删；`/profile.clear.nuke` 也能清掉，但会连同全部用户档案。
- **发布档位**：plugin-user-profile 次版本；schema-message 只改注释。

### 页面契约第二版、插件页面与会话面板（@aalis/api-webui、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/api-storage、@aalis/api-publish、@aalis/api-checkpoint、@aalis/api-tools、@aalis/api-session-protocol、@aalis/schema-message、@aalis/plugin-session-server、@aalis/plugin-session-manager、@aalis/plugin-checkpoint、@aalis/plugin-agent、@aalis/plugin-tool-system、@aalis/plugin-llm-openai、@aalis/plugin-llm-deepseek、@aalis/plugin-paper、@aalis/plugin-publish-review、@aalis/plugin-works-site、@aalis/plugin-scheduler、@aalis/plugin-workflow、@aalis/plugin-authority、@aalis/plugin-skills、@aalis/plugin-doctor、@aalis/plugin-tool-browser、@aalis/plugin-user-relation、@aalis/plugin-file-reader、@aalis/create-aalis-plugin）

新 WebUI 的第五部分：插件页面换成第二版契约并全部迁移，右侧面板的宿主标签与插件标签合成一套；补齐会话工作台的几处细节，修掉命令卡与 Markdown 的显示错误。

- **页面契约第二版**（api-webui，实验性）：`webui.definePage({ key, title, icon?, placement?, order?, applies?, content | tabs, actions? })` 一次声明组件、数据源与动作，返回 `{ invalidate(componentId?, sessionId?) }`。
  - 三个位置：插件页（`/p/:instance/:pageKey`，用户可固定到图标栏）、设置（`placement: 'settings'`，界面在后续一节）、会话面板（`placement: 'session'`，`applies` 按会话判断是否适用，超时 2 秒按不适用）。
  - 五样组件：表格（客户端排序与搜索、`visibleWhen`、窄时只留标了 `primary` 的列、`detail` 宽时在右窄时进下一级）、关系图、键值 `info`、Markdown、按钮组；页面最外层可以排成标签页。嵌套最多一层，一屏最多 6 个组件、6 个标签。
  - 动作按效果分 `read`、`write`、`destructive`，可带输入（按声明的字段校验，行动作只收 `rowKey`）；`destructive` 由宿主弹确认，`confirm` 不能是空字符串。
  - 插件经 `webui.notify(notice)` 发提示，只有插件能撤回，随插件停用撤回。
  - 登记时按质量门槛校验（嵌套、组件数、引用的名字都存在、不认识的字段），不过就拒绝登记并记错误日志；数据源与动作经服务端闸门调用，只许调声明过的，返回形状不对的回 500 并告警。
  - 新增 `markdownCode`；管理面事件新增 `page.invalidate`、`layout.changed`；页面路由与布局记录的请求、返回类型在 api-webui。
- **全部页面插件同批迁移**：白纸（插件页两个标签，另有群会话面板）、作品审核、作品站、计划任务、工作流、诊断（每次运行后按结果发出或撤回提示）、浏览器、关系图与原始数据，权限与技能移到设置位置；file-reader 新增「上传的文件」会话面板；脚手架模板的页面示例改用 `definePage`。告警、待裁决数、部署失败、账本故障改发提示。几处失败不再报成功：删技能、关浏览器页、立即执行计划任务（找不到任务或这一轮还没执行完时报错）、编辑已经不在的计划任务、删除上传文件（存储删不掉时报错并保留，文件本来就不在时当作删掉了）。
- **WebUI 服务端**：删除 `/api/page-action`；`/api/pages` 改为 `{ pages }`；新增数据源与动作路由、`/api/session-pages`、`/api/page-file`、`/api/layout`。页面单元格里的文件改用 webui-server 签发的下载句柄，私有存储根不签发，判定规则 `canIssueFileHandle` 在 api-storage，会话服务共用。固定记录与会话面板记录存在 webui-server 的插件数据里，按操作写、只认 owner，变化推 `layout.changed`。
- **会话面板的标签合成一套**：计划、设置、用量（api-webui 的 `HOST_PANEL_TABS`）与插件的会话面板页记在同一张表里，各带开关、按表的顺序排；当前标签可以关闭，关掉的从「+」重新打开并回到原位；读出时补齐缺的宿主标签、丢掉认不出的；连同宿主标签最多 50 个。用量百分比与输入框旁的设置项在标签关着时先把它打开。
- **会话**：握手回包加应用名（取宿主配置的 `name`，标签页标题与房间里她的回复用它）；已归档的会话跑一轮仍是归档，只有手动恢复才回到列表；审批卡完整显示命令、参数与 diff；模型生成参数期间就出现「正在生成」的工具卡（schema-message 的 `toolCallProgress` 加 `callId`，openai 与 deepseek 同一帧有几个调用就各报一次），没执行的在回合结束时收尾；新增 `turn/checkpoint`，回滚确认在这一轮执行过命令时写明命令的效果不会撤回；用量拆分表加堆叠进度条、图例、「剩余」与压缩线；设置值按可选项的标签显示，没设的显示默认值；登录页按主题令牌重写，深浅跟随系统。
- **工具卡的结局**：api-tools 的展示种类 `command` 可以声明退出码取自结果的哪个键（exec 已声明），退出码不为 0 时卡片记为失败并写「退出码 N」，结果被截断时照样认得出；协议的工具调用状态新增 `aborted`：回合被停止时还没结束的调用，以及历史里没有结果的调用，显示「已停止」，刷新后仍在。
- **Markdown**：单个 `~` 不再是删除线；行内公式按成文规则认（开头的 `$` 右边紧跟非空白，结尾的 `$` 左边紧跟非空白、右边不紧跟数字或 `$`），「$5 和 $10」这类金额不再被当成公式，`\(x\)`、`$$x$$` 照常；代码块（含流式中还没闭合的）、行内代码与链接地址里的 `$` 原样保留；触屏上代码块的复制按钮不再压住第一行。
- **破坏性**：
  - api-webui 删除 `registerPage`、`registerAction`、`getPages`、`renderer`、内联 SVG 图标、`refresh`、`danger`、组件 `stat`、`form`、`tabs`、`searchable`、`WebuiFilePayload` 与关系图类别的 `color`；第三方页面插件改用 `definePage`，写法见 [api-webui](docs/api/api-webui.md)。
  - api-checkpoint 的 `CheckpointService` 新增必须实现的 `execUsed(sessionId, turnId)`；api-publish 的 `PublishService` 新增必须实现的 `thumbnailUri(id)`。自己实现这两个服务的要补上。
  - plugin-file-reader 的 `deleteFile` 删不掉时改为抛错。
  - plugin-webui-server 删除配置项 `relationGraphDefaultSpacing`。
- **升级须知**：webui-server 的 `relationGraphDefaultSpacing` 改放到 user-relation 的 `graphSpacing`（含义相同，默认 120，范围 20 到 1000，超出按默认）。
- **发布档位**：次版本：api-webui、api-publish、api-checkpoint、api-storage、api-tools、api-session-protocol（实验性）、schema-message、plugin-webui-server、plugin-webui-client、plugin-session-server、plugin-user-relation、plugin-file-reader、create-aalis-plugin；其余为 patch。只改注释的 api-llm 可以不发。各页面插件对 api-webui 的依赖下限抬到带 `definePage` 的版本。

### 隔离的插件前端、顶部横线贯穿与两侧栏宽拖拽（@aalis/api-webui、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/create-aalis-plugin）

新 WebUI 的第六部分：插件页面默认仍是声明式，声明式表达不了时可以带自己的前端，在隔离的框架里显示；外壳的顶部横线贯穿各栏，两侧栏宽可以拖动。

- **插件前端**（api-webui，实验性）：`definePage` 多一种形态，`frame: { module, entry?, host? }` 加 `sources`，与声明式的 `content` 二选一；位置只有插件页与会话面板（设置位置只收声明式），动作不收 `row`；数据源与动作的输入按声明推导。登记时从 `frame.module` 往上取最近一个带 `name` 的 `package.json` 作包根，`name` 要等于插件名，入口要在包的 `webui/` 目录里，数据源名与动作名不超过 128 个字符。
- **托管与隔离**：webui-server 新增 `GET /frames/:token/*`（每次登记随机一个 token，撤回或重新登记后旧的作废）与 `/frames/_base/*`（助手与样式基线）。不要登录，只收 GET 与 HEAD，扩展名白名单与 realpath 两道检查，不合一律 404、不发重定向；响应带框架 CSP 与 `sandbox`、`nosniff`、`no-referrer`：脚本只认插件自己打包的文件与 `/frames/_base`，框架里不能再嵌别的网页（`frame-src`、`object-src` 为 `none`），其余（样式、字体、图片、音视频与数据请求）可以联网（单元 7 第六步按看板定论放开）。iframe 只给 `FRAME_SANDBOX` 的权限，与宿主不同源，读不到宿主的 cookie 与页面，宿主接口不认框架的请求。以 IPv6 字面地址访问时不显示插件前端。
- **消息通道**：宿主在地址片段里放一个随机数，框架带着它握手，之后改走专用端口；协议版本主版本不同时不挂载。数据源、动作与宿主数据能力都由宿主转发，实例、页面与会话一律取挂载时的值。外链与 destructive 动作经宿主画的对话框，同一时刻一个，打开后 500 毫秒内不接受确认，确认框列出这次的输入值，连续取消 3 次就停止显示这个页面；外链经对话框里的真实链接打开，与宿主同源的地址不收。框架离开自己的地址、每秒超过 200 条消息时立即卸载并显示占位。错误码是封闭集合。消息校验纯函数 `parseFrameHello`、`parseFrameMessage`、能力表与能力词表（第一版 `sessions:read`、`turn:abort`）在 api-webui，第三方宿主前端共用。
- **助手与样式基线**：`/frames/_base/frame.js` 的 `connect()` 负责握手、主题令牌、请求配对与离开时通知宿主，类型是 `FrameClient`；`/frames/_base/frame.css` 只给元素级样式，颜色取主题令牌。两者随 api-webui 发布在 `dist/frame/`。
- **界面**：框架上面写一行「来自 <插件显示名>」，手动刷新就是重新挂载；握手完成前不显示，第一次加载后 10 秒没有回应时写明「页面没有响应」；插件推来的 `invalidate`、重连与主题切换都转发给框架。
- **脚手架**：create-aalis-plugin 在「提供 WebUI 页面」之后多一问「页面用自带前端？」，选了就生成不用构建的 `webui/index.html` 与 `webui/main.js`（一个数据源、一个 destructive 动作），`files` 加 `webui`。
- **顶部横线与两侧栏宽**：各栏头部同一高度、同一条下边线，横线从图标栏贯穿到右侧面板，声明式页面里的标签栏同高。左栏与右侧面板常驻时可拖动分隔条调宽（左 13.75–25rem，右 18.75–37.5rem），方向键与 Home、End 可调，双击恢复默认，拖到下限以下松手即收起，再展开回到收起前的宽度；窗口变窄时两侧按比例收，主区至少留 30rem；覆盖式抽屉按记住的宽度打开。栏宽连同收起状态按设备记在本浏览器（`aalis.panels` 的形状改为每侧 `{ open, width? }`，旧记录按默认读）。连接状态横条移到窗口顶部，横跨图标栏与各栏。
- **文档**：插件作者指南新增「界面：声明式页面与插件前端」，列出插件能放在哪、不能放在哪与理由；联网搜索后端由插件自己登记 `web_search`、`search_images`，与 plugin-websearch-serper 二选一。安全模型新增「WebUI 的插件前端」。
- **破坏性**：api-webui 的 `PageView` 与 `PageDefinition` 改为声明式与插件前端两种的联合，读 `content` 前要先按 `frame` 区分；`definePage` 多一个泛型参数。第三方前端照 [api-webui](docs/api/api-webui.md) 的「插件前端」一节实现框架挂载与转发，不实现的显示占位即可。
- **发布档位**：次版本：api-webui（实验性）、plugin-webui-server、plugin-webui-client、create-aalis-plugin。

### 控件与文字的比例（@aalis/plugin-webui-client、@aalis/api-webui）

按钮等控件按所在文字的比例重新定尺寸，一行文字旁的按钮不再比文字重太多。

- **桌面**：按钮、图标按钮、输入框与选择框统一 28px 高，同一处的控件同高；有底色的按钮字重改为常规，文字按钮保留中粗。
- **触屏**：有底色的按钮看得见 36px，所有可点元素的点按范围不小于 44px，由伪元素补足，不把按钮画大；设置行同高；手机顶栏图标统一 16px。
- **插件前端样式基线**（`/frames/_base/frame.css`）：按钮与输入框跟宿主一致（28px 高、字重常规）；触屏上按钮外面一圈透明边框补到 44px，占排版位置，列表里相邻两行的点按范围不重叠；输入框与选择框触屏 44px 高、字号 16px。插件改写按钮的边框，或用简写 `background` 换底色时，触屏上底色会铺满 44px。
- **发布档位**：plugin-webui-client、api-webui 随本批的次版本，不另计。

### 插件区与设置，深度思考按模型的档位（@aalis/api-webui、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/api-llm、@aalis/plugin-llm-deepseek、@aalis/plugin-llm-openai、@aalis/plugin-llm-ollama、@aalis/api-agent、@aalis/plugin-agent、@aalis/api-session-manager、@aalis/plugin-session-manager、@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/api-package-manager、@aalis/plugin-package-manager、@aalis/plugin-media、@aalis/plugin-memory-summary、@aalis/plugin-user-profile、@aalis/plugin-user-relation、@aalis/plugin-adapter-onebot）

新 WebUI 的第七部分：插件的管理搬进插件区，设置有了自己的目录；深度思考改为按每个模型声明的档位来选。

- **入口**：图标栏底部与手机第一层新增「插件」「设置」。点已在的一区收起或展开左栏；左栏是抽屉的宽度下，插件区的空白页另有「打开插件列表」。
- **插件区**（`/plugins`）：
  - 左栏是实例树，按插件声明的 `subsystem` 分组，没声明的归「其他」，多开的实例挂在插件下面；正常运行的行不写状态，缺服务、失败、已停用写一句原因；顶上是「市场」与「只看有问题的」。
  - 插件详情由宿主拼装：头部写包名、版本、状态与原因，可以停用、启用、重载、卸载，多开的其余实例另有「移除实例」；配置按插件的 schema 画表单，只提交改了的项，写法不对时逐项写在控件下面，插件失败时也能改并重新激活；密钥只写不回显，写「已设置」加「更换」「清除」；「依赖与贡献」列出缺的服务与已装没启用的提供者（一键启用写明是哪个实例）、它提供的服务、工具与指令；「实例」可以新建与移除；「页面」列出它的全部页面与位置，插件前端另写申请的宿主数据能力。
  - 市场搬到插件区（`/market`），按类型（插件、前端界面、系统组件、全部）、状态与关键词筛；装卸前列出一并装上的包、要用的服务与依赖它的插件；装上插件后跳到它详情的配置区。
  - 页面所属插件停用时的占位与「会话服务未启用」都链到对应的插件详情，会话面板里同样。
- **WebUI 服务端**：
  - 插件列表新增 `subsystem`、`version`（按包名查本地安装）、`missing`（此刻没有提供者的必需服务）与 `self`（提供这个界面的插件），删掉 `capabilities` 与 `uses`。
  - 新增 `POST /api/plugins/:name/reload`，失败的插件重载即重试，已停用的回 409。
  - 不能经自己的接口停用或卸载 webui-server（回 409），重载照常；webui-server 的 `port` 须是 0–65535 的整数、`host` 不能是空白，保存这类值直接回 400，不再让界面起不来。重载自己后，承载那次请求的连接应答完即关闭，后面的请求落到新实例。
  - 删掉 `GET /api/service-groups` 与 `GET /api/llm-providers`；`/api/models/llm` 只回 `{ providers }`，其中的 `contextId` 改为提供者的实例 id，修好会话里切换模型时解析不到模型的问题。
  - `GET /api/config` 改为 `{ config, schema, restartKeys, home }`，不再回整份配置文档；`PUT /api/config` 只保存，回执带 `restartNeeded`，重启改走新增的 `POST /api/restart`。
  - 新增 `GET /api/themes`（插件提供的主题）；可选项来源新增 `llm-thinking`，按查询参数 `dependency` 里的模型给出它的档位，默认档带 `default: true`。
  - 市场安装的回执带 `plugin`（装上的插件的主实例 id）。
- **设置**（`/settings`）：宿主的分节与插件的分节（`placement: 'settings'` 的页面）在同一个目录里，插件的分节刷新后仍在。
  - **会话默认**：按层读写会话设置，行与会话面板的设置相同，只来自插件的登记；层的选择里，平台档来自已装适配器的平台加上配置里写过的，群与私聊条目按适配器的 `sessionTypes` 出；选中的层消失后回到全局默认。会话服务不在时这一节不出现，插件列表没取到时写明原因并可以重试。
  - **外观**：跟随系统时深浅各选一个主题；主题可以导出成文件、改了再导入，导入时拒收令牌表外的名字、带 `url()` 的值与超过 16 KB 的文件，缺的令牌按偏中性补齐，对比度不够的列出但仍可用；插件经 api-webui 的贡献点 `webui:theme` 提供主题，插件停用后正在用的回到同深浅的偏中性，插件回来后自动换回；导入或插件的主题照样推给插件前端。快捷栏可以上移、下移、取消固定；会话面板的标签可以上移、下移、显示、隐藏，插件的标签另可「移出」（布局操作新增 `remove-tab`，宿主标签不收）。
  - **系统**：宿主配置每项写明来源（配置文件或默认），要重启的键标「重启后生效」，改了之后出现「改动重启以生效」与「重启」；服务偏好（有两个以上提供者或写过偏好的服务，含切换界面前端）；家目录路径。
- **深度思考的档位**：
  - api-llm：模型经 `thinking` 声明允许的档位（由浅到深，至少两档）与默认档，`ChatModelRequest.think` 改为档位 id，没带时按模型的默认档；新增 `requestedThinking`（带了模型没有的档位时抛错）与 `lightestThinking`（模型最浅的一档）。
  - DeepSeek：能思考的模型声明「关、高、自动、最高」四档；实例配置的 `thinkingMode`、`reasoningEffort` 合成默认档 `thinking`（`off`、`high`、`auto`、`max`）；模型名称去掉「(thinking)」后缀。
  - OpenAI：`thinkingParam` 改为选写法。`reasoning_effort` 写法下档位按模型族给：gpt-5.1 起为关、低、中、高（默认关），gpt-5 为最低、低、中、高（默认中），其余能思考的为低、中、高（默认中）；o1-mini、o1-preview 与 gpt-5-chat 不声明档位。`thinking` 写法为关、开。请求带了档位才发字段。
  - Ollama：只有能思考的模型声明「关、开」两档、才发 `think`；实例的 `thinking` 改为默认档（`off`、`on`）；能力探测失败时，qwen3、deepseek-r1、gemma4 按家族表仍可调。
  - 会话设置「深度思考」改为下拉，可选项按这个会话生效的模型现取（设置项登记新增 `dependsOn`，协议的设置行带上它，会话默认里按这一层的模型取，输入框旁的快捷切换同样）；没设时写出默认档；换到没有这一档的模型时按默认并写明，模型不能调时写「当前模型不能调」。`/session.set -t <档位>` 按当前模型校验，`/session` 列出当前模型的档位。
  - 摘要、标题、画像与关系抽取、合并转发摘要、识图这些压低思考的调用改用模型最浅的一档；media 的 `vision.think`、`audio.think` 开启时按模型的默认档。
- **设置行与表单**：插件配置、页面动作与设置行按字段类型共用一套控件，动作表单里的开关改为标签在上；保存中编辑控件不可用，连着勾多选不再丢项；Safari 与 iOS 上点模型旁的刷新不再收起编辑；设置正文、插件详情与市场最宽 45rem。
- **破坏性**：
  - api-llm 的 `ChatModelRequest.think` 从布尔改为档位 id；api-agent 的 `SessionConfig.think` 改为档位 id。自己实现 LLM 提供者的，要声明 `thinking` 才能被调档，把档位翻成自己的线上字段前先过 `requestedThinking`；调用方压低思考改带 `lightestThinking(model)`。
  - api-package-manager 的 `install()` 回 `InstallResult`，自己实现包管理服务的要带上 `plugin`。
  - plugin-webui-server 删除 `GET /api/service-groups`、`GET /api/llm-providers`，插件列表删掉 `capabilities` 与 `uses`，`GET /api/config`、`/api/models/llm` 的回包与 `PUT /api/config` 的行为如上；第三方前端照 [plugin-webui-server](docs/plugins/plugin-webui-server.md) 的 REST 表改。
- **升级须知**（配置改名，旧键不再认）：
  - DeepSeek 实例删掉 `thinkingMode`、`reasoningEffort`，改写 `thinking`：原来 `thinkingMode: disabled` 的写 `off`，其余按原来的 `reasoningEffort` 写 `auto`、`high` 或 `max`。原来 `thinkingMode: enabled` 会对没标思考的模型也强开，要保留就在 `modelCapabilities` 里给这些模型加上 `thinking`。
  - Ollama 实例的 `thinking: true` 改写 `on`，`false` 改写 `off`。
  - OpenAI 实例的 `thinkingParam: false` 删掉即可（缺省就是 `reasoning_effort`），`true` 改写 `thinking`，并在 `modelCapabilities` 里给经这个实例的思考模型加上 `thinking`。
  - 会话设置里的 `think`（会话的覆盖与宿主配置 `sessionConfig` 的各层）从布尔改成那一层生效模型的档位 id；拿不准模型时删掉，按模型的默认档。旧的布尔值读到时当作没设置，并告警一次。
  - media 的 `think` 开启时原来对 Ollama 强开思考，现在按 Ollama 实例的默认档；实例默认档是 `off` 时识别不再思考，要思考就把实例默认档设成 `on`。
- **发布档位**：次版本：api-llm、api-agent、api-session-manager、api-session-protocol、api-webui、api-package-manager、plugin-webui-server、plugin-webui-client、plugin-llm-deepseek、plugin-llm-openai、plugin-llm-ollama、plugin-agent、plugin-session-manager、plugin-media；其余为 patch。只改注释或说明的 api-hooks、api-trigger、plugin-trigger-laya 可以不发。

### 需要处理、运行状况、用量与体验补齐，管理面 REST 契约（@aalis/api-webui、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/api-llm、@aalis/plugin-llm-deepseek、@aalis/plugin-llm-openai、@aalis/plugin-llm-ollama、@aalis/api-agent、@aalis/plugin-agent、@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/api-session-manager、@aalis/plugin-session-manager、@aalis/api-media、@aalis/plugin-media、@aalis/api-memory、@aalis/plugin-memory-summary、@aalis/plugin-mcp-client、@aalis/plugin-persona、@aalis/plugin-tools、@aalis/plugin-paper、新包 @aalis/plugin-usage-stats）

新 WebUI 的第八部分：要处理的事汇总到一处，有了运行状况页与用量统计；时间线与输入框补齐体验；管理面 REST 成为公开契约。

- **需要处理**：webui-server 把未结的审批、插件故障（失败与缺服务）和插件的提示汇总成一个列表（`GET /api/attention`，类型 `AttentionItem`、`AttentionResponse`），变化时经 `/admin` 推 `attention.changed`。首页上方（手机上在第一层顶部）的摘要最多五条，空了不出现；插件详情头部之后列这个插件的提示；标签页标题的数改为「需要处理」加「我的」区完成未读，都为 0 时只写应用名。重取失败时留着上一次的结果并写明「没刷新成功」。
- **MCP 连不上的提示**：plugin-mcp-client 可选使用 webui-server，某个 MCP 服务器连不上时发一条 error 提示（标题写服务器、说明写原因、跳转去配置），改好配置重载后撤回。
- **运行状况**（`/health`）：概况列出全部需要处理的事与平台连接；日志标签（`/health/logs`）有「只看错误」「审批」两个预设，级别、插件、文字的筛选写进地址，可以往前翻更早的日志。图标栏底部与手机第一层新增「运行状况」，角标是需要处理的数（只有它带角标）；插件详情头部新增「查看日志」。
- **日志的筛选**：`/api/logs/tail`、`/api/logs/range` 按 `level`、`plugin`、`text` 在服务端筛，写法不对回 400；`/admin` 的 `log.subscribe` 可以带 `filter`，只推符合的行，再订阅一次换掉筛选。按插件筛时认这个实例与它分出的子作用域。plugin-session-server 每个审批结算记一行 info 日志（会话、工具、结局、原因）。
- **用量统计**：
  - api-llm：请求可以带 `purpose`、`sessionId`，经 `llm` 的绑定接口调用时 `caller` 由宿主填成调用方这次激活的实例；服务商登记模型时套 `metered(model, events)`，每次调用拿到用量就发 `llm:usage`（`LLMUsageEvent`），服务商回的数不合规时不记；新增可选的余额查询 `LLMModel.balance()` 与 `LLMBalance`。三个第一方服务商都已套上，新增必需服务 `events`；目前都还没有实现余额查询。
  - 调用方带上用途与会话：对话与子任务（plugin-agent）、摘要（plugin-memory-summary）、识图与转写（plugin-media，api-media 的 `DescribeInput`、`DescribeImageOptions`、`TranscribeInput` 加 `sessionId`）。
  - 新包 plugin-usage-stats：把每次调用记进家目录 `state/usage/llm-calls.jsonl`（只追加、启动时按行读回、不自动清理），「用量统计」页按天、按周、按模型列 token，配置了单价（`prices`，每百万 token 的「输入, 缓存命中, 输出」）时估算费用，服务商实现了余额查询时多一个「余额」标签。不在任何档位里默认安装。
  - 用量拆分表的行名与次序由产出方给：api-agent 的 `token:usage` 新增 `parts`（`TokenUsagePart`），协议的 `usage` 条目用 `parts` 取代 `breakdown` 与 `injectors`，客户端照条目画行、不再依赖 api-agent。
  - 每轮回复下面那行写这一轮的输入与输出 token（协议回复条目的 `model` 加 `promptTokens`、`completionTokens`），实时与刷新后一致。
- **时间线**：连续 3 个以上的工具调用收成一行（按展示种类计数，有待审批、失败或运行中的不收，被停止的照收，还在跑的这一轮末尾那一组不收），点开才渲染；没有回复的一轮写「没有回复」，连续几轮合成「N 轮没有回复」（刷新后不还原）；连对话一起回滚时那一轮的提问放回输入框，不自动发；文件与成品一行写名字与类型，文本类可以预览（512 KB 以内）；图片取不到时显示替代（时间线、Markdown、页面单元格）；代码块上方一条标题行写语言名与复制按钮；回合进行中头部有运行指示；认不出的展示种类走通用卡。
- **输入框**：快捷切换只写值，名字在读屏标签与悬停提示里；草稿按会话存在本浏览器（最近 50 个会话），切会话与刷新后恢复，发出后清掉；文件可以拖进会话成为附件；会话连接反复被来源校验拒绝而登录正常时，连接横条提示检查反向代理是否转发了原始 Host。
- **选择器**：一种能过滤（10 项起出现过滤框）、手机上从底部弹出的选择器取代全部原生选择框；菜单与选择器在打开着的对话框里也能用。
- **设置行**：api-session-manager 的 `SessionSetting` 新增 `unset`，写这一项没设又没有默认值时的含义，协议的设置行带上它，session-manager 拒收空串；第一方设置项都写上了（「最大工具迭代」与「人设」的默认值取插件配置）。深度思考的档位当前模型没有时写那一档的名字与默认档名（`/api/models/llm-thinking` 另回 `labels`，`label` 不再带「（默认）」）。触屏上「恢复继承」与名字对齐。房间表下面一句话指去「会话默认」。
- **搜索**：⌘K / Ctrl+K 在会话之外也按名字找有自己地址的页面与插件（显示名、包名、实例 id），分三组列出；会话服务不在时照样找页面与插件。
- **声明式表格**：纯数字的列按这一列最多的小数位补齐（最多 3 位），数字按千位分组，表头文字与数字右对齐。
- **管理面 REST 契约**（api-webui，实验性）：全部路由的请求与回应类型进 `rest.ts`（`WebuiRestRoutes`、`WebuiFileRoutes`、`WebuiRestResponse`），市场的类型一并移入；webui-server 一律经 `route()` 按契约登记，响应编译期受约束，守卫与走查用例逐条核对实际登记的路由。失败一律回 `ErrorResponse`（请求体不是 JSON、路径参数解不开、处理时出错也是），不再回带堆栈的 HTML。插件区左栏头部新增「重新扫描插件目录」。webui-server、session-server 与会话协议的源码加上只认契约不认插件的守卫。
- **破坏性**：
  - api-session-protocol 的 `usage` 条目删掉 `breakdown`、`injectors`，改读 `parts`。
  - api-webui 的 `PageErrorResponse` 改名为 `ErrorResponse`（多一个 `applied`）。
  - plugin-webui-server 删除 `GET /api/plugins/:name/config`（插件列表每项已带同样形态的 `config`）与 `POST /api/config/save`（写路由都自己落盘）；`PUT /api/config` 带核心键以外的键回 400，回执去掉 `ignored`；`/api/models/<服务>` 的通用来源只回 `{ models }`；登录、来源校验与服务偏好的错误回应去掉 `ok: false`。第三方前端照 [api-webui](docs/api/api-webui.md) 的「管理面 REST」一节改。
  - 自己实现 LLM 服务商的，登记模型时套 `metered` 才会被记账；不套照常能用，只是不记。
- **发布档位**：次版本：api-webui、api-llm、api-agent、api-session-protocol、api-session-manager、api-media、plugin-webui-server、plugin-webui-client、plugin-session-server、plugin-llm-deepseek、plugin-llm-openai、plugin-llm-ollama、plugin-mcp-client；plugin-usage-stats 首发 0.1.0（对 api-llm 的依赖下限抬到本批的新版本）；其余为 patch。只改注释的 schema-message 可以不发。

### 后台任务：可转后台的工具调用与「后台」标签（@aalis/api-tools、@aalis/plugin-tools、@aalis/plugin-tool-system、@aalis/plugin-tool-code-runner、@aalis/plugin-office、@aalis/plugin-draw、@aalis/api-media、@aalis/plugin-media、@aalis/plugin-mcp-client、@aalis/api-checkpoint、@aalis/plugin-checkpoint、@aalis/api-authority、@aalis/schema-message、@aalis/api-agent、@aalis/plugin-agent、@aalis/plugin-adapter-onebot、@aalis/api-session-manager、@aalis/plugin-session-manager、@aalis/plugin-subtask、@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/api-webui、@aalis/plugin-webui-client）

新 WebUI 的第九部分：耗时的工具调用不再挡住对话。声明了可转后台的工具在前台等一段时间还没结束，就转到后台继续跑，她先回复，结束时再接着说；会话面板新增「后台」标签，可以看输出、停止。

- **转后台**（api-tools、plugin-tools）：工具定义可以声明 `background`（可带 `yieldSeconds`，缺省 30 秒）。执行器给声明了的工具的参数表补两项：`waitSeconds`（前台最多等多少秒）与 `runInBackground`（立即转），执行时先取出，审批事实与工具拿到的参数里都没有它们；参数表里已有同名项的工具当作没声明。过了守卫之后先在前台等，在前台时回合中止一并中止它；到时没结束或要求立即转的，对话回合里的调用登记成后台任务，先回给模型任务 id 与已有输出的末尾，此后停止键与新消息打断都不动它。不在对话回合里的调用（workflow 的工具节点、mcp-server）没有可以通知的对话，到时中止并回报已有输出。调用上下文新增输出口 `output`，进度写进它，执行器转成 `tool:output`（一次调用最多推 64 KiB）并留进输出缓冲。
- **后台任务登记**：新服务 `background-tasks`（描述符 `backgroundTasks`，类型 `BackgroundTask`、`BackgroundTaskService`）可查、可取输出、可停，变化发 `background:changed`；共用的结局判据 `toolFailed`、`integerIn` 与参数名判据 `takenBackgroundParams` 进 api-tools。结局：结果带 `error` 或命令的退出码不为 0 为失败（退出码记在任务的 `exitCode`），被停止为 `stopped`，工具撤回、插件停用、重启时还在跑的为 `aborted`。同一会话里对话回合中在跑的可转后台调用最多 `background.maxPerSession`（默认 4，前台与后台一起数），满了时在过守卫之前就拒绝；守卫拒绝或抛错都让出名额。登记写进插件数据 `pluginData:/tools/background-tasks.json`（不记输出与结果，每个会话留最近 20 条结束的），重启后读回，还在跑的落成 `aborted`。新配置 `background.maxWaitSeconds`（默认 600，最大 2147483）与 `background.maxPerSession`。
- **四个后台任务工具**：可见的工具里有可转后台的时，模型多拿到 `background_list`、`background_output`、`background_wait`、`background_stop`，按会话放行：本会话里谁起的任务都看得到、停得了，别的会话里的回「不存在」（单元 7 第六步定）。
- **结束通知**：后台任务正常结束（含失败）时向起它的会话注入一条宿主通知（`hostNotice.kind` 为 `background-task`），身份取起它的那次调用，正文只写任务 id、工具名、结局与退出码、用时；回复时引用起它的那条消息（`InboundTurn.messageId`、`hostNotice.replyTo`、`OutgoingMessage.replyTo`，OneBot 只给第一条分条加引用段）。由结束通知开的回合里转后台的不再通知；被停止、被中断、停机期间结束的不通知。
- **第一方工具**：exec、http_download（plugin-tool-system），run_python、run_javascript（plugin-tool-code-runner），pdf_convert（plugin-office），draw_image、draw_animation（plugin-draw），analyze_image（plugin-media）与 MCP 桥进来的工具声明可转后台，并跟随中止信号（api-media 的 `DescribeInput`、`DescribeImageOptions` 加 `signal`）；pdf_convert 与 GIF 编码去掉固定的 60 秒。MCP 工具的请求超时交给让出时限，参数撞名的仍用 SDK 默认的 60 秒。代码执行的脚本非零退出或被信号结束算失败（结果带 `error`）。
- **会话数据**（api-agent、api-session-manager、plugin-session-manager、plugin-subtask）：`agent:turn:after` 带出错原因；`SessionInfo` 加 `lastTurn`（最近一轮的结局、结束时间与出错原因，原因最多留 200 字）与按会话累加的 `tokens`（订阅 `llm:usage`，不改 `updatedAt`）。子会话与根会话同一套收口，最后一轮出错为 error，其余为 completed。子任务被停止时在 `check_subtask`、`wait_subtasks` 与父会话提醒里报「已停止」，`wait_subtasks` 随即返回；出错的带上原因。
- **会话协议**（api-session-protocol、plugin-session-server）：新增 `background/list`、`background/watch`、`background/output`、`background/stop`、`background/stopAll` 与推送 `background/changed`（开始、结束、停止立即推，只有最后一行变了的每秒合并一次）；`stopAll` 停各级子会话的回合与本会话、各级子会话的后台任务，不停本会话自己的回合。后台任务带命令的退出码 `exitCode`（取自登记，工具所属插件停用、重启之后照样在）。摘要加 `background`（在跑的后台工作数，含子会话）、`tokens`（含子会话的合计）、`lastTurn`、`reason`、`ancestors`，每次推送连同各级父会话；`sessions/list` 可以只列有后台工作的；转了后台的工具卡带 `taskId`，历史里同样还原。
- **WebUI**（api-webui、plugin-webui-client）：会话面板的宿主标签加「后台」，有子会话或后台任务时出现：子会话按会话树列出，工具调用列这个会话的任务，在跑的在前、结束的收进「已结束」；可以看输出（可复制，手机上全屏）、停止、全部停止，最后一行里的本机网址在本机打开页面时给「打开」链接。时间线里转了后台的工具卡保持活的；会话头部有「后台 N」（手机上收进「更多」并加一个点）；子会话页顶部写「父会话 › 本会话」，可以逐层退回；用量面板写会话累计的输入与输出 token；运行状况新增「正在运行」，归档的会话也列出。左栏只列根会话，删除行上的子任务展开，有后台工作的行写「后台 N」，出错的写一句原因。
- **破坏性**：
  - 删除 `exec_background`、`process_list`、`process_read`、`process_kill`：长任务用 exec 的 `runInBackground`，或等它到时自己转后台；查看与停止用四个后台任务工具。
  - 删除 exec、http_download、run_python、run_javascript 的 `timeout` 参数与结果里的 `timedOut`：带 `timeout` 的调用（如 workflow 工具节点里写死的参数）会被参数校验拒绝，去掉即可，要多等就给 `waitSeconds`。不在对话回合里的调用到让出时限（默认 30 秒，最多 `background.maxWaitSeconds`）还没结束就被中止；此前 exec 默认 30 秒、最多 300 秒超时。
  - 删除配置 plugin-tool-system 的 `shell.defaultTimeout`、`shell.maxTimeout`，plugin-tool-code-runner 的 `defaultTimeout`、`maxTimeout`。
  - pdf_convert 失败时改为报错（结果带 `error`），不再回 `{ success: false }`；MCP 工具的远端错误与调用失败以 `error` 回。
  - `wait_subtasks` 的 `timedOut` 只在等满时还有没结束的子任务才为真（此前子任务出错也算）；子任务状态多了 `stopped`。
  - 会话协议的 `SessionSummary.background` 必填。
- **发布档位**：次版本：api-tools、plugin-tools、plugin-tool-system、plugin-tool-code-runner、plugin-office、plugin-mcp-client、api-media、schema-message、api-authority、api-agent、api-session-manager、plugin-session-manager、plugin-subtask、api-session-protocol、plugin-session-server、api-webui、plugin-webui-client；其余为 patch。plugin-tool-system、plugin-tool-code-runner、plugin-office、plugin-draw、plugin-media、plugin-mcp-client 对 `@aalis/api-tools` 的依赖下限抬到本批的新版本；plugin-tools 新增依赖 api-storage、schema-config、schema-message、util-text-normalize。

### 单元 7 收尾第一批：契约清理与中立、体验与无障碍、结束通知与 /help（@aalis/schema-message、@aalis/api-llm、@aalis/api-agent、@aalis/api-tools、@aalis/api-commands、@aalis/api-session-manager、@aalis/api-session-protocol、@aalis/plugin-agent、@aalis/plugin-tools、@aalis/plugin-commands、@aalis/plugin-authority、@aalis/plugin-session-manager、@aalis/plugin-session-server、@aalis/plugin-message-archive、@aalis/plugin-file-reader、@aalis/plugin-image-sender、@aalis/plugin-adapter-onebot、@aalis/plugin-user-profile、@aalis/plugin-user-relation、@aalis/plugin-maimai、@aalis/plugin-webui-server、@aalis/plugin-webui-client）

新 WebUI 的第十部分：清掉不再使用的契约，会话服务不再按平台或插件的文字格式去猜存档内容，补上出错时的重试与日志入口和无障碍，后台任务的结束通知画成一行状态，/help 只列能用的指令。

- **契约清理**（schema-message、plugin-agent、api-llm、api-session-manager、plugin-session-manager、plugin-file-reader）：外发的 `OutgoingMessage` 不再带 `reasoningContent`、`segments`（思考与时间线经会话协议与存档取），`modelInfo` 只留 `provider`、`model`、`promptTokens`、`completionTokens`；删除 api-llm 的 `ModelInfo`、会话管理的 `getTree` 与 `SessionTreeNode`（子会话用 `getChildren` 逐层取）；plugin-file-reader 不再提供 `file-reader` 服务，上传的文件只经它自己的工具与会话面板取用。
- **存档与会话历史**（schema-message、plugin-message-archive、plugin-session-server、api-agent，以及写元数据的 plugin-agent、plugin-webui-server、plugin-image-sender、plugin-adapter-onebot）：`WellKnownMetadataKeys` 登记存档元数据的键（键名不变，存量数据不用迁移），新增 `ArchivedAttachment`。存档另记发言人写的话（`spokenContent`）与附件清单（`attachments`：种类、名字、地址），附件地址只记网址与根在存储根表里的存储地址，私有引用（如 `aalis-file://`）不进清单；不再写 `fileNames`。会话历史与实时推送里的提问只显示发言人写的话，文件显示成卡片，有地址的图片显示成图片；没有这两个键的旧提问显示存档原文。api-agent 写明两条约定：落库按登记的键；房间里一轮只把最后一条回复交给平台。
- **坏数据**（plugin-session-manager、plugin-session-server）：会话记录的可选字段存成 null 或类型不对时，去掉这个字段照常载入（存储把 undefined 存成 null 的记录因此不再从会话列表里消失）；必填字段不对的记录移到命名空间 `sessions-rejected` 并记 warn，同 id 的房间再来消息不会覆盖它。存档里字段不对的消息不进历史并记 warn，不再让整个快照取不出来。
- **WebUI 体验与无障碍**（plugin-webui-client、plugin-webui-server、plugin-user-profile）：
  - 取数失败的区域与出错提示带「重试」与「查看日志」，日志按来源实例筛好；保存宿主配置后重取失败时写「没刷新成功」，不再静默显示旧值。
  - 会话面板关闭当前标签的按钮移到标签栏末尾，键盘与读屏都能到达，悬停提示写 Delete；可关闭的标签按 Delete 关闭。
  - 运行状况角标的读屏名改为「运行状况，N 项需要处理」；端到端测试加 axe 无障碍检查。
  - 构建目标改为 Chrome 129、Edge 129、Firefox 131、Safari 16。
  - `?token=` 登录后保留其余查询串；多行通知（如指令回复）保留换行与缩进。
  - 新增「用户档案」页，可查看与删除事实，只删不改。
- **后台任务结束通知**（api-tools、schema-message、plugin-tools、plugin-message-archive、api-session-protocol、plugin-session-server、plugin-webui-client）：`hostNotice` 加可选的 `facts`（给界面的事实，不进模型），登记存档键 `HostNoticeId`、`HostNoticeFacts`；api-tools 新增 `BACKGROUND_TASK_NOTICE` 与 `BackgroundTaskNoticeFacts`，结束通知带工具名、结局、用时与退出码；会话协议的通知条目加 `noticeId`、`facts`。时间线把结束通知画成一行状态，点开是这个任务的日志；回滚确认在这一轮有转到后台的调用时，提示它们在这一轮结束之后写的文件不会撤回。
- **指令与 /help**（api-commands、plugin-commands、plugin-maimai、plugin-user-relation、plugin-agent、plugin-authority、plugin-user-profile）：
  - `/help` 只列调用者能用的指令，判据与执行同一份；用不了的当作不存在，执行时的拒绝提示不变。输出为各平台通用的纯文本；指令后加 `-h` 或 `--help` 回它的用法；裸敲分组与写错选项时附的用法同样过滤。
  - api-commands 新增 `argument(name, description)` 与 `PositionalArgSpec.description`；选项的取值可带说明；约定描述的第一句是 /help 里的摘要。
  - 负数可以直接作位置参数，如 `/level <平台>:<用户> -1`；修复以 `no-` 开头的选项名不能用；`/relation show` 的 id 为空、`/session.set` 一项都没给时回明确的提示。
  - plugin-maimai 删除手写帮助，裸敲 `/maimai` 回自动生成的用法；recent 的条数跟在 `qq:` 目标后面也生效。
- **权限**（api-tools、api-commands、plugin-authority、plugin-tools、plugin-commands）：`setExecutionGuard` 接受 `undefined`；停用 plugin-authority 时摘掉它注入的守卫，工具与指令回到 fail-closed（此前停用后仍按旧的等级表裁决）。
- **破坏性**：
  - schema-message：`OutgoingMessage` 删除 `reasoningContent`、`segments`，`modelInfo` 删除 `totalTokens`、`elapsedMs`。
  - api-llm 删除 `ModelInfo`；api-session-manager 删除 `getTree`、`SessionTreeNode`；plugin-file-reader 删除 `file-reader` 服务（`fileReader` 描述符、`FileReaderService`、`FileMeta`）。
  - plugin-message-archive 不再写 `fileNames`。
  - api-commands：`OptionSpec.choices` 改为 `OptionChoice[]`（登记时仍收字符串）；`-h`、`--help` 成为保留选项，声明名为 `help`、`h` 或别名为 `-h`、`--help` 的选项时登记抛错。
- **发布档位**：次版本：schema-message、api-llm、api-tools、api-commands、api-session-manager、api-session-protocol、plugin-session-manager、plugin-session-server、plugin-message-archive、plugin-file-reader、plugin-commands、plugin-user-profile、plugin-webui-client；其余为 patch。plugin-message-archive 新增依赖 api-storage（可选服务 storage），plugin-user-profile 新增依赖 api-webui（可选服务 webui-server）。

### 改用 Node 自带的 node:sqlite，最低 Node 24.15.0（@aalis/plugin-memory-sqlite、@aalis/create-aalis、@aalis/runtime、@aalis/plugin-doctor、@aalis/plugin-package-manager）

SQLite 记忆后端不再需要原生编译：换 Node 大版本不用重装依赖，装机也不用编译工具。整个项目的最低 Node 版本随之定为 24.15.0，这一版起 `node:sqlite` 不再打实验警告。

- **plugin-memory-sqlite**：改用 Node 自带的 `node:sqlite`，不再依赖 better-sqlite3。旧的数据库文件照常打开读写，不用迁移。开库设 WAL 与 `synchronous = NORMAL`（系统崩溃或断电时可能丢最后几次提交，库文件不会损坏），遇锁照旧最多等 5 秒；消息没有 `content` 时按空值落库，不再报错。Node 太旧（取不到 `node:sqlite`，或它缺本插件要用的事务状态与遇锁等待，即 22.16 之前与 23.x）时激活失败，报错写明需要 Node 24.15.0 起并指向升级说明；删掉原来原生模块版本不符时的 rebuild 提示。
- **create-aalis**：一开头检查 Node 版本，低于 24.15.0 时不生成项目，报错只写需要的版本、当前版本与文档站「升级 Node」一节的地址；生成的项目 package.json 写 `engines`。
- **plugin-doctor**：`env.node` 按 24.15.0 判，低于它报错并写明升级办法（此前按 22 推荐）。
- **engines**：根、runtime、create-aalis、plugin-memory-sqlite 写 `"node": ">=24.15.0"`。
- **文档**：README、CONTRIBUTING、入门与脚手架页改为 Node 24.15 起；「第一次运行」新增「升级 Node」，写明各平台的升级步骤。
- **升级须知**：在 Node 22 上运行的实例，升级到本批之前先把 Node 换到 24.15 起；在新 Node 上，旧版 plugin-memory-sqlite 的原生模块会因版本不符激活失败，随本批一起升级即可。
- **发布档位**：次版本：plugin-memory-sqlite、create-aalis；patch：runtime（只加 engines）、plugin-doctor；plugin-package-manager 只改注释，不发版。

### 上手与故障说明：脚手架、开始使用与需要处理、看不了图、报错写明怎么修（@aalis/create-aalis、@aalis/create-aalis-plugin、@aalis/runtime、@aalis/api-doctor、@aalis/plugin-doctor、@aalis/api-webui、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/api-package-manager、@aalis/plugin-package-manager、@aalis/plugin-cli、@aalis/plugin-media、@aalis/plugin-memory-sqlite、@aalis/plugin-memory-mongodb、@aalis/plugin-memory-vector、@aalis/plugin-memory-summary、@aalis/plugin-session-manager、@aalis/plugin-llm-deepseek、@aalis/plugin-llm-openai、@aalis/plugin-llm-ollama、@aalis/plugin-embedding-ollama、@aalis/plugin-maimai、@aalis/plugin-okx-trading、@aalis/plugin-asr-openai、@aalis/plugin-asr-whisper-cpp、@aalis/plugin-office、@aalis/plugin-scheduler、@aalis/plugin-workflow、@aalis/plugin-usage-stats、@aalis/plugin-process-local、@aalis/plugin-code-sandbox-os、@aalis/schema-config、@aalis/api-host-config）

新用户从建项目到第一次对话少走弯路，出了问题界面直接说清是哪个插件、为什么、怎么修。

- **create-aalis**：默认流程只问四件事：项目名、对话模型（选了要 key 的可以当场粘贴，输入不回显）、接入平台、要不要长期语义记忆。默认集不再装联网搜索（full 档照旧装），WebUI 挪进平台组；档位、记忆后端、embedding、向量库收进 `--advanced`。按对话能力探测本机 Ollama（认 `OLLAMA_HOST`），探到时对话模型与语义记忆默认用它、零 key 可用，没有对话模型时提示先 `ollama pull`。LanceDB 在没有预编译件的平台上不出现。装依赖失败时按类别写出原因与修法（网络与源、源上没有这个包或版本、权限、磁盘、原生模块编译、平台不支持、浏览器下载、peer 冲突）。生成的 README 与结尾提示和实际一致（WebUI 端口、装插件后要重启或「重新扫描」）。提问时按 Ctrl+C 写「已取消，没有生成任何文件」、退出码 130。断网时 full 档的离线清单补上联网搜索与绘图。
- **create-aalis-plugin**：生成的依赖写成「源上当前版本起、1.0 之前」的区间，查不到版本就退出并写明怎么修（新增 `--registry`），不再写 `latest`；示例工具声明 `risk`，注释写三档与可转后台的声明；新增一问「登记会话设置项？」；指引全部改用 npm；显示名按字面量转义写进源码。
- **runtime**：`--init` 建的家目录写上 cli、webui 两个平台档（`enabledToolGroups: ["*"]`，无条件写，平台没装时不起作用，多人平台不代开），与 create-aalis 生成的一致；启动告警改用共享判据，沿依赖链写到根。
- **缺服务与等待启动的共享判据**（api-doctor 新增 `unmetDependencies`、`describeUnmet` 与相关类型）：沿依赖链追到根，根的情形分失败、已停用、待配置、没有提供者、成环、在运行却没在提供，以及在启动；只收插件状态快照与当前可用的服务名。runtime 启动告警、plugin-doctor 的 `plugins.pending`、WebUI 的「需要处理」、CLI 欢迎行与市场卸载闸共用这一份，说法一致。
- **WebUI**：
  - 「需要处理」每个缺服务的插件一行，说明写到根插件的链与根的情形，按钮直达根插件（待配置的「去配置」，用提醒色）；提供者还在启动的写「等待 <提供者> 启动」，不计数，插件树不加标记。插件详情、「会话服务未启用」与启用、保存的回执用同一句。
  - 首页按状态出现「开始使用」：还没有能对话的模型时列出已装的对话模型插件与状态，以及市场里可装的提供者，有了模型就消失。
  - api-webui：删掉 `PluginListItem.missing` 与「需要处理」插件项的 `missing`，换成 `lacking`、`waiting`、`unconfigured`；`PluginListItem` 新增 `configSection`；`MarketplacePackage` 新增 `provides`；默认子系统表新增「媒体」「工作流」。
  - 插件树：本地进程有了显示名并归「系统」，代码沙箱归「工具」。
  - webui-client 打包用的库挪进 `devDependencies`，装进项目时不再拉 React 等运行库（默认集实测从 458 个包、290M 降到 214 个包、58M）。
- **插件市场**（plugin-package-manager、plugin-webui-server、plugin-webui-client）：按包声明提供的服务检索，卡片标「提供：…」。卸载默认保留配置段与它引用的密钥，与 `npm uninstall` 一致，重装后按原段启动；配置文件里有这一段时卸载框给「同时删除配置（含 N 个密钥）」，默认不勾，勾了只删没人再引用的密钥。只有被卸的插件自己正在提供服务时才拦依赖它的插件，待配置、失败或已停用的唯一提供者可以直接卸掉换一个。装卸失败的回执与脚手架用同一张类别表写原因与修法。
- **plugin-cli**：有插件没起来时，欢迎行加一句「有 N 个插件没起来，输入 /doctor 查看原因与修法」（没有诊断插件时改说看日志）。
- **plugin-media**：图一律落盘、在正文留引用；没有能看图的模型时，消息另加一行「附了 N 张图，当前无法查看」；识别失败或返回空的，引用照留，描述写获取或识别失败。新增 doctor 检查「识图」。
- **报错写明怎么修**：作者指南新增「报错与故障说明」，第 9 节「apply 里别 throw、记日志后优雅降级」改为「部分功能坏了才降级，整体用不了就抛错或发提示」。第一批普查改了激活失败、doctor 检查、脚手架与市场的报错：对话模型取不到模型列表、SQLite 与 MongoDB 开库或连接失败、配置不是 storage URI 等都写明修法；指向升级说明的地址改成文档站完整地址；登录页「token 在启动日志里」的失实文案改正。
- **破坏性**：
  - api-webui：删除 `PluginListItem.missing` 与「需要处理」插件项的 `missing`。
  - api-package-manager：`uninstall` 默认保留配置段与密钥（此前市场卸载删段），要删段传 `removeConfig`。
  - plugin-package-manager：导出函数 `findServiceDependents` 多了必填参数 `available`。
  - plugin-maimai、plugin-okx-trading 缺凭据时从「告警后跳过」改为激活失败，WebUI 标「待配置」；plugin-asr-openai、plugin-asr-whisper-cpp 的必需项改为 schema 必填。
  - create-aalis：默认集不含联网搜索；`--tier minimal` 默认也带 WebUI；`--advanced` 的 embedding 改为单选。
  - create-aalis-plugin：生成的依赖不再是 `latest`，查不到版本时退出。
- **发布档位**：次版本：api-webui、api-doctor、api-package-manager、plugin-package-manager、plugin-webui-server、plugin-webui-client、plugin-doctor、plugin-media、create-aalis、create-aalis-plugin、plugin-maimai、plugin-okx-trading；其余为 patch。新增依赖：api-webui、plugin-package-manager、plugin-webui-server、plugin-media 依赖 api-doctor，plugin-cli 依赖 api-doctor 与 api-commands（可选使用 plugins、commands），plugin-media 可选使用 doctor；这些对 api-doctor 的下限发布时抬到本批 api-doctor 的新版本。

### 报错普查第二批：指令回复与提示写明修法，吞掉的故障交到用户眼前（@aalis/api-storage、@aalis/plugin-scheduler、@aalis/plugin-authority、@aalis/plugin-media、@aalis/plugin-code-sandbox-os、@aalis/plugin-mcp-client、@aalis/plugin-image-sender、@aalis/plugin-commands、@aalis/plugin-agent、@aalis/plugin-maimai、@aalis/plugin-user-profile、@aalis/plugin-webui-server）

接着「上手与故障说明」的第一批，把剩下会到用户眼前的报错改成写明出了什么事、该做什么。

- **存储路径填错**（api-storage；SQLite 记忆、Flat 与 LanceDB 向量库、人设等用存储路径的插件）：新增 `isHostAbsolutePath`；配置里的路径写成本机路径（`/abs`、盘符路径、`~/`）时激活失败只有一行，写明这里要填 storage URI（如 `data:/aalis.db`）、要用存储根以外的目录就先在「本地存储根」加一个根并打开「允许写」，不再报「未知存储根」加整段堆栈。
- **计划任务**（plugin-scheduler）：配置文件里某个任务的 `timeZone` 写错，不再让整个插件起不来，只这个任务发「没有排上」提示；计划任务页新建、编辑与 `scheduler_create_job` 当场校验 cron，无效的拒收、不落盘（此前收下后永远不跑）；持久化任务文件读不出来时发提示，按原因给修法；拒写期间的回执指向「需要处理」里的提示。
- **权限管理**（plugin-authority）：`users.json` 读不出来时在「需要处理」里发提示并带出原因（读取报错、JSON 解析错误或版本不对），修好后撤回；`/level` 的回执写明怎么修。
- **多模态媒体识别**（plugin-media）：图片落盘失败不再悄悄丢图：记 warn 并写进报告条目，识别照常进行。
- **代码沙箱**（plugin-code-sandbox-os）：没有可用后端时的告警写修法与原因；新增 doctor 检查「代码沙箱」。
- **MCP 客户端**（plugin-mcp-client）：连不上的提示先写修法（检查 command、args、env，保存即重连）再接原因。
- **发图**（plugin-image-sender）：`send_attachment` 的 `storage_uri` 或历史引用写成本机路径时，回一句要写存储地址，按库外来源拒发。
- **指令回复**（plugin-commands、plugin-agent、plugin-maimai、plugin-user-profile）：`/session` 系列、`/clear` 在会话管理或记忆后端不在时，写明在 WebUI 插件区启用或从配置文件的 `disabledPlugins` 删掉，起不来时用 `/doctor`；舞萌查分凭据被拒时写检查 `developerToken`，连不上或读到超时写稍后再试并带原因，绑定与解绑分开写两种原因；用户事实档案的行为指令关着时写明打开 `enableInstructions`。删掉几处不可达的分支（`/shutdown`、`/restart` 的「无法访问应用服务」等）。
- **WebUI 服务端**（plugin-webui-server）：配置下拉某个提供者取值失败时记 warn，点名提供者与原因。
- **破坏性**：
  - api-storage：`toStorageUri` 遇本机路径抛配置错误；此前 `/data/x` 会被归一成 `data:/x`，现在不再接受。
  - plugin-image-sender：`storage_uri` 写成本机路径时拒发（此前 `/data/...` 能发）。
  - plugin-commands：`app` 改为必需依赖（声明与清单），运行时无变化。
- **发布档位**：次版本：api-storage（新增依赖 schema-config）、plugin-scheduler、plugin-image-sender；patch：其余。plugin-code-sandbox-os 新增依赖 api-doctor 并可选使用 doctor。

### 单元 7 第六步整批收尾：后台任务按会话放行、插件前端可以联网、存档元数据只经登记的键（@aalis/plugin-tools、@aalis/api-webui、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/create-aalis-plugin、@aalis/create-aalis、@aalis/schema-message、@aalis/plugin-package-manager、@aalis/plugin-scheduler、@aalis/plugin-image-sender、@aalis/plugin-cli、@aalis/plugin-memory-summary、@aalis/plugin-memory-inmemory、@aalis/plugin-memory-sqlite、@aalis/plugin-memory-mongodb、@aalis/plugin-memory-history、@aalis/plugin-memory-vector、@aalis/plugin-message-archive、@aalis/plugin-agent、@aalis/plugin-adapter-onebot、@aalis/plugin-user-profile、@aalis/plugin-user-relation、@aalis/plugin-paper、@aalis/api-doctor）

单元 7 这批、依赖升级、上手与故障说明与报错普查第二批合起来做了一次全面检查（审计与否定者分开审，逐条核实后修掉），并做完看板定下的几项收尾。

- **后台任务工具按会话放行**（plugin-tools）：`background_list`、`background_output`、`background_wait`、`background_stop` 对本会话里谁起的任务都能查、能停，别的会话里的回「不存在」；不再可选使用 authority；`background-tasks.json` 不再记起它的身份，旧文件里多出的这个字段读时忽略。
- **插件前端可以联网**（plugin-webui-server、api-webui、create-aalis-plugin）：框架 CSP 只限脚本（只认插件自己打包的文件）与嵌套（`frame-src`、`object-src` 为 `none`），外站的样式、字体、图片、音视频与数据请求都放行；不再发 `X-DNS-Prefetch-Control`，`FrameFileHeaders` 去掉这个字段；脚手架生成的插件前端说明随之改写。
- **存档元数据只经登记的键**（schema-message 与读写存档的各插件）：`WellKnownMetadataKeys` 新增 `GroupId`、`GroupName`、`SessionType`、`MessageId`（键名不变，存量数据不用迁移）；第一方插件读写这些键一律引用常量，守卫扩到全部第一方插件与按路径拼的查询、索引。memory-inmemory、memory-sqlite、memory-mongodb 把 schema-message 从开发依赖改为运行时依赖。
- **需要处理与会话服务未启用**（plugin-webui-client）：依赖者那一行只写根报错的第一行，全文只在根插件自己那一行与它的详情里；桌面上「会话服务未启用」只写在主区，房间表同样写明，按钮与说明与「需要处理」一致（待配置的去配置，失败的写原因）。服务端比客户端新时，认不出的根写「原因见日志」，缺字段的根与没有 `provides` 的旧版市场回应不再让整页白屏。
- **市场与插件区**（plugin-package-manager、plugin-webui-client）：卸载闸按同名的全部实例判服务依赖者，不再受实例先后影响（本批引入的回归）；装卸与更新失败时「查看日志」链到提供包管理服务的插件，市场更新条失败时也有这个链接。
- **其余修正**：
  - plugin-scheduler：scheduler 服务的 `addJob`、`setJob` 遇无效 cron 当场抛出原因，别的插件经服务建的任务同样拒收。
  - plugin-image-sender：`storage_uri`、`history_ref` 写成 `~/…` 时按本机路径拒发，给出工具口径的报错。
  - create-aalis：Node 版本不够时，报错末行给出文档站「升级 Node」的链接。
  - plugin-webui-server：登录页写明 fixedToken 存在 secrets.yaml 里。
  - plugin-webui-client：标签页按 Delete 关闭，Mac 上也认 Backspace（提示写 ⌫），关闭后焦点交给新选中的标签；「更早的消息」加载失败时用统一的出错块，可重试、查看日志；运行状况的平台连接随会话连接接上与断开再取，直接打开这一页时不再误写「没有连接」。
  - plugin-cli：没有终端界面时（后台运行）不再报一条离线的连接。
  - plugin-memory-summary：历史不多于保留条数时压缩什么都不做、不报进度，时间线不再插假的「对话已压缩」；开始压之前就失败的只拒绝、不报进度。
  - plugin-paper：说明与包描述改为「白纸是与本机隔离的地方，把任务交给远端代理是在上面干活的一种方式」。
  - api-doctor、api-webui：`lacking` 的说明补上「在运行却没在提供」，消费方补上市场的卸载闸。
- **破坏性**：
  - api-webui：`FrameFileHeaders` 删除 `x-dns-prefetch-control`。
  - plugin-tools：插件声明的 optional 去掉 `authority`；后台任务工具的可见范围从「同一身份，owner 看全部」改为「本会话」。
  - plugin-image-sender：`~/` 开头的 `storage_uri`、`history_ref` 被拒发。
  - plugin-scheduler：经服务新建或修改任务时，无效 cron 由收下改为抛错。
- **发布档位**：次版本：schema-message（新键）、plugin-tools、plugin-webui-server、api-webui；其余为 patch。下面这些包对 schema-message 的下限抬到本批的新版本（现写 `>=0.9.0` 或 `>=0.9.1`）：plugin-memory-inmemory、plugin-memory-sqlite、plugin-memory-mongodb、plugin-memory-history、plugin-memory-vector、plugin-message-archive、plugin-agent、plugin-adapter-onebot、plugin-user-profile、plugin-user-relation（plugin-trigger-laya 是 private 包，同步改下限、不发布）。

### 删除第三方行为指令（@aalis/plugin-user-profile、@aalis/plugin-commands）

user-profile 只管对他人的历史记忆，不再从管理员的发言里提取行为规则、注入每一次模型调用。

- **删除**：配置项 `enableInstructions`、`instructionMinAuthority`、`instructionExtractEveryNMessages`、`instructionHistoryForExtraction`、`maxInstructions`、`maxInstructionCharsPerItem`；按入站消息计数的自动提取；注入每次模型调用的「第三方行为准则」块；`/instruct`、`/instruct.add`、`/instruct.remove`、`/instruct.clear`。插件不再使用 authority 与 persona 服务。
- plugin-commands：`/clear` 的回执与类型说明里 `user-profile` 改名为「用户档案」。
- **升级须知**：旧配置里的这六个键启动时按 schema 裁掉并告警，删掉即可。已存的 memory 元数据命名空间 `aalis:instructions` 不再读取，`/clear` 也不再清它；需要留底的先导出，再手动删除。
- **发布档位**：plugin-user-profile 次版本；plugin-commands patch。

### 全量压缩与按比例触发（@aalis/api-memory、@aalis/plugin-memory-summary、@aalis/plugin-memory-inmemory、@aalis/plugin-memory-sqlite、@aalis/plugin-memory-mongodb、@aalis/plugin-session-server、@aalis/api-session-protocol）

压缩把切分点之前的全部活跃历史压成一份摘要，不再保留最近若干条原文；自动压缩改按用量占上下文窗口的比例，在回合结束时判。

- **全量压缩**（plugin-memory-summary）：
  - 切分点之前的全部活跃历史连同已有摘要压成一份新摘要，再归档这一段；快照之后到达的消息与没写全的工具调用组原样留在活跃历史里，接在摘要后面。落笔前核对历史前缀，压缩期间被回滚或改动就作废。
  - 没压成时以原因拒绝，不再退化为只裁切历史。后台压缩没压成时按轮数退避重试（隔 2、4、8、16、32 轮，之后每 32 轮一次），压成或清空后重置。手动压缩对短对话也完整压一次，没有可压的对话时什么都不做。
  - 摘要的输出上限为会话最近一次模型调用的窗口乘 `summaryTokenRatio`（还没有用量时按摘要模型的窗口），下限 512，不超过摘要模型的输出上限与它窗口的四分之一。待摘要部分装不进摘要模型的窗口时分块增量，每次请求连同提示词、已有摘要与输出上限都装得下。宿主通知、代发的指令与平台通知也进摘要输入。注入的摘要不再按预算截断。
  - `summaryModelMode` 为 `custom` 而指向的模型不在时，报错写明 provider/model。
- **自动压缩**（plugin-memory-summary、api-memory）：新增会话设置项「自动压缩线」`compressAt`（占窗口比例，0 到 1，默认 0.8，0 表示不按用量压缩），各种会话都适用，按会话设置的层设；为此新增可选依赖 session-manager。回合结束时只按这一轮最后一次模型调用的用量判：`token:request` 的快照不触发，中止、出错的回合与压缩或清空之前开始的回合不判。实际的线取「自动压缩线 × 窗口」与裁剪预算中较小的那个；能压掉的部分（历史与工具结果）不到线的一半时不压。判定是 api-memory 的纯函数 `compressionDue`。
- **会话服务**（plugin-session-server）：用量条目与会话头部的压缩刻度取实际压缩的那条线（自动压缩线与裁剪预算占窗口比例中较小的那个）。
- **破坏性**：
  - api-memory：`MemoryService` 删除可选方法 `trimHistory`，新增必填方法 `archiveOldest(sessionId, count)`：把最早的 count 条活跃消息标为归档（顺序与 `getHistory` 相同），返回归档条数，count 为 0 时什么都不归档；`getHistory` 的 `limit` 为 `Infinity` 时返回全部活跃消息。第三方记忆后端要实现这两点，没有 `archiveOldest` 时压缩一律失败。
  - api-memory：`CompressionService.compress(sessionId, reason)` 改为 `compress(sessionId, { reason: 'manual' })`，删除 `reason: 'auto'` 与 `autoThreshold`，新增按会话取的 `compressAt(sessionId, platform?)`（设为 0 时为 `undefined`）；新增纯函数 `compressionDue(usage, lines)` 与类型 `CompressionUsage`、`CompressionLines`，失败退避由调用方负责。
  - plugin-memory-inmemory、plugin-memory-sqlite、plugin-memory-mongodb：删除 `trimHistory`（sqlite 与 mongodb 导出的服务类同样），改为实现 `archiveOldest`，同一毫秒的消息按写入先后归档；sqlite 与 mongodb 的 `getHistory` 支持读全部活跃消息。
  - plugin-memory-summary：删除配置键 `threshold`、`keepRecent`、`autoCompressThreshold`。
- **升级须知**：
  - 这三个键在新版启动时按 schema 裁掉并告警，要搬的值在升级前记下。
  - 原来靠 `threshold` 按条数触发压缩的，把旧值写进会话设置的条数线 `historyLimit`（见下文「真实用量、裁剪标记与条数线」）。`keepRecent` 没有对应：压完之后，模型手里只有摘要与切分点之后的几条消息。
  - `autoCompressThreshold` 不换算：它全局一个值、按单次调用判，新的自动压缩线按会话分层、在回合结束时判。默认 0.8；要更早压缩或不按用量压缩的，在 `sessionConfig` 的相应层写 `compressAt`（不按用量写 0）。
  - `summaryTokenRatio` 保留，分母改为会话所用模型的窗口：会话模型与摘要模型的窗口差得多的，按新口径核一下这个比例。
  - 现有摘要与历史数据不用迁移。
- **发布档位**：次版本：api-memory、plugin-memory-summary、plugin-memory-inmemory、plugin-memory-sqlite、plugin-memory-mongodb；plugin-session-server 随首发；api-session-protocol 只改注释。对 `@aalis/api-memory` 的下限抬到本批的新版本（这几个现写 `>=0.7.1`）：plugin-memory-summary（运行时导入 `compressionDue`）、plugin-session-server、plugin-memory-inmemory、plugin-memory-sqlite、plugin-memory-mongodb。

### 会话来源字段（@aalis/api-session-manager、@aalis/api-platform、@aalis/api-gateway、@aalis/schema-message、@aalis/api-commands、@aalis/api-approval、@aalis/plugin-session-manager、@aalis/plugin-session-server、@aalis/plugin-cli、@aalis/plugin-adapter-onebot、@aalis/plugin-webui-server、@aalis/plugin-authority、@aalis/plugin-flow-control、@aalis/plugin-persona、@aalis/plugin-memory-history、@aalis/plugin-memory-vector、@aalis/plugin-tool-session、@aalis/plugin-maimai、@aalis/plugin-agent、@aalis/plugin-subtask、@aalis/plugin-trigger-laya）

会话的出生平台、聊天窗口与创建来源在建档时记成会话字段，权限判定、选档、召回范围与会话列表一律读这些字段，不再从会话 id 推；平台的类型（一对一还是多方）由适配器声明。

- **来源字段**（api-session-manager、plugin-session-manager、plugin-session-server、plugin-cli）：
  - IM 房间的首条真人入站建档时记下出生平台 `originPlatform` 与聊天窗口 `originChat`（平台类型名、多方标记、机器人账号、目标），之后不变。会话表里还没有来源字段的根会话（升级前的房间、按 id 兜底建档的根会话），由之后第一条真人入站补记来源字段与名字，只认这个会话 id 归消息平台的适配器管的入站；会话 id 被不止一个平台的适配器认领（配错的 id）时不收录、不补记，每个 id 告警一次；从 WebUI、终端往房间插话不补记。
  - WebUI 新建的根会话记创建来源 `createdFrom`（会话服务取这条连接所在审批面的登记名 `webui`），子会话不带。终端在发出第一条消息前给配置的会话建档、记 `createdFrom: 'cli'`；配置的会话 id 由别的平台适配器认领时不建档、不写来源，告警一次。终端一次粘贴的多行按输入顺序发出。
  - 自动标题只给带创建来源的根会话生成。会话摘要里的机器人账号、房间组的账号数与「平台:目标」搜索改读来源字段。
- **房间类别**（api-session-manager 新增纯函数 `roomClass`）：受众只有 owner 的为 `owner-only`（带创建来源的根会话、对端是 owner 的一对一窗口），受众里有别人的为 `room`（多方窗口、对端不是 owner 的一对一窗口），其余为 `internal`（不在会话表里的、没有来源字段也没有创建来源的、编排与定时任务的会话），子会话取根会话的。安全判断只认多方标记，不认类型名。
- **权限**（plugin-authority、api-approval）：发起类别里的「房间」改按房间类别判，不再按会话 id；受众判不出的会话（`internal`，以及没装会话管理时的全部会话）失败关闭，owner 在其中发起的回合与续做归 `other`，不能产生审批。新增可选依赖 session-manager，不再依赖 api-gateway。
- **平台类型**（api-platform、schema-message、plugin-adapter-onebot、plugin-cli、plugin-webui-server）：
  - 适配器以 `sessionTypes` 声明类型名与多方标记；不声明的平台（webui、cli）整个算一个一对一类型 `private`。消息带的类型名不在声明里时按多方记下并告警；声明了多方类型、消息却没带类型名时按第一个多方类型处理，会话管理每个平台告警一次。api-platform 新增 `claimantsOf`，按登记顺序列出认领某个会话 id 的全部适配器。
  - OneBot 声明 `group`、`channel`（多方）与 `private`（一对一），入站带 `selfId`。`sessionType` 原样带出实现端的消息类型，声明以外的（如部分 v11 实现的 `guild`）按多方记下并告警，此前这类消息不带类型。频道消息带上 `groupId`，写作 `<guild>:<channel>`，与会话 id 的目标段一致；开了 `groupOnly` 的 plugin-user-relation 因此也把频道算作群聊。
  - WebUI 的作用域候选按各平台的类型列出，webui、cli 多出 `<平台>:private`。
  - 选层、场所与会话列表都不再看会话 id 的写法：内部会话的 id 可以带单冒号，WebUI 会话的 id 带冒号也由 webui 认领出站，session-manager 的 id 前缀告警删除。没实现 `canHandle` 的适配器仍按 `<平台名>:` 前缀路由。
- **读来源字段的插件**：
  - plugin-flow-control：手里没有会话类型时按会话记下的聊天窗口判作用域；平台为 internal 的定时任务与 WebUI 驱动的回复进已收录的群时，按群的出生平台进作用域，受限速并计入回复额度。
  - plugin-persona：会话环境里的会话类型与群号取会话记下的聊天窗口，不再拆会话 id；不再依赖 api-gateway。
  - plugin-memory-history、plugin-memory-vector、plugin-tool-session：同平台范围按根会话记下的出生平台判，不再依赖 api-gateway；没装会话管理时，tool-session 的 `platform` 范围读不到别的会话。
  - plugin-maimai：没绑定时按调用者 QQ 号查，判据由会话 id 含 `:private:` 改为会话记下的一对一窗口；新增可选依赖 session-manager。
  - plugin-agent：`token:request` 缺平台时取根会话的出生平台。plugin-agent 与 plugin-subtask 不再写 `createdBy`。
  - plugin-trigger-laya（private 包）：机器人账号取消息上的 `selfId`，没有时取房间记下的，从 WebUI 往群里插话照常问侧车；不再只认 OneBot 的群与私聊；兜底原因改为「没有机器人账号」。
- **破坏性**：
  - api-session-manager：删除 `SessionInfo.createdBy`，`ensureSession` 的 `patch` 也不再收它；新增 `createdFrom`、`originChat`、`work`、`currentDir` 与类型 `OriginChat`、`WorkBinding`、`SessionCreation`、`RoomClass`；`originPlatform` 改为建档时记下的存储字段，不收调用方传值，自研 session-manager 不再按会话 id 推。`createSession(opts?, creation?)` 与 `ensureSession(id, patch?, creation?)` 的末参数 `SessionCreation` 是建档专用的参数（`ensureSession` 只收其中的创建来源），只给根会话，带 `parentId` 时抛错。新增纯函数 `rootSessionOf`（父会话链断了或成环时为 `undefined`）与 `roomClass`，以及当前目录与项目会话绑定的方法 `setCurrentDir`、`setExtraRoots`、`addWorktree`。
  - api-platform：`PlatformAdapter.sessionTypes` 由 `string[]` 改为 `SessionTypeDecl[]`（`{ name, multiParty }`，`multiParty` 不是 `false` 的按多方）；新增 `sessionTypesOf`、`resolveSessionType` 与类型 `ResolvedSessionType`；`resolvePlatformBySession`、`getPlatformAdapterEntries` 的 source 只需 `all`。第三方适配器要改声明，并在消息上带类型名与 `selfId`。聊天窗口建档后不再改：按字符串声明类型的旧适配器配新版 session-manager 时，它的私聊也按多方记下，记错的要改会话记录里的 `originChat`。有多方会话的平台不声明类型时，它的群按一对一处理，任何群员都会被当成那个唯一的对端。
  - schema-message：`IncomingMessage.sessionType` 由 `'group' | 'private' | 'channel'` 改为任意类型名字符串，新增 `selfId`；按三个字面量穷举的代码要补默认分支。api-commands 的 `CommandArgv.session.sessionType` 与 `ExecutionInput.sessionType` 同样改为字符串。
  - api-gateway：删除 `inferSessionScope`；新增 `chatScopeOf`（入站消息所在的聊天窗口）与类型 `ChatScope`，依赖加 `@aalis/api-platform`。消息上没有会话类型时，改取会话管理记下的 `originChat`。
  - plugin-authority：没装 plugin-session-manager 的部署，owner 的回合一律不能产生审批，要审批的工具直接拒绝；没有来源字段的旧会话同样（见升级须知）。
  - plugin-adapter-onebot：频道消息新带的 `groupId` 是 `<guild>:<channel>`；声明以外的消息类型不再丢掉。
- **升级须知**（会话表在记忆后端的元数据命名空间 `sessions`，键为会话 id）：
  - IM 房间（根会话 id 形如 `<平台>:<机器人账号>:<类型>:<目标>`）不用处理：那个群或私聊的下一条真人消息会补记来源字段与名字。补记之前它们按内部会话处理，列在「我的会话」。
  - WebUI 与终端的旧会话要补 `createdFrom` 才算 owner 自己的会话：终端配置的会话 id（plugin-cli 的 `sessionId`，默认 `cli-default`）写 `createdFrom: 'cli'`，记录已在表里且已有出生平台、绑定或创建来源时终端不会补写（按 id 兜底建档留下的空记录，终端说话时会补写）；在 WebUI 里建的写 `createdFrom: 'webui'`。不补的按内部会话处理：owner 在里面发起的回合不能产生审批、不生成自动标题，入站照常经过触发判定与流控（见下文「工作会话的结构性放行」）。升级之后新建的会话自动带上。
  - `createdBy` 不再读取，可以删掉。
  - 自己实现平台适配器的，先按上面改好 `sessionTypes` 与 `selfId`，再升级 plugin-session-manager。
- **发布档位**：次版本：api-session-manager、api-platform、api-gateway、schema-message、api-commands、plugin-session-manager、plugin-authority、plugin-adapter-onebot；plugin-session-server 随首发；api-approval 只改注释；plugin-trigger-laya 不发布；其余为 patch。要抬的依赖下限（抬到本批的新版本）：
  - `@aalis/api-session-manager`（来源字段、`rootSessionOf`、`roomClass`、建档参数）：plugin-authority、plugin-cli、plugin-flow-control、plugin-maimai（本节新增的依赖，现写 `>=0.10.0`），以及 plugin-session-manager、plugin-session-server、plugin-agent、plugin-persona、plugin-memory-history、plugin-memory-vector、plugin-tool-session、plugin-webui-server。其中运行时导入 `rootSessionOf` 或 `roomClass` 的，装到旧版时加载失败。plugin-trigger-laya 同步改。
  - `@aalis/api-platform`（`SessionTypeDecl`、`sessionTypesOf`、`resolveSessionType`）：api-gateway（新增的依赖，运行时导入 `resolveSessionType`，现写 `>=0.9.0`）、plugin-session-manager 与 plugin-webui-server（运行时导入 `sessionTypesOf`）、plugin-adapter-onebot、plugin-cli。
  - `@aalis/api-gateway`（`chatScopeOf`）：plugin-session-manager（运行时导入，现写 `>=0.7.0`）。
  - `@aalis/schema-message`（`selfId`）：plugin-adapter-onebot；plugin-trigger-laya 同步改。
  - 前文「房间会话钉死出生平台、会话列表分区与停止键停掉子进程」一节为 `resolveSessionOrigin` 列的 api-gateway 下限，除 plugin-session-manager 外都不用再抬：plugin-persona、plugin-memory-history、plugin-memory-vector、plugin-tool-session、plugin-authority 去掉了对 api-gateway 的依赖，plugin-agent 只用已发布版本里就有的 `gateway`。

### 真实用量、裁剪标记与条数线（@aalis/api-agent、@aalis/plugin-agent、@aalis/api-memory、@aalis/plugin-memory-summary、@aalis/plugin-memory-history）

用量取模型服务返回的输入 token，每次模型调用之后都报；自动压缩按硬裁剪之前的历史算能压掉的部分，并加上按条数的一维；对话代理每轮读多少条历史改由会话设置定。

- **用量**（api-agent、plugin-agent）：`token:usage` 在每次模型调用之后发一次（首次调用、工具循环里的每次、格式重试），调用抛错的那次不发；`used` 取模型服务返回的输入 token，只采用正的有限数，0、NaN 与没有返回时按估算，界面不再出现 0% 或 NaN%。plugin-agent 等 `token:usage` 的监听者处理完才继续这一轮。
- **硬裁剪**（plugin-agent）：真实回合里删了消息时记一行「上下文硬裁剪: session=<id>, N → M 条消息」，快照不记；原来的「上下文压缩/截断 … 约 X tokens」不再输出。`token:request` 的快照按会话的条数线读历史，并过同样的硬裁剪。`trimThresholdRatio` 的说明改为指向会话设置里的两条线。
- **条数线**（plugin-agent 登记会话设置项「历史条数上限」`historyLimit`）：一轮最多从记忆读进这么多条会话历史；装了摘要插件时，会话的消息到这个条数就压缩。默认 0：读全部活跃历史、不按条数压缩。各种会话都适用，子会话按自己的继承链实时解析。
- **压缩判定**（api-memory、plugin-memory-summary）：`compressionDue` 加条数一维（会话历史条数到线即压缩）与 `trimmed`（用量没到线、但这一轮被硬裁剪过也算到线）。能压掉的部分按硬裁剪之前的历史算，人设与注入块很大的小窗口模型不再只裁不压；首次调用被裁剪、之后又调了工具的回合，结束时同样压缩；结局为 `replied` 时，会话条数计入这一轮落库的最终回复，一问一答到线的那一轮结束就压缩。条数触发与用量触发共用按轮数的退避。「自动压缩线」的说明补「0 表示不按用量压缩（条数线照样起作用）」。
- plugin-memory-history：`excludeCurrentSession` 的说明改为指向会话设置 `historyLimit`，行为不变。
- **破坏性**：
  - api-agent：`TokenUsageEvent` 新增必填字段 `trimmed`（本回合到这次调用为止进入过硬裁剪）、`untrimmedHistory`（按没经过硬裁剪的消息列表估算的历史与工具结果 token）、`historyMessages`（这次的消息列表里来自会话历史的条数）。自己发 `token:usage` 的第三方要补上；按用量触发动作的消费方以有没有 `turnId` 区分真实回合与快照。`SessionConfig` 新增 `historyLimit`；`agent:turn:after` 写明结局为 `replied` 时最终回复已写进会话历史。
  - plugin-agent：删除插件配置键 `historyLimit`（原默认 50）。
- **升级须知**：
  - plugin-agent 的 `historyLimit` 在新版启动时按 schema 裁掉并告警。要保留每轮读进条数的上限，把旧值写进 `sessionConfig` 某一层的 `historyLimit`；不装摘要插件的部署要写在 `sessionConfig.defaults` 上，否则每轮读进全部活跃历史，只靠硬裁剪兜底。
  - 这一项同时是按条数压缩的线，上一节 memory-summary 的 `threshold` 也搬到这里：两个旧值都写过的，按想要的压缩时机取一个。
- **发布档位**：次版本：api-agent、plugin-agent（api-memory、plugin-memory-summary 见「全量压缩与按比例触发」）；plugin-memory-history 本节只改说明。plugin-agent 对 `@aalis/api-agent` 的下限抬到本批的新版本。

### 工作会话的结构性放行（@aalis/plugin-gateway）

受众只有 owner 的会话（房间类别 `owner-only`）没有「要不要开口」的问题，也没有刷屏要限，入站不再经过触发判定与流控。

- plugin-gateway：WebUI 与终端建的会话（不论在哪个工作区）、owner 的 IM 私聊以及它们的子会话跳过 `inbound:trigger` 与 `inbound:flow` 两个相位，指令相位之后直接派发：触发判定、禁言关键词与自禁言、禁言期的吞噬、冷却与限速对它们都不起作用，与 trigger-policy、flow-control 的作用域配置无关。群、别人的私聊与内部会话不变。新增可选依赖 session-manager 与 authority：会话管理不在时全部照常走，authority 不在时 owner 的 IM 私聊照常走全部相位。
- trigger-policy、flow-control 的 `scopes` 里写 `webui`、`cli` 的，管的只剩从 WebUI 或终端发进群、别人私聊与内部会话的消息。
- 已知局限：会话在 trigger-policy 建过状态之后才变成 owner-only 的，已有的闲置话题定时器保留到插件停用或重启。
- **破坏性**：挂在 `inbound:trigger`、`inbound:flow` 上的第三方中间件收不到 owner-only 会话的消息，这两个相位也不为它们发 `gateway:phase:done`；要覆盖全部入站的，挂在 `inbound:command`。
- **发布档位**：plugin-gateway 次版本。对 `@aalis/api-session-manager` 的下限抬到本批的新版本（运行时导入 `roomClass`）；新增的 `@aalis/api-authority` 依赖写 `>=0.10.0`，要用的 `isOwner` 已发布版本里就有。

### 结构化摘要（@aalis/plugin-memory-summary）

摘要改为按会话选的固定小节，不能再自定义提示词。

- 场所是聊天窗口的根会话（多方窗口、对端不是 owner 的一对一窗口）用「最近在聊什么」「谁有问题没回应」「关键原话要点」；其余会话（owner 自己的、内部的与全部子会话）用「目标」「做过的决定」「改过的文件」「未完成的事」。没有内容的小节写「无」；有旧摘要时按同名小节合并，旧摘要没有这些小节或换过模板时按意思归入对应小节。用工作模板时，待摘要部分里最后一次 `manage_todo_list` 的参数作为最后一行，「未完成的事」以它为准。
- 新增可选依赖 authority，判一对一窗口的对端是不是 owner，不装时按不是；没有会话管理时一律用工作模板。
- **破坏性**：删除配置键 `summaryPrompt`。
- **升级须知**：`summaryPrompt` 在新版启动时按 schema 裁掉并告警。现有的无结构摘要不用迁移，下一次压缩时按模板合并重写。
- **发布档位**：plugin-memory-summary 次版本（与「全量压缩与按比例触发」同一版）。对 `@aalis/api-session-manager` 的下限抬到本批的新版本（运行时导入 `roomClass`）；新增的 `@aalis/api-authority` 依赖写 `>=0.10.0` 即可。

### 触及解析与受保护清单（新包 @aalis/api-reach、@aalis/plugin-reach；@aalis/api-authority、@aalis/plugin-authority、@aalis/create-aalis）

新增触及：一次工具调用能读写本机的哪些路径、命令在沙箱里还是宿主上执行、能不能联网，由触及服务按调用签发的凭据回答。本批只交付契约与服务，工具与存储还没有接入，装上它不改变现有工具的行为。说明见 `docs/plugins/plugin-reach.md` 与 `docs/api/api-reach.md`。

- **新包 `@aalis/api-reach` 0.1.0**：
  - 权限四档 `ACCESS_TIERS`（只读、修改确认、工作区、全权）与越界策略 `BoundaryPolicy`（`ask`、`deny`），经 declaration merging 加会话设置键 `accessTier`、`accessOnBoundary`。这两项本批还没有插件登记，设不了，一律按默认的工作区档、越界时问。
  - 纯函数 `resolveReach`：按主体与房间类别定上限，只有 owner 在 owner-only 的会话里有本地效果，再按档位收窄；子任务与父会话实时的触及取较小值。`judgeReach` 判一个目标放行、问或拒，会话受污染时（读进过别人写的内容）全权以外的档位把送出会话的动作改成问。
  - 三张受保护清单 `protectedLists`：宿主控制面，任何档位拒写、不可申请（实例家目录里白纸、临时区与技能目录以外的部分，主配置与 secrets.yaml，守护进程加载代码的目录，npm 形态下另有守护进程的入口文件与安装集的 `package.json`）；持久化与自动执行落点（git 目录里的配置、钩子、`commondir`、整棵 `modules` 与 worktree 管理目录，不叫 `.git` 的 git 目录按真实路径锚定、里面的 `HEAD` 照常可写；shell 与登录配置、`~/.ssh`、git 的用户配置与开机自启的目录；项目里会被工具自动执行的配置与项目指令文件，编辑器与其他代理的项目配置目录本身；`~/.config`、Linux 的 `~/.config/systemd`、macOS 的 `~/Library` 目录本身；白纸里项目自己的 `.aalis/`）；拒读清单（实例家目录里 `stage/`、`self/`、日志与主配置以外的部分与 secrets.yaml，同一用户下其他实例的家目录，凭据目录与文件，`.env` 一类文件，浏览器的配置与数据）。`matchesRule` 判路径落不落在一条规则里，`withRealRoots` 给链接到别处的根按真实路径补一份。
  - 沙箱策略 `sandboxPolicyOf`：提权分范围外写（`writePaths`，并进可写的根，其下的落点照样拒写）与按落点批准（`landingPaths`，只放回那一个确切路径）。
  - 凭据类型 `ReachCredential` 与不可枚举的品牌 `REACH_CREDENTIAL`、`isReachCredential`；服务描述符 `reach` 与 `ReachService`（`forCall`、`markTainted`、`provenanceOf`）。
- **新包 `@aalis/plugin-reach` 0.1.0**：提供 `reach` 服务。按一次工具调用签发凭据：发起类别取权限服务的 `originOf`，房间类别、档位、场所与绑定取会话管理里的记录；降档与受污染对已签发的凭据立即生效，全权档的凭据不带来源。另管：
  - 本会话临时区：实例家目录的 `tmp/sessions/<会话 id 的十六进制>/`，0700，随会话删；启动时与每天清扫一次 7 天没有改动、会话也不在运行的。删除与清扫在后台跑，单个删不掉记 warn。
  - 子进程环境：取 owner 的 login shell 的环境，取不到时用守护进程的环境、1 分钟后再取；沙箱内去掉凭据类变量、密码管理器的会话令牌、名字含 WEBHOOK 的变量、带密码的网址、npmrc 的凭据行与证书私钥、git 的命令行配置。
  - 会话的污点与白纸的来源账本，存在插件数据 `reach/provenance.json`。
  - 清单按真实路径生效：链接到别处的 shell 配置、git 配置、`~/.ssh`、主配置与 secrets.yaml 同样受保护。场所的白纸与主目录按会话的场所取（见下文「设置层表与场所」）。
- **create-aalis**：standard 与 full 档带上 `@aalis/plugin-reach`。
- **破坏性**：api-authority 的 `AuthorityService` 新增必填方法 `originOf(turn)`（这一轮由谁发起，取值见 api-approval 的 `OriginKind`）与类型 `OriginTurn`，自己实现权限服务的要补上；api-authority 新增对 `@aalis/api-approval` 的依赖（只用类型）。plugin-authority 实现它，执行守卫改用它，行为不变。
- **发布档位**：api-reach、plugin-reach 首发 0.1.0；api-authority 次版本；plugin-authority、create-aalis 为 patch。两个新包对 `@aalis/api-authority`（`originOf`、`OriginTurn`）与 `@aalis/api-session-manager`（`roomClass`、`rootSessionOf`、`placePaperId` 与相关类型）的下限现写 `>=0.10.0`，发布时抬到本批的新版本；plugin-authority 对 `@aalis/api-authority` 的下限同样抬。新包对 api-host-paths（本批新包）、api-process、api-storage、schema-message 的下限，用到的接口在已发布版本里都有。

### 设置层表与场所（@aalis/api-session-manager、@aalis/plugin-session-manager、@aalis/api-gateway、@aalis/api-session-protocol、@aalis/plugin-session-server、@aalis/plugin-webui-client、@aalis/plugin-paper、@aalis/plugin-agent、@aalis/plugin-persona、@aalis/plugin-cli、@aalis/plugin-skills、@aalis/plugin-asr-openai、@aalis/plugin-asr-whisper-cpp、@aalis/plugin-trigger-laya、@aalis/plugin-doctor、@aalis/plugin-reach）

会话设置的层由一张层表定义：全局默认 → 平台档 → 平台类型档 → 场所 → 父会话 → 本会话。每个会话恰好属于一个场所，按房间的设置设在场所上，换会话不丢；平台档下的群与私聊条目换成按平台类型的一档。默认模型只在 llm 服务偏好一处，与会话设置项重复的插件配置删除，每个值只在一处设。说明见 `docs/plugins/plugin-session-manager.md` 的「层表」。

- **层表与场所**（api-session-manager、plugin-session-manager、api-gateway）：
  - 场所：IM 的群与别人的私聊是窗口，键为 `平台:类型:目标`（api-gateway 的 `windowKey`，不含机器人账号，同一个群几个账号的会话是同一个窗口；平台名、类型名里的 `%` 与 `:` 转义）；本机的会话与 owner 的 IM 私聊在工作区，键为 `workspace:<id>`，默认工作区为 `workspace:default`。子会话取根会话的场所。有出生平台的根会话一律按窗口，聊天窗口缺失或目标为空的坏数据也按窗口（日志点名），不落进默认工作区；认 owner 的 IM 私聊用 `optional(authority)`，不装时按窗口算。
  - 场所记录存在记忆后端的元数据命名空间 `places`，随会话表加载与落盘：默认工作区激活时就在；窗口的记录在房间建档时、或那个窗口下一条真人消息到达时建，显示名随入站更新，群改名后同一窗口各账号的会话都刷新。项目工作区由 `addWorkspace` 登记（同一个真实路径只登记一个，编号随机），`removeWorkspace` 只删记录与场所设置、不动文件；会话协议与界面本批还没有登记工作区的入口。
  - 设置项登记可写 `narrowest: 'place'`：只能设到场所为止，会话自己的覆盖不收它；会话上存着的旧值（本会话的覆盖、父会话给子会话的默认值）不参与解析，每个会话每项告警一次。
  - 宿主配置的 `sessionConfig` 只认 `defaults`、`platforms`、`types` 三段；`audiences` 等不认识的段与名字不合写法的平台名、类型名（空串、`*`、带 `:`）告警一次后忽略，从界面改任一层时从配置文件删掉。选层读会话记下的字段，不从会话 id 推平台。
  - 默认模型只有一处：字段类型为 `llm-ref` 的设置项（「模型」）在全局默认层读写的就是 llm 服务的偏好（运行态与配置文件的 `servicePreferences.llm`），写在 `sessionConfig.defaults` 里的告警后忽略。全局默认之上各层都没设时，会话的生效配置里没有模型，交给 llm 服务按偏好、提供者优先级与登记先后解析。只写了提供者的偏好不再拆成模型引用。偏好改了、llm 提供者上下线时同样发 `session:config:changed`。
- **会话协议与界面**（api-session-protocol、plugin-session-server、plugin-webui-client）：
  - 会话摘要删 `audience`，加 `chat`（类型名与多方标记）与 `place`（键、类别、显示名）；设置层为 `defaults`、`platform`、`type`、`place`，设置行的来源为层名，`session/config/layers` 另回层表 `order`（各层的名字与称呼，按先后）；设置行加 `resolved`（服务此刻实际用的模型）。只能设到场所为止的项不进会话的行；没有记录的场所键回参数错误。
  - 「会话默认」可选平台类型档；全局默认层的「模型」就是默认模型，没设时写「默认（…）」，偏好指向的模型不在时标出。会话设置面板每项写来源，可以改到这个会话、这个场所或所有会话，被更窄的层压住时写明改了不生效。房间页每行有「场所设置」。会话头部写场所与平台。系统页的服务偏好不再单列模型服务，改为指向「会话默认」。
- **plugin-paper**：白纸与远端代理的六项设置只能设到场所为止，按窗口设，换会话不丢。不写名字的房间白纸一个窗口一张，id 为 `p:` 加场所键的 UTF-8 十六进制（api-session-manager 的 `placePaperId`），白纸目录名随之改变。诊断项与「共用的房间」按平台档、平台类型档与场所判。
- **plugin-agent**：默认模型只在 llm 服务偏好，激活与重载不再改写它。偏好指向的模型不在、服务落到别的模型上时照常用它，每个（偏好，实际）组合告警一次。「最大工具迭代」没设时为 30。「模型」设置项的说明改为没设置时用全局默认层的，那里也没设时用第一个可用的对话模型。`/session` 的来源按层表写，模型那一行之后另写这一轮实际会用的模型。
- **人设与技能**（plugin-persona、plugin-cli、plugin-skills）：主卡固定为人设目录里的 `default`，换卡只经会话设置「人设」。终端的欢迎行、头部、回复署名与状态页按终端会话生效的人设取名字。角色卡的技能白名单按调用所在会话的人设取（`list_skills`、`load_skill`、技能发现与触发词），`load_skill` 拒绝白名单之外的技能；plugin-skills 新增可选依赖 session-manager。
- **服务优先级**（plugin-asr-openai、plugin-asr-whisper-cpp、plugin-trigger-laya）：登记优先级改为常量（asr-openai 50、whisper.cpp 80、Laya -10）。转写后端由 plugin-media 的 `audio.prefer` 选，服务偏好 `servicePreferences.asr` 只在优先级相同时决胜；要用 Laya，改 `trigger` 的服务偏好。
- **plugin-doctor**：新增内置检查「服务偏好未生效」（`services.preferences`）：配置文件里的服务偏好指向的提供者不在时报 warn，写明实际在用哪个与改法（llm 指向「会话默认」的「模型」）；新增可选依赖 host-config。
- **破坏性**：
  - api-session-manager：新增层表 `SESSION_LAYERS` 与类型 `SessionLayerName`；`SessionConfigLayer` 删 `audience`，加 `type`（平台名加类型名）与 `place`（场所键）；`SessionInheritance` 删 `audience`、加 `type`（场所经 `placeOf` 取）；`InheritanceSource` 的取值为 `defaults`、`platform`、`type`、`place`、`parent`。新增 `SessionPlace`、`PlaceInfo`、`WorkspaceInfo`、`placePaperId`，服务方法 `placeOf`、`getPlace`、`addWorkspace`、`listWorkspaces`、`removeWorkspace`、`resolvedDefaults`，`SessionInfo.workspace` 与 `SessionCreation.workspace`（须是已有的工作区；在项目工作区里建会话必带绑定 `work`，默认工作区不收），`SessionSetting.narrowest`。删除本批前文加的 `RoomAudience` 与 `SessionInfo.audience`；`sessionKind` 改按有没有出生平台判；`setCurrentDir` 对全部会话开放；`getOwnConfig` 不交出只能设到场所为止的项，`childConfig` 也不复制它们。自研 session-manager 要实现层表上的各层、场所与工作区。
  - api-gateway：新增 `windowKey`、`parseWindowKey`；删除本批前文加的 `resolveSessionOrigin` 与 `SessionOrigin`。
  - api-session-protocol：摘要、设置层、来源与 `session/config/layers` 的回包如上，第三方前端照新的形状改。
  - plugin-agent：删除插件配置 `defaultLLM`、`maxToolIterations`。`/session` 的来源称呼改为「全局默认」「平台档 <平台>」「平台类型档 <平台> · <类型>」「场所『<显示名>』」「父会话」，按文本解析它的脚本要改。
  - plugin-persona：删除插件配置 `persona`。
  - plugin-asr-openai、plugin-asr-whisper-cpp：删除配置 `priority`；plugin-trigger-laya 同样删除。
  - plugin-skills：技能白名单由总按主卡改为按会话的人设。
  - plugin-session-manager：`sessionConfig.audiences` 不再读取。
- **升级须知**：
  - plugin-agent 的 `defaultLLM`、`maxToolIterations`，plugin-persona 的 `persona`，plugin-asr-openai 与 plugin-asr-whisper-cpp 的 `priority` 在新版启动时按 schema 裁掉并告警，要搬的值在升级前记下。
  - 宿主配置 `sessionConfig.audiences` 原样改名为 `types`，里面的 `<平台>.group`、`<平台>.private` 不变。要在升级后第一次从界面改会话设置之前改：那一次保存会把 `audiences` 从配置文件删掉。照前文「新 WebUI：外壳、会话与插件登记的会话设置」的升级须知迁 `platformProfiles` 时，带 `audience` 的条目直接写到 `sessionConfig.types.<平台>.<group 或 private>`。
  - 默认模型：`sessionConfig.defaults.llm` 与 plugin-agent 的 `defaultLLM` 并进 `servicePreferences.llm`，写作 `<提供者实例 id>/<模型>`；两处都写了的取 `sessionConfig.defaults.llm`（原来决定回复的是它），都没写的保持现有偏好；然后删掉 `sessionConfig.defaults.llm`。
  - plugin-persona 的 `persona` 不是 `default` 的，写进 `sessionConfig.defaults.persona`；plugin-agent 的 `maxToolIterations` 不是 30 的，写进 `sessionConfig.defaults.maxToolIterations`。
  - 改过 asr 的 `priority`、使按原优先级选出的后端与现在不同的，写 plugin-media 的 `audio.prefer`（处理器名为 `asr:<插件实例 id>`）。靠 plugin-trigger-laya 的 `priority` 让 Laya 生效的，改为在 `servicePreferences` 写 `trigger: "@aalis/plugin-trigger-laya"`。
  - 会话自己的覆盖里写着白纸六项的，改设到这个窗口的场所上（房间页的「场所设置」，或在会话设置面板改到「这个场所」），再清掉会话上的值；同一窗口几个会话写了不同的值时，自己定取哪个。
  - 场所记录不用预建：默认工作区激活时就在，窗口的记录在那个窗口下一条真人消息到达时建，建了之后才能在这个场所上设值。
- **发布档位**：次版本：api-session-manager、plugin-session-manager、api-gateway、plugin-agent、plugin-persona、plugin-asr-openai、plugin-asr-whisper-cpp、plugin-skills；plugin-paper、plugin-session-server、api-session-protocol、plugin-reach 随首发；plugin-webui-client、plugin-cli、plugin-doctor 为 patch；plugin-trigger-laya 不发布。要抬的依赖下限（抬到本批的新版本）：`@aalis/api-session-manager`（`SESSION_LAYERS`、`placePaperId`、`placeOf` 等）由 plugin-session-manager、plugin-session-server、plugin-agent、plugin-paper、plugin-reach 抬，它们运行时导入 `SESSION_LAYERS` 或 `placePaperId`；`@aalis/api-gateway`（`windowKey`、`parseWindowKey`）由 plugin-session-manager 抬。plugin-skills 新增的 `@aalis/api-session-manager` 依赖、plugin-session-manager 新增的 `@aalis/api-authority` 依赖与 plugin-doctor 新增的 `@aalis/api-host-config` 依赖，用到的接口在已发布版本里都有，分别写 `>=0.10.0`、`>=0.10.0`、`>=0.1.0` 即可。

### 凭据文件的权限与时间线里的图片（@aalis/api-storage、@aalis/plugin-storage-local、@aalis/plugin-webui-server、@aalis/plugin-message-archive）

WebUI 的登录凭据只给运行 Aalis 的系统用户读写；WebUI 上传与 OneBot 落盘的图片在时间线里显示成图片。

- **api-storage**：`StorageService.writeFile` 新增可选参数 `options`（类型 `StorageWriteOptions`）。`secret: true` 表示内容是凭据，只给运行 Aalis 的系统用户读写；做不到的提供者应拒写，不得写成别人读得到的文件。存储网关（`createStorageGateway`）把它传给提供者。
- **plugin-storage-local**：实现 `secret`，以 0600 写，覆写已有文件时一并收紧；临时文件建出时就带目标权限位，内容从不以更宽的权限落盘。
- **plugin-webui-server**：登录 token 文件与 `access.txt` 按凭据写（0600），读回的已有 token 文件一并收紧，收紧失败记 warn。此前按默认权限写，同一台机器上的其他系统用户可能读得到。
- **plugin-message-archive**：入站附件的地址按存储全部提供者的根认定（此前只认当前胜者的根），WebUI 上传的图片与 OneBot 落盘的图片在时间线里显示成图片。
- **升级须知**：升级后第一次启动即按凭据重写 `access.txt` 与持久化的 token 文件。自己实现存储提供者的，带 `secret` 时按凭据写或拒写。
- **发布档位**：patch（api-storage 只加可选参数）。plugin-storage-local、plugin-webui-server 对 `@aalis/api-storage` 的下限抬到本批的新版本：webui-server 经 api-storage 的存储网关传 `secret`，旧版网关会把这个选项丢掉。

### 必须同批升级的包

- plugin-memory-inmemory、plugin-memory-sqlite、plugin-memory-mongodb、plugin-memory-history、plugin-memory-vector、plugin-message-archive、plugin-agent、plugin-adapter-onebot、plugin-user-profile、plugin-user-relation 与 schema-message 同批升级：它们在运行时引用 `WellKnownMetadataKeys` 新增的 `GroupId`、`GroupName`、`SessionType`、`MessageId`，配旧版 schema-message 时常量为 undefined，按它读的元数据静默读空。
- plugin-authority、plugin-tools、plugin-agent、plugin-commands、plugin-session-server 与 api-authority、api-approval、api-commands 同批升级：新版 authority 按 `ExecutionGuardContext.inbound` 判发起类别、经 approvals 请 owner 审批，配旧版 plugin-tools（不传 `inbound`）时一律按不能产生审批处理；旧版 session-confirm 不能与新版 authority 共存（确认通道已删）。
- plugin-gateway 与 api-gateway 同批升级：旧版 gateway 仍调度已删的 `inbound:confirm` 相位。
- plugin-agent、plugin-checkpoint、plugin-session-manager、plugin-storage-local 与 api-agent、api-checkpoint 同批升级：checkpoint 改从 `agent:input:before` 取 agent 的 `turnId` 记回合，配旧版 agent 时拿不到回合 id、写入不再记账；新版 session-manager 按 `turnId` 登记在飞回合；新版 storage-local 经 api-checkpoint 的描述符找 checkpoint，配旧版 checkpoint（描述符在插件包里）时找不到、写入不受保护。
- plugin-session-manager、plugin-tool-onebot 与 api-platform 同批升级：新版 `resolvePlatformBySession` 返回适配器条目，旧版返回适配器本身。plugin-adapter-onebot 多实例部署时也要同批：旧版没有 `canHandle`，新版 api-platform 按它路由。
- plugin-paper、plugin-image-sender、plugin-publish-review、plugin-webui-server 与 schema-message 同批升级：前三者在运行时导入 schema-message 新增的 `awaitDelivery`，plugin-image-sender 与 plugin-webui-server 另导入新增的 `outboundMediaMessage`。发布时它们对 schema-message 的依赖下限要抬到含这些导出的版本，否则配旧版 schema-message 会在加载时找不到导出。
- plugin-session-manager、plugin-session-server、plugin-agent、plugin-persona、plugin-tools、plugin-memory-history、plugin-memory-vector、plugin-tool-session、plugin-user-relation、plugin-paper、plugin-subtask 与 api-session-manager、api-memory 同批升级：会话设置改由各插件登记，新版 session-manager 拒绝没登记的键，旧版插件不登记，它们的设置项会写不进去也不显示；旧版 session-manager 没有 `registerSetting`，新版插件登记时抛 TypeError。
- plugin-session-server、plugin-memory-summary、plugin-webui-server 与 api-memory 同批升级：手动压缩改调 `compression` 服务，旧版 memory-summary 只听已删的 `session:compress` 事件，压缩会报服务不在。
- plugin-session-server、plugin-cli 与 api-approval 同批升级：审批面推送的 `settled` 改为接收结算对象。
- plugin-webui-client 与 plugin-webui-server、plugin-session-server 同批升级：新前端只走 `/session` 与 `/admin`，旧版 webui-server 没有 `/admin`、旧版前端连不上已删的 `/ws`。
- plugin-webui-server、plugin-session-server 与 api-session-protocol、schema-message 同批升级：新版 webui-server 下载会话文件时调会话服务的 `resolveFile`，旧版 session-server 没有它；新版 webui-server 以 `outboundMediaMessage('file')` 记文件，旧版 schema-message 不收 `file` 会抛 TypeError，WebUI 会话的出站记录写不进去。发布时两者对 schema-message 与 api-session-protocol 的依赖下限抬到本批的新版本。
- plugin-adapter-onebot 与 api-trigger、schema-message 同批升级：新版适配器把群友之间的戳一戳也转为入站，并以 `noticeTargetIsSelf: false` 标明不是戳机器人；旧版 api-trigger 的 `isAddressed` 不看这个标记，会把每次群友互戳都当作点名。
- plugin-session-manager 与 plugin-agent、plugin-webui-client 同批升级：新版会话页调 `getInheritance`，旧版 session-manager 没有这个动作；新版 session-manager 删了 `getInheritedDefaults`，旧版会话页取不到继承值；新版 agent 的 `/session` 调 `resolveInheritance`，配旧版 session-manager 会抛 TypeError；`getSessionTree` 的回包改成了分区，新旧 webui-client 与 session-manager 混用时，会话页按另一种形状读回包，渲染时抛错。
- 启用 plugin-paper 时，plugin-agent、plugin-session-manager、plugin-message-archive、plugin-memory-vector、plugin-memory-history、plugin-user-relation、plugin-user-profile、plugin-storage-local、plugin-checkpoint 须同批升级，用 DeepSeek 的另加 plugin-llm-deepseek，要发回网页与 MP4 的另加 plugin-adapter-onebot。旧版 plugin-agent 不填 `ToolCallContext.inbound`，白纸工具一律拒绝；旧版 session-manager 没有 `resolveInheritance`，诊断项与白纸页的白纸表抛 TypeError；旧版的 agent、归档、向量记忆与抽取插件不认识 `hostNotice`，完成通知会按普通消息呈现、归档为 user、进向量库与抽取窗口；旧版 memory-history 把完成通知带进同平台其他会话的跨会话注入；旧版 storage-local 没有 `paper` 根，成品取不回；旧版 checkpoint 会给 `paper` 根记账，别的会话回滚时删掉成品；旧版 onebot 适配器跳过文件附件，网页发不出去。
- plugin-process-local 与 plugin-tool-system、plugin-tool-code-runner、plugin-code-sandbox-os 同批升级：中止实现在 process 提供方，旧版 process-local 静默忽略 `signal`，新版 exec 与代码执行照样停不掉，code-sandbox-os 的探测照旧拖满宽限；plugin-tool-code-runner 的沙箱路径还要新版 code-sandbox-os 把 `signal` 转交下去。
- plugin-webui-server 与 plugin-agent 同批升级：新版 webui-server 不再给 token 快照填 `platform`，配旧版 agent 时 IM 房间的快照按 webui 算。
- plugin-tool-system 与 plugin-agent、schema-message 同批升级：旧版 agent 不认 `hostNotice.callerUserId`，结束通知回合里的身份链会断；旧版 tool-system 不发结束通知。
- plugin-persona、plugin-skills 与 plugin-storage-local 同批升级：新的默认目录 `personas:/`、`skills:/` 只有新版 storage-local 提供，配旧版时人设卡与技能读不到。
- runtime 与 plugin-storage-local、plugin-package-manager、plugin-webui-server 同批升级：新版 storage-local 与 package-manager 依赖 runtime 提供的 `host-paths`，配旧版 runtime 一直停在 pending（存储不可用，几乎所有插件随之挂起）；新版 webui-server 配旧版 runtime 时找不到前端，市场与系统组件页回 503。反过来，新版 runtime 配旧版 storage-local 时，存储根仍按启动目录解析，与家目录分成两处。create-aalis 生成的新项目要新版 runtime：旧版不认 `appDir` 与 `defaultHome`，会到启动目录找配置。
- plugin-asr-whisper-cpp、plugin-draw、plugin-tool-browser、plugin-publish-review、plugin-mcp-client 与 schema-config 同批升级：路径字段的校验在 schema-config 里，配旧版 schema-config 时相对路径照旧放行。
- runtime、schema-config、api-host-config、plugin-webui-server、plugin-webui-client、plugin-mcp-client 同批升级：新版 webui-server 改配置、新建实例与新版 mcp-client 的 `mcp_set_server_enabled` 都调 host-config 的 `applyPluginConfig`，旧版 runtime 没有这个方法，调用抛 TypeError；旧版 webui-server 配新版 runtime 时，改配置仍按「`updateConfig` 后 `setPluginConfig`」写、混用文档形态与运行态：请求里没带的密钥字段以引用交给插件，插件激活失败，带了原值的被新版 `setPluginConfig` 拒收，列表接口还会回出原值；新版 webui-server 回给前端的是引用，旧版 webui-client 不认识它。
- 页面插件（plugin-paper、plugin-publish-review、plugin-works-site、plugin-scheduler、plugin-workflow、plugin-authority、plugin-skills、plugin-doctor、plugin-tool-browser、plugin-user-relation、plugin-file-reader）与 api-webui、plugin-webui-server、plugin-webui-client 同批升级：旧版插件调用已删的 `registerPage`、`registerAction`，新版插件经 `definePage` 调新版 webui-server 才有的 `addPage`，新旧混用时页面登记不上；旧版前端不认识第二版页面。发布时这些插件对 api-webui 的依赖下限抬到本批的新版本。
- plugin-checkpoint、plugin-session-server 与 api-checkpoint 同批升级：新版会话服务的 `turn/checkpoint` 调 `execUsed`，旧版 checkpoint 没有它。
- plugin-publish-review、plugin-works-site 与 api-publish 同批升级：新版作品站页的缩略图取 `thumbnailUri`，旧版作品审核没有它。
- plugin-agent、plugin-session-server、plugin-llm-openai、plugin-llm-deepseek 与 schema-message 同批升级：新版会话服务按 `toolCallProgress.callId` 把生成进度对到工具卡，旧版 agent 不带它；旧版服务商插件同一帧只报最后一个调用的进度。
- plugin-session-server、plugin-tool-system、plugin-webui-client 与 api-tools、api-session-protocol 同批升级：退出码按 exec 声明的 `display.result` 取，旧版 tool-system 不声明；新版会话服务会发 `aborted` 状态与 `display.exitCode`，旧版前端不认识。
- plugin-session-server、plugin-webui-server 与 api-storage 同批升级：两者在运行时导入 api-storage 新增的 `canIssueFileHandle`，发布时依赖下限抬到本批的新版本。
- plugin-user-relation 与 plugin-webui-server 同批升级：关系图的疏密改由 user-relation 的 `graphSpacing` 经关系图组件带出，旧版 webui-server 的 `relationGraphDefaultSpacing` 在新版里已删。
- plugin-webui-client、plugin-webui-server 与 api-webui 同批升级：新版 webui-server 的 `/api/pages` 会下发插件前端页面（`PageView` 的新形态），旧版前端不认识；新版前端挂载的框架要新版 webui-server 托管 `/frames`。
- api-llm 与 plugin-llm-deepseek、plugin-llm-openai、plugin-llm-ollama 以及会调模型的 plugin-agent、plugin-session-manager、plugin-memory-summary、plugin-user-profile、plugin-user-relation、plugin-media、plugin-adapter-onebot 同批升级：旧版调用方压低思考时带 `think: false`，新版提供者按档位 id 核对，不在档位里就抛错，摘要、标题、抽取这些调用全部失败；反过来，新版调用方带的档位 id 是字符串，旧版提供者当成布尔的真，`off` 也会打开思考。
- plugin-agent 与 plugin-session-manager、plugin-session-server、plugin-webui-server、plugin-webui-client 同批升级：「深度思考」的可选项要新版 webui-server 的 `llm-thinking` 来源，并经新版 session-manager、session-server 把 `dependsOn` 带到界面，混用时可选项取不到或按服务偏好的模型取。
- plugin-webui-client 与 plugin-webui-server 同批升级：新版前端用插件列表的新字段、`reload`、`/api/themes`、`/api/restart` 与 `/api/config`、`/api/models/llm` 的新回包，旧版服务端没有；旧版前端读已删的 `/api/service-groups`、`/api/llm-providers` 与插件列表的 `capabilities`。
- plugin-llm-deepseek、plugin-llm-openai、plugin-llm-ollama、plugin-usage-stats 与 api-llm 同批升级：服务商要套新版 api-llm 的 `metered` 才发 `llm:usage`，旧版服务商配新版记账插件什么都记不上；新版服务商在运行时导入 `metered`，配旧版 api-llm 加载时找不到导出。
- plugin-session-server、plugin-agent、plugin-webui-client 与 api-agent、api-session-protocol 同批升级：新版会话服务照 `token:usage` 的 `parts` 放进用量条目，旧版 agent 不带 `parts`，拆分表没有行；旧版前端读已删的 `breakdown`、`injectors`。
- plugin-webui-client 与 plugin-webui-server、plugin-session-server 同批升级：新版前端读 `/api/attention`、日志的筛选参数与 `attention.changed`，设置行读 `unset`，回复读 token；旧版前端读已删的 `GET /api/plugins/:name/config`。
- plugin-tools 与 plugin-tool-system、plugin-tool-code-runner、plugin-office、plugin-draw、plugin-media、plugin-mcp-client、api-tools 同批升级：新版工具不再自带超时，等多久交给新版执行器的让出时限；配旧版 plugin-tools 时不会转后台、也没有让出时限，exec 等调用一直等到回合被停止。
- plugin-session-server、plugin-webui-client 与 api-session-protocol、plugin-tools 同批升级：新版前端读摘要必填的 `background` 与 `background/*` 方法，旧版会话服务没有；新版会话服务投影的后台任务登记只有新版 plugin-tools 提供。
- plugin-subtask 与 plugin-session-manager 同批升级：新版子任务等子会话由 session-manager 收口（出错为 error、被停止为 completed 且最近一轮为 aborted），配旧版 session-manager 时出错或被停止的子会话一直停在进行中，`wait_subtasks` 等满才返回。
- plugin-agent、plugin-memory-summary 与 plugin-memory-inmemory、plugin-memory-sqlite、plugin-memory-mongodb、api-memory 同批升级：新版 agent 没设条数线时、新版摘要插件压缩时都以 `Infinity` 读全部活跃历史，压缩以 `archiveOldest` 归档；旧版 sqlite 后端遇 `Infinity` 报错，对话读不出历史，三家旧版后端都没有 `archiveOldest`，压缩一律失败。第三方记忆后端照「全量压缩与按比例触发」一节补上这两点。
- plugin-memory-summary 与 plugin-agent、api-agent 同批升级：自动压缩按 `token:usage` 新带的 `trimmed`、`untrimmedHistory`、`historyMessages` 判，旧版 agent 不带，自动压缩不会触发；条数线 `historyLimit` 也由新版 agent 登记。
- plugin-session-server 与 plugin-memory-summary、api-memory 同批升级：新版会话服务按会话调压缩服务的 `compressAt`，旧版 memory-summary 没有它，用量条目推不出去；旧版会话服务配新版 memory-summary 时界面上没有压缩刻度。
- plugin-authority、plugin-cli、plugin-session-server 与 plugin-session-manager、api-session-manager 同批升级：新版 authority 按会话管理记下的来源字段判发起类别，旧版 session-manager 不记这些字段，所有会话都判不出受众，owner 在哪里都不能产生审批；终端与 WebUI 的会话由新版 plugin-cli 与会话服务经建档参数写创建来源，配旧版 session-manager 时写不进去；新版会话服务还调 `placeOf`、`getPlace`、`resolvedDefaults`，旧版 session-manager 没有，会话列表取不出来。
- plugin-adapter-onebot 与 plugin-session-manager、api-platform 同批升级：新版 session-manager 在 IM 房间建档时按适配器的类型声明记下聊天窗口，之后不再改；旧版适配器按字符串声明类型、入站不带 `selfId`，配新版 session-manager 时它的私聊也按多方记下、聊天窗口里没有机器人账号，要改会话记录的 `originChat` 才能纠正。第三方平台适配器同理，先改好声明再升级 session-manager。
- plugin-persona、plugin-memory-history、plugin-memory-vector、plugin-tool-session、plugin-flow-control、plugin-maimai 与 plugin-session-manager 同批升级：它们读会话管理记下的出生平台与聊天窗口，旧版 session-manager 不记，从 WebUI 往房间插话时一律按入口平台算，合成回合取不到会话类型与群号，私聊里认不出一对一窗口。
- plugin-paper、plugin-reach 与 plugin-session-manager 同批升级：两者按 `placeOf` 取场所、按 `placePaperId` 算白纸，旧版 session-manager 没有 `placeOf`，白纸工具与签发凭据抛 TypeError；plugin-reach 另要新版 plugin-authority 的 `originOf`。
- plugin-webui-server 与 plugin-storage-local、api-storage 同批升级：token 与 `access.txt` 按凭据写（0600）要新版 storage-local 实现 `secret`、新版 api-storage 的存储网关把它传下去，配旧版时照旧按默认权限写，不报错。
- 走插件市场的，以上各组各自同一批勾选更新。
- 按 0.19.0 一节用 `overrides` 把 `@aalis/api-gateway` 固定在 0.7.0 的项目，不能单独升级 plugin-session-manager：它要用本批 api-gateway 新增的 `chatScopeOf`、`windowKey`、`parseWindowKey`，新版 api-gateway 另要本批 api-platform 的 `resolveSessionType`。要升级它，先去掉这条 `overrides`，连同 plugin-flow-control 与 plugin-trigger-policy 一起升。plugin-persona、plugin-agent、plugin-memory-history、plugin-memory-vector、plugin-tool-session 不再要求新版 api-gateway。

## 2026-09-27（core 0.19.0 minor；45 个包：22 minor / 22 patch / 1 新包 api-trigger）

回复闸门职责重组、模型触发插件与随之的修复，以及 0.18 推迟的低危缺陷修复（从「core 的插件状态机与日志」一节起）。用到本节新增接口的包间依赖下限已抬到本批的新版本：`@aalis/schema-message` 0.9.1（`buildIncomingContent`）由 plugin-message-archive、plugin-trigger-laya 抬；`@aalis/api-gateway` 0.8.0（`extractTargetId`、`inferSessionScope`、`isScopeEnabled`、`resolveEffectiveConfig`）由 plugin-flow-control、plugin-persona、plugin-trigger-laya、plugin-trigger-policy 抬；`@aalis/api-persona` 0.8.1（按会话取名字）由 api-trigger 抬，实现方 plugin-persona 一并抬；`@aalis/api-memory` 0.7.1（`clearMetadataNamespaces`）由 plugin-memory-summary、plugin-user-profile、plugin-user-relation、plugin-todo-list、plugin-adapter-onebot 抬，它们在运行时导入这个函数，不抬会在装到旧版 api-memory 时加载失败；`@aalis/util-network-guard` 0.6.3（`assertPortAllowed`）由 plugin-tool-browser 抬；plugin-flow-control 提供的是收窄后的 `FlowControlService`，`@aalis/api-flow-control` 的下限抬到 0.8.0；plugin-webui-server 与 runtime 的 `@aalis/core` peer 下限抬到 `>=0.19.0 <1.0.0`（禁用插件带配置的 `updateConfig` 只换配置、保持禁用，webui-server 的插件配置接口与 runtime 的配置热重载依赖这一语义），本批其余带 core peer 的包仍为 `>=0.18.0 <1.0.0`。用到 api-memory 结果行 `type` 或可选方法 `listMetadataKeys` 的 plugin-commands、plugin-memory-vector、plugin-checkpoint 与三家记忆后端（plugin-memory-sqlite、plugin-memory-mongodb、plugin-memory-inmemory）虽只是类型上的加法，也一并抬到 0.7.1；plugin-persona 只在开发依赖里引用 api-memory 的类型，发布的依赖里没有 api-memory，不涉及下限。其余新用到的接口在已发布版本里都有，也不必抬：plugin-llm-openai、plugin-llm-ollama 新依赖的 `@aalis/util-text-normalize`（`truncateChars`，0.5.2）；plugin-tool-browser 用到的 `pinnedLookup`、`assertAddressesSafe`（util-network-guard 0.6.2 已导出）；plugin-image-sender 用到的 `@aalis/api-storage` 的 `isStorageNotFound`、`isStorageUri` 与网关的 `readFileRange`（0.7.0）。

本批共 45 个包：22 个 minor、22 个 patch、1 个新包。

- 按次版本发布（22 个）：
  - 低危修复：core 0.19.0（禁用插件带配置的 `updateConfig` / `bounce` 改为收下配置并返回 true，required 依赖反复缺失时转 `error`）、runtime 0.15.0（插件入口改按 `import()` 的条件解析，只写 `require` 条件的插件改为跳过；启动时把上一轮的日志改名保留，公开导出的 `setupFileLogger` 同样先轮转；配置热重载须配本批 core）、plugin-commands 0.13.0（删除 `/clear list`，指令解析规则，`CLEAR_TYPES` 的类型）、plugin-doctor 0.8.0（`/doctor` 改为受限，等级 2 以下的用户不能再运行）、plugin-tool-browser 0.13.0（被拒连接的报错改为 `net::ERR_SOCKS_CONNECTION_FAILED`，`blockPrivate=true` 时不再使用系统代理）、plugin-memory-sqlite 0.12.0（公开导出的 `SQLiteMemoryService` 构造参数须带 `logger`）、plugin-user-relation 0.15.0（公开导出的 `RelationStore`、`RelationService` 的 `clearAll` 须传 `logger`）、plugin-image-sender 0.8.0（`send_attachment` 的拒收规则）、plugin-llm-openai 0.14.0、plugin-llm-ollama 0.12.0、plugin-llm-deepseek 0.14.0（读配置时拒绝带凭据或解析不了的 `baseUrl`，对话报错改写）、plugin-package-manager 0.8.0（`install` 的回执，`PackageManagerDeps.pluginStatus` 须返回 `instanceId`）、plugin-webui-server 0.14.0（管理接口的回执与状态码）、plugin-webui-client 0.14.0（读 webui-server 新增的 `appName`，须与它同批升级）
  - 回复闸门线：api-flow-control 0.8.0（`FlowControlService` 收窄，删除 `FlowSessionStateSnapshot`）、api-gateway 0.8.0（入站相位顺序改为 trigger 先于 flow）、api-platform 0.9.0（删除 `PlatformAdapter.checkAndRecordProactiveSend`）、plugin-adapter-onebot 0.15.0（删除适配器的 `checkAndRecordProactiveSend`，须与 plugin-tool-session 同批升级；请求事件合成的系统通知改带 `source`）、plugin-flow-control 0.12.0（闲置触发与计数的配置字段移出，服务收窄，须与 plugin-trigger-policy 同批升级）、plugin-persona 0.12.0（在运行时导入 api-gateway 0.8.0 新增的 `inferSessionScope`，升级它会把 api-gateway 一并带到新版，须与 plugin-flow-control、plugin-trigger-policy 同批升级）、plugin-tool-session 0.14.0（`delegate_to_session` 的拒收规则改由流控的禁言与限速判定，须与 plugin-adapter-onebot 同批升级）、plugin-trigger-policy 0.14.0（不再注册 `trigger-policy` 服务，删除 `TriggerPolicyService` 等类型，闲置触发与计数的配置字段迁入）
- 按 patch 发布（22 个）：
  - 低危修复：schema-config 0.13.1（只改 `name` 的说明文字）、util-network-guard 0.6.3（只新增公开 API：`pinnedLookup` 转为公开、新增 `assertPortAllowed`，`assertSafeUrl` 行为不变）、api-memory 0.7.1（只新增可选的结果行字段 `type`、可选方法 `listMetadataKeys` 与函数 `clearMetadataNamespaces`）、plugin-agent 0.15.1、plugin-checkpoint 0.13.1、plugin-cli 0.12.1（只改帮助页的日志提示）、plugin-draw 0.3.1、plugin-memory-inmemory 0.11.1、plugin-memory-mongodb 0.11.1（`MongoMemoryService` 标了 `@internal`，构造参数的变化不算公开 API）、plugin-memory-summary 0.12.1、plugin-memory-vector 0.13.1、plugin-session-manager 0.13.1、plugin-storage-local 0.12.1、plugin-todo-list 0.11.1、plugin-user-profile 0.13.1
  - 回复闸门线：api-media 0.11.1（只改 `processMessage` 的说明）、api-persona 0.8.1（`getPersonaName` / `getNickNames` 新增可选参数）、schema-message 0.9.1（新增 `buildIncomingContent`，更新 `source` 与 `triggerType` 的字段说明）、plugin-file-reader 0.13.1、plugin-media 0.15.1、plugin-message-archive 0.12.1（附件识别的写回与去重修复，接口不变）、plugin-gateway 0.7.1（只改了说明文字，但 `package.json` 的 description 与 README 写的是入站相位次序，随 api-gateway 的次序变化一并修正）
- plugin-adapter-onebot、plugin-flow-control、plugin-persona 另有本批的低危修复，这部分只够 patch，档位由回复闸门线定。
- 新包：api-trigger 0.1.0
- plugin-trigger-laya 0.1.0 是 `private` 包，不发布到 npm。
- plugin-scheduler、plugin-workflow 只改了注释，api-llm 只改了 `refresh` 的注释，api-authority 只改了 `network` 的注释，plugin-authority 只改了上报器失败来源的注释，本批不单独发布。

### 回复闸门职责重组（@aalis/plugin-flow-control、@aalis/plugin-trigger-policy、@aalis/api-flow-control、@aalis/api-gateway、@aalis/api-platform、@aalis/plugin-adapter-onebot、@aalis/plugin-tool-session、@aalis/schema-message、@aalis/plugin-message-archive、@aalis/api-media、@aalis/plugin-media、@aalis/plugin-file-reader、@aalis/plugin-persona、新包 @aalis/api-trigger）

trigger-policy 收拢一切"要不要开口"：禁言关键词识别、@ / 戳一戳 / 名字直通、计数与活跃指数判定、闲置主动开口。flow-control 只做节流硬闸：禁言（含落盘与平台禁言同步）、回复后冷却、限速。入站相位随之对调为 `confirm → command → trigger → flow → dispatch`（顺序常量 `INBOUND_PHASE_ORDER` 在 `@aalis/api-gateway`）。

要不要开口由**触发插件**判定，新服务 `trigger`（契约包 `@aalis/api-trigger`）选出生效的那一个：触发插件各自 `provide(trigger, 自己的实例)` 并在 `inbound:trigger` 相位挂中间件，服务胜者（偏好 > 优先级 > 注册顺序）即生效者，二选一，其余触发插件对每条消息直接放行、什么都不做；没有触发插件时这一相位不做判定，消息照常进入 flow 相位。trigger-policy 是规则触发插件（优先级 0），作用域、禁言、禁言关键词、计数与活跃指数、点名识别与闲置主动开口都在它内部，判定同步完成；只装它时的判定即下文所述。它的计数、活跃指数与闲置活动时间只统计它生效时经过的消息，闲置主动开口也只在它生效时注入。每条判定记一行 debug 日志（不含正文）。`@aalis/api-trigger` 另导出触发插件共用的函数：生效者判断 `isActiveTrigger`（每次入站取下的胜者记在进程内全部 api-trigger 副本共用的表里）、禁言关键词 `hitsMuteKeyword`、名字表 `createBotNames`（按会话取人设，因此新依赖 `@aalis/api-session-manager`）、点名识别 `isAddressed`、放行收尾 `markTriggered`、吞掉时的影子归档 `archiveSwallowed`；写日志的函数由调用方传入日志前缀。切换触发插件：WebUI 服务页把 `trigger` 的偏好切到另一个，即时生效；停用生效的触发插件，下一条消息由剩下的接手；手改配置文件的 `servicePreferences` 需重启。禁言关键词、点名的别名与开关、作用域由各触发插件在自己的配置里分别设置，只有生效者的起作用，切换后按新生效者的配置执行；要在切换后保持一致，两边须同样配置。

行为变化：

- 被 @、戳一戳、叫名字（`immediate`）穿透冷却与限速；禁言期除外。
- 名字检测取 `triggerNames` 与全部已登记人设（`persona` 服务的全部提供者）的名字、昵称的并集，人设按会话取：与 agent 同一取法，经 session-manager 解析本会话的配置，其中的 `persona`（会话用的角色卡）传给 `getPersonaName` / `getNickNames`。会话改用别的角色卡时，算点名的是那张卡的名字、昵称，主卡的不算，别的会话不受影响；session-manager 缺席时取全局默认的卡，解析抛错时同样取全局默认的卡并记一条 warn（同一原因只记一次）。此前只取当前生效人设的主卡，会话改用别的卡时那张卡的名字不算点名。同时装了多个人设插件时，叫其中任何一个的名字都算点名。某个人设读名字抛错时只跳过它的名字、照常判定，记一条 warn（同一提供者同一原因只记一次）；此前整条判定异常，记 warn 后放行、不写 `triggerType`。
- 禁言期内一律不说话：flow 相位先查禁言，不看作用域、不看来源，闲置触发、跨会话委派、定时任务注入的消息同样被吞。禁言只在入站把关，挡的是禁言之后才开始的回合：命中禁言关键词时正在生成的回复照常发出。
- 内部注入（带 `source` 的消息：闲置触发、定时任务、workflow、跨会话委派）不经触发策略，不计数，`triggerType` 不被改写（委派的 `proactive` 原样保留）；flow 相位对它不查回复后冷却，禁言与限速照常生效（限速仅在会话落入 flow-control 作用域时）。这些消息不带会话类型，flow 判作用域时与回复记账同一口径：先用会话已记下的平台与类型，没有再按会话 ID 约定推断（见下文回复记账一条）；此前只看消息自带的类型，默认 `*:group` 下算作用域外（作用域配成 `*`，或配成 `onebot:*` 且消息平台为 `onebot` 时本来就在作用域内）。因此默认作用域 `*:group` 下配置了限速时（`rateLimitWindow` 默认 0，即关闭），bot 在某个群的限速窗口已满，发往该群的定时提醒、workflow 输出会被吞掉并做影子归档，定时任务不重试；session 档闲置提示同样被吞（闲置提示不归档）；委派在派发前就被限速闸拒绝。此前 flow-control 的 `scopes` 配成 `*` 时，定时提醒会被回复后冷却静默吞掉；trigger-policy 的配成 `*` 时，还会被计数判定吞掉。真人消息由平台适配器投递，不设 `source`；第三方适配器投递真人消息**不得**设置 `source`（`schema-message` 的字段说明已据此更新），否则会被当作内部注入跳过触发策略与冷却。
- adapter-onebot 把好友申请、入群邀请与加群申请合成的 `[系统通知]` 消息标上 `source: 'onebot-request'`，按内部注入处理：不经触发判定，不受回复后冷却约束，禁言与限速照常。此前它们不带 `source`，群里的加群申请被当作真人消息计数，计数未满时归档后吞掉，不作为当前消息送达 agent，只在该群下次触发时以历史出现。
- 第一方 plugin-subtask 派发给子会话的任务消息仍不带 `source`，入站相位按真人消息处理：触发插件的作用域里会话类型段为通配（`*`、`onebot:*` 等）时会被计数判定吞掉、子任务不启动，flow-control 的作用域为通配时子会话冷却期内的追问也会被吞；默认作用域 `*:group` 不受影响。
- 冷却期内的禁言关键词照常生效；平台禁言期内的关键词不再识别，不会缩短平台禁言。戳一戳通知不做禁言关键词匹配。
- 禁言期内的消息不累计计数。关键词禁言在命中时即清零本会话的计数与活跃指数；平台禁言在禁言期内有消息到来时清零——平台禁言期内若一条消息都没有，禁言前攒下的计数保留到解禁后。禁言期内的消息与命中禁言关键词的那条算闲置触发的会话活动：session 档闲置从这条消息起重排、退避复位为 1；此前 session 档不因禁言期的消息重排，解禁后闲置提示可能在群里刚有人说过话不久就发出。
- session 档闲置触发的退避只由真人消息复位，agent 回复（包括回复闲置提示）不再复位。
- platform 档闲置触发把注入本身记为 bot 开口，agent 沉默时不会反复挑中同一会话；禁言期内 session 档到点跳过。
- 冷却与限速只按 agent 的真实回复计，且只对 flow-control 作用域内的会话记账：按会话已记下的类型判；没有流控状态或状态缺类型的会话（重启后没人说话的群、消息都被 trigger 吞掉的群、只有禁言记录的群）按会话 ID 的 `<platform>:<self>:<type>:<target>` 约定推断类型与目标，推断结果只写进 flow-control 自己的会话状态，不回写消息；会话 ID 不符合约定的（如 WebUI）类型未知，只有会话类型段为通配的作用域（`onebot:*`、`*`）命中。默认 `*:group` 下委派、定时任务发往群的回复照常计入，前提是会话已有记下类型的流控状态，或状态里记下的平台（没有则用出站平台）与会话 ID 前缀一致（WebUI 与配置文件里建的定时任务平台默认是 `internal`，发往没有流控状态的群时不推断、不计）；发往私聊或 WebUI 的不计入，委派闸门对后者不设限；需要限制的在 `scopes` 里纳入。委派派发时不再预记一次回复，同一次委派不会被计两次，也不会在回复落地前给目标会话预设冷却。
- plugin-media 的 `processMessage` 按消息对象只处理一次：同一条消息再次调用（进行中则等它）返回同一份报告，不重复识别。写回 `_attachmentDescriptions` 时保留本插件不写的位：此前 file-reader 的预处理器先于 media 运行时（两者先后取决于登记次序），文件描述会被整表覆盖冲掉。写回 `attachments` 时不再整表替换，只给写回那一刻的数组逐项补 `mimeType`，识别期间 file-reader 换好的 `aalis-file://` 引用不会被改回原始数据；plugin-file-reader 的预处理器结尾同样只写文件附件自己的描述位，不再整表写回开头读到的描述，换 `aalis-file://` 引用时也按写回那一刻的附件展开，不丢识别期间补上的 `mimeType`。
- plugin-message-archive 的 `archiveIncoming` 对传入的消息对象调 `processMessage`，识别结果（附件描述、补齐的 `mimeType`）写回入参；此前对内部拷贝识别，入参不变。触发判定已启动的识别在归档时命中，不再识别第二遍。

**破坏性变更与迁移**：

- **配置字段搬家**：`fixedInterval` / `activityScoreLower` / `activityScoreUpper` / `activityDecayMinutes` / `scoreDecayMinutes` 与 `idleTriggerScope` / `idleTriggerStrategy` / `idleTriggerMinutes` / `idleTriggerStyle` / `idleTriggerMaxMinutes` / `idleTriggerJitter` / `idleTriggerPrompt` 从 plugin-flow-control 移到 plugin-trigger-policy，字段名与默认值不变；`overrides` 里的同名字段一并移动（`idleTriggerStrategy` 只看顶层，不进 `overrides`）。flow-control 只保留 `scopes` / `overrides` / `cooldownSeconds` / `rateLimitWindow` / `rateLimitMaxReplies`。不提供自动迁移。runtime 按新 schema 裁掉 schema 外字段并写回配置文件，启动、热重载与 `aalis <子命令>` 都会触发这一步，因此按下面的顺序迁移：
  1. 备份 `aalis.config.yaml`；
  2. 记下 flow-control 节里上述字段的非默认值（含 `overrides` 各项）；
  3. 停止运行中的进程；
  4. 按本节「必须同批升级的包」同批升级；
  5. 在配置文件中把上述字段从 flow-control 节移到 trigger-policy 节；
  6. 启动，核对非默认值未被回填为默认值。

  走插件市场的：市场更新会立即重启进程，flow-control 节的旧字段随之被裁掉。同批更新后在 trigger-policy 的配置页面重填第 2 步记下的值。
- **作用域归属**：计数、活跃指数与闲置触发改按 trigger-policy 的 `scopes` / `overrides` 生效，不再看 flow-control 的作用域。把 override 从 flow-control 搬到 trigger-policy 会顺带在 trigger-policy 启用该作用域（写一条 override 即视为启用）。trigger-policy 里已有同一 `scope` 的条目时应合并进去，不要另起一条：具体度相同时只取先出现的一项。flow-control `overrides` 里残留的旧字段不会被 runtime 裁剪（数组项不按 schema 裁），插件也不告警，需手动删除。
- **minimal 模板档**（只装 flow-control、未装 trigger-policy）配置过闲置触发的，升级后须装 plugin-trigger-policy 才有闲置触发。装上后默认按计数与活跃指数判定是否开口；要保持此前逐条回复的节奏，设 `intervalMode: fixed`、`fixedInterval: 1`。注意授权主体不同：群聊里未被 @ 的消息走 interval 判定，授权身份回填为无主体（工具按匿名等级执行），此前按发言者等级执行。
- **`@aalis/api-flow-control` 收窄**：`FlowControlService` 只剩 `isMuted` / `isCoolingDown` / `isRateLimited` / `setMuted`；删除 `getStateSnapshot` / `recordIncoming` / `recordTriggered` / `recordReply` / `getThreshold` / `rescheduleIdle` 与 `FlowSessionStateSnapshot`。计数与阈值归 trigger-policy 内部；冷却与限速由 flow-control 监听 `outbound:message` 自行记账，自建主动发送通道发 `source: 'agent'` 的 `outbound:message` 即被计入。
- **`@aalis/api-platform` 删除 `PlatformAdapter.checkAndRecordProactiveSend`**：跨会话委派改由 plugin-tool-session 直接查 flow-control（目标会话禁言中或限速已满即拒绝），适配器无需实现任何方法；自研适配器删掉该方法即可。自己调用过该方法做委派限速的第三方代码，改用 `flowControl.current?.isMuted(sessionId)` / `isRateLimited(sessionId)`（只检不记，限速按目标会话的真实回复计）。
- **plugin-trigger-policy 不再注册 `trigger-policy` 服务**：运行时描述符 `triggerPolicy` 与类型 `TriggerPolicyService` / `TriggerDecision` / `TriggerKind` 随之删除，原服务没有外部消费者。判定结果仍写在 `message.triggerType`。本插件改为向新服务 `trigger` 提供自己的实例（见本节开头）。
- **相位顺序**：注册在 `inbound:flow` 的第三方 handler 现在运行在 `inbound:trigger` 之后，能读到 `triggerType`；注册在 `inbound:trigger` 的第三方 handler 现在先于禁言、冷却、限速执行。依赖"flow 先于 trigger"的 handler 需改挂相位。

`@aalis/api-gateway` 另新增作用域纯函数 `extractTargetId` / `isScopeEnabled` / `resolveEffectiveConfig`，flow-control 与 trigger-policy 共用；以及 `inferSessionScope`：按会话 ID 约定推断会话类型与目标，从 plugin-persona 移入（persona 推断合成回合会话类型的行为不变，新增对 api-gateway 的依赖），flow-control 的入站过闸（带 `source` 且不带会话类型的内部注入）与回复记账也用它。

`@aalis/schema-message` 新增 `buildIncomingContent`：入站消息拼成归档文本（发送者前缀、引用回复、附件描述）的函数，从 plugin-message-archive 原样移入，归档行为不变；供触发判定拼当前消息时与归档共用同一份拼法。

另新增 `@aalis/plugin-trigger-laya` 0.1.0（`private: true`，不发布到 npm，不计入本批包数）：模型触发插件，经本机 HTTP 调用 laya-listener 侧车，由 Laya 模型判定作用域内（`scopes` / `overrides`，默认 `*:group`）的消息开不开口，没有计数。它在 `trigger` 服务里的默认优先级为 -10，低于 trigger-policy 的 0：两者同时启用时默认由 trigger-policy 生效；要用它，在配置文件的 `servicePreferences` 写 `trigger: "@aalis/plugin-trigger-laya"`，或在 WebUI 服务页切换 `trigger` 的偏好。@、叫名字、戳一戳不强制开口，只决定开口后记 `immediate` 还是 `interval`、授权主体是谁。点名识别用的名字表（按会话取人设）同时作为 `selfNames` 发给侧车，侧车渲染时把正文里的这些名字换成模型认识的 bot 代号；不认识该字段的旧侧车忽略它，插件与侧车的升级顺序无关。判定不了时（侧车连续 3 次失败后熔断 30 秒、memory 缺席、托管的侧车还在启动或等重启、侧车回 422 / 413、请求体超过侧车 1 MiB 上限、会话不是 onebot 的群聊或私聊）只回点名，其余消息归档后吞掉，不回退到 trigger-policy；422、413 与请求体超限只让这一条兜底，不计入熔断。侧车熔断、memory 缺席或托管的侧车退出使判定由可用转为不可用时记一条 error，恢复时记一条 warn；诊断项 `trigger.laya` 在它生效时报侧车状态，不生效时不检查侧车、报 ok；生效时最近 20 条带图消息（判定时附件识别已写回的）里有 10 条及以上的图片只有指针、没有内容描述，另报 warn，原因是 media 未开启图片到达即识别（`vision.recognizeOnArrival`），或没有可用的识别模型。带附件的消息先等识别写好描述，最多 `mediaWaitMs`（默认 8000 毫秒）。运行期自检：向侧车发请求前记下当前消息的哈希与长度，这条消息归档后与归档正文比对，按「一致 / 判定时缺附件描述 / 含文件附件 / 其它 / 未归档」计数，每结清 200 条记一行只含计数的 info 日志。配置了 `sidecarDir`（侧车目录的绝对路径）时侧车由它托管，不用另装系统服务：应用就绪后、它生效时经 process 服务拉起侧车（端口取 `endpoint` 的；CLI 子命令进程不拉起），启动约 11 秒内只回点名、不算判定不可用；侧车意外退出或没能拉起（含没有 process 服务）算判定不可用，按 1 秒起翻倍、封顶 60 秒的间隔重启；它不再生效或停用时先 SIGTERM、5 秒后 SIGKILL，Aalis 停机时由 process 服务直接强杀、不当成意外退出；侧车带 `--parent-pid`，Aalis 被强杀时自行退出；首次拉起前地址上已有侧车在答时不拉起、直接用它。`sidecarDir` 留空时侧车由外部运行。从仓库源码运行时它与其它插件一样被发现并默认启用，但默认不生效，群聊判定仍由 trigger-policy 负责；偏好切到它而本机没有侧车时，群里只回点名。说明见该包 README。

本批开发期间加入过、未随任何版本发布的配置已改：trigger-policy 删除 `decisionTimeoutMs` 与 `mediaWaitMs`（规则判定不看附件；等附件识别的上限改为 plugin-trigger-laya 自己的 `mediaWaitMs`）；plugin-trigger-laya 删除 `mode`（`off` / `shadow` / `live`，不想让某些会话走模型就把它们移出 `scopes`），`overrides` 只覆盖 `threshold`，新增 `scopes`、`triggerOnAt` / `triggerOnPoke` / `triggerNames`、`muteKeywords` / `muteTimeSeconds` 与 `mediaWaitMs`（此前由 trigger-policy 代管）。从开发分支升级的配置里残留的这几个顶层字段由 runtime 按 schema 裁掉并记一条 warn。plugin-trigger-laya `overrides` 各项不被裁剪（数组项不按 schema 裁），残留的 `mode` 不再生效，但条目本身仍会启用它的作用域（写一条覆盖即启用）：开发期用 `{scope, mode: shadow}` 或 `{scope, mode: off}` 表示「这里不走模型」的条目，升级后要整条删除，只删 `mode` 会让该作用域改由模型判定（如 `{scope: '*:private', mode: shadow}` 只删 `mode`，私聊就交给模型判定，判不回即吞掉）。原意是让某个群不走模型的，删掉覆盖还不够，`*:group` 仍覆盖它，要把它移出 `scopes`（见该包 README「切换与回滚」）。plugin-trigger-laya 的 `priority` 默认值由 10 改为 -10；runtime 会把 schema 默认值回填进配置文件（只补缺失的字段，不改已有值），跑过开发分支的配置里已写着 `priority: 10`，升级后仍由 Laya 生效，要回到默认就删掉这个字段，改用服务偏好切换。

### 同批其它改动（@aalis/api-persona、@aalis/plugin-persona、@aalis/plugin-adapter-onebot）

- api-persona：`getPersonaName` 与 `getNickNames` 新增可选参数 `options?: PersonaSessionOptions`：`options.persona` 指定会话用的卡时返回那张卡的名字、昵称，不传时返回主卡的，旧调用方不变。触发插件的名字表按会话传入。
- persona 的 `getPersonaName` / `getNickNames` 按传入的 `options.persona` 取卡（找不到该卡时回落主卡；卡没写名字时报那张卡的文件名），与 `getSystemPrompt` 等方法同一取法。
- persona 读角色卡的 `nick_name` 时校验类型：字符串列表的各项去掉首尾空白，非字符串与空串的项丢弃；写成单个字符串时按一个昵称取，此前触发插件的名字表把它拆成单字，含其中任一个字的消息都算点名；留空（null）与不写相同，不告警；其它类型整项忽略，每次载入该卡记一条 warn。
- adapter-onebot 合并转发的摘要不可用、信封退化为截断的原文时，改为代理安全截断：截断边界落在 emoji 中间时整字符丢弃，信封不再以孤代理结尾。此前孤代理随信封归档，再随历史窗口进入模型请求，会被严格的 JSON 解析器或分词器拒收。

**迁移**：自定义 persona 实现支持按会话选卡的，`getPersonaName` / `getNickNames` 按 `options.persona` 返回那张卡的名字、昵称；不支持的忽略参数即可（名字表按主卡取）。

### 必须同批升级的包

- plugin-flow-control 与 plugin-trigger-policy 同批升级：新版 flow-control 提供的服务已删除旧版 trigger-policy 调用的 `getStateSnapshot` / `recordTriggered` 等方法；相位顺序常量在 `@aalis/api-gateway`，它升到 0.8.0 后，已发布的旧版二者会按新顺序运行而失常。plugin-persona 与这两个包同批升级：新版 persona 在运行时导入 api-gateway 0.8.0 新增的 `inferSessionScope`，依赖下限为 0.8.0，单独升级它同样会把 api-gateway 带到新版。plugin-adapter-onebot 与 plugin-tool-session 同批升级：旧版 tool-session 经适配器的 `checkAndRecordProactiveSend` 做委派限速，新版适配器已删除该方法，委派限速闸会静默失效。走插件市场的，这五个包须同一批勾选更新。
- 暂不升级本节各包的项目注意反方向：`npm update` 或无锁文件重装可能把传递依赖 `@aalis/api-gateway` 升到 0.8.0（多个依赖方写的是 `>=0.7.0 <1.0.0`），已发布的旧版 flow-control 与 trigger-policy 随即按新顺序失常，请用 `package.json` 的 `overrides` 把 `@aalis/api-gateway` 固定在已发布的 0.7.0；这样固定时也不能单独升级 plugin-persona，它要求 api-gateway 0.8.0。

### core 的插件状态机与日志（@aalis/core）

- `disable` 清掉上一次激活失败留下的 `error`。此前从 `error` 态停用后，`getStatus()`、`getPlugin()` 与 WebUI 的 `/api/plugins` 仍带着旧的错误说明。停用本身超过宽限、转为 `error` 的，照旧写「未在宽限内停止」。
- 插件处于禁用态时，带配置的 `bounce(id, { config })` 与 `updateConfig(id, config)` 收下新配置、保持禁用、返回 true、不记 warn，启用时按新配置激活；不带配置的 `bounce` 照旧记 warn 并返回 false。此前两者对禁用插件一律记一条 WARN「处于 disabled 态，跳过」、返回 false、不换配置：配置文件热重载时每次都再记一次，之后启用插件仍按旧配置运行，要等下次热重载或重启才与文件一致。
- 初始化期间 required 依赖缺失的自动重试改为按插件计、跨重算累计：`apply` 里 required 绑定抛出不可用错误，与后台激活因 required 依赖下线被拆，两条路径记入同一份额度（首次取额时的 2×插件数+8）。用尽转 `error`，错误说明为「初始化期间 required 依赖反复缺失（最后一次缺 "<服务名>"），自动重试未收敛，已停止；enable 或 bounce 后重试」，点名用尽那一次缺的 required 服务，记一条 error，不再自动重试；激活成功、`enable`、`bounce` / `updateConfig` 时额度清零。此前额度只在单次重算任务内有效，用尽后停在 `pending`，下一次重算从头再计；后台激活被拆这条路径完全不计，慢 `apply` 里让自己的 required 依赖下线又恢复的插件每个阈值周期重试一次，没有上限。
- 慢激活转入后台时只记一条 warn，删去此后每隔 `slowThresholdMs` 一次的「仍在激活（已超过 N ms）」提醒。后台状态照旧经 `getStatus()` 的 `slow`、WebUI 的「激活中（超过阈值）」与 doctor 的 `plugins.slow` 查看。此前提醒定时器一直重排，嵌入 core、不调 `stop()` 就等进程自然退出的宿主会被永不落定的激活拖住，进程不退出；现在至多拖到阈值到点。
- `LogHub` 逐个隔离监听器：单个监听器抛错（含返回被拒的 Promise）不影响其余监听器，也不让日志调用抛出；监听器本身就是日志的去处，它的错误不再上报。此前一个抛错的 sink 会让日志调用本身抛出、排在后面的 sink 收不到这条日志，core 里直接调用日志的步骤（如插件登记）随之中断。
- 文档写明现状：重算逐个激活，每个慢激活单独等满一个阈值；排在前面的慢插件有 N 个时，后面插件的激活与 `register` / `pluginAll` / `idle()` 的返回约晚 N×阈值。

**行为变化与迁移**：
- 初始化期间 required 依赖持续失稳、自动重试用尽的插件停在 `error`，依赖恢复后不再自动激活，需 `enable` 或 `bounce`（WebUI 里用插件卡片的开关先禁用再启用，或点「编辑配置」原样保存）；此前停在 `pending`，下一次重算自动重试。doctor 的 `plugins.errored` 会把这类插件列为出错。
- 靠禁用插件的 `updateConfig` / `bounce` 返回 false 判断「插件已禁用」的调用方，改为先读 `getStatus()` 或 `getPlugin()` 的 `state`。依赖新语义的包须把 `@aalis/core` 的 peer 下限抬到本版：plugin-webui-server（插件配置接口）与 runtime（配置热重载）已抬到 `>=0.19.0 <1.0.0`。
- 按「仍在激活（已超过」筛日志的，改看 `getStatus()` 的 `slow` 或 doctor 的 `plugins.slow`。
- 用 `vi.useFakeTimers()` 测插件的：阈值到点后激活转入后台，不再挂定时器，`vi.runAllTimers()` 不会再在提醒定时器上空转。

### 浏览器工具的私网拦截改为连接级网络闸，页面与启动的修复（@aalis/plugin-tool-browser、@aalis/util-network-guard）

- `blockPrivate=true`（默认）时，私网与本机拦截从 CDP `Fetch` 请求拦截改为插件进程内的网络闸：插件在 `127.0.0.1` 的随机端口起一个只支持无认证 CONNECT 的 SOCKS5 服务，浏览器以 `--proxy-server` 把全部 TCP 连接交给它，并以 `--proxy-bypass-list=<-loopback>` 撤掉 Chrome 让 localhost、回环与链路本地地址默认绕过代理的规则。此前 WebSocket 连接不经拦截，页面可以连到本机与内网的 WebSocket 服务；现在与 http(s) 请求一样逐个判定。
- 域名只解析一次：闸用 `pinnedLookup` 解析并判定全部地址，连接只用这次解析的结果；IP 字面量须是规范写法（含 zone id 或不是规范写法的 IPv6 字面量直接拒绝），再经 `assertAddressesSafe` 判定；`allowedHosts` 里的主机照旧按名字直连。此前判定时由插件解析一次、连接时由 Chrome 再解析一次，TTL 为 0、公网与内网地址交替应答的域名能在两次解析之间换成内网地址（DNS 重绑定），`browser_navigate` 会把本机或内网服务的页面内容交给模型。
- 闸按进程级网络策略（宿主配置文档 `network` 字段）的 `allowedPorts` 判定目标端口，与 `safeFetch` 一致，`allowedHosts` 里的主机也不例外；不在列表里的端口回失败应答。此前的 CDP `Fetch` 拦截只判定主机，配了 `allowedPorts` 时页面照样能连到任意端口。
- `blockPrivate=true` 时 WebRTC 以 `--webrtc-ip-handling-policy=disable_non_proxied_udp` 启动，不再发不经代理的 UDP（以随附的 Chrome 实测）。此前页面可以经 WebRTC 向本机与内网的 UDP 端口发包。
- 被拒的连接在浏览器侧的报错由 `net::ERR_BLOCKED_BY_CLIENT` 改为 `net::ERR_SOCKS_CONNECTION_FAILED`，目标无法解析或连不上时也报这个错误；`browser_navigate` 遇到它时在报错后附一句说明，指出目标可能被 `blockPrivate` 拦截（只在 `blockPrivate=true`、起了闸时附）。删除「判定超过 10 秒按拒绝处理」：判定随连接进行，解析卡住时由浏览器的连接超时收尾。
- 闸在浏览器启动之前起好，起不来时报错、不启动浏览器，下次调用重试；此前「请求拦截开启失败时关闭浏览器」的路径随之删除。插件停用时先关闭闸并断开全部在途连接，再关闭页面与浏览器，浏览器关闭挂住时闸照样关闭。闸不做认证，本机进程都能连到它，经它连接的目标同样按上述规则判定；问候与请求 10 秒内没有收齐的连接会被断开，与 CONNECT 请求同包到达的数据在接通后交给上游。
- 浏览器的全部流量经插件所在进程转发，打开重页面、视频时会多占该进程的 CPU，闸解析域名用的 `dns.lookup` 占用 libuv 线程池，域名多的页面可能与同进程的文件 I/O 争用线程；走代理后 Chrome 不使用 QUIC。Chrome 自带的本地网络访问限制对经闸的连接不再起作用（浏览器不知道目标地址），私网防护完全由闸承担。
- 每个页面（`pageId`）独占一个浏览器窗口，`browser_click`、`browser_type`、`browser_screenshot` 操作前先把页面切到前台。此前页面自己开出窗口或标签页（`window.open`、`target=_blank`，带不带 `noopener` 都一样）或插件再开一页之后，原页面被压到后台，在它上面点击、默认先清空的输入、按选择器截图一直不返回，所在回合随之挂住。`headless=false` 时每个页面是一个独立的系统窗口，不再是同一窗口里的标签页。`puppeteer` 依赖下限抬到 `^24.40.0`（`newPage({ type: 'window' })`）。
- 浏览器启动改为单飞，并发的首次调用共用同一次启动。此前并发调用各起一个 Chromium，先起的那个被覆盖后没人关，一直留到进程退出，Chrome 未下载时还会同时下载两份。启动途中插件被停用时，这一代浏览器启动完成后随即关闭（不等关闭落定，关闭失败记一条 warn），调用返回「浏览器工具已停用」；此前它仍被交出、从此没人关，调用在停用之后返回页面内容。
- `browser_screenshot`（含切到前台与按选择器找元素）限时 `defaultTimeout`。截图卡住（如页面的渲染进程卡死）时，到时限返回「截图超过 N ms 未完成，已关闭浏览器，全部页面随之关闭；下次调用时重新启动，需重新 browser_navigate 打开页面」，并关掉这一代浏览器（不等关闭落定），页面表随之清空，下次调用重新启动。此前截图没有自己的时限，挂住的截图命令持有浏览器级的锁，要等到 puppeteer 默认的 CDP 命令时限（180 秒）才返回，其间同一浏览器里开新页、关页面与其它页面的截图都排在它后面。启动浏览器时显式设 `protocolTimeout` 为 `defaultTimeout` 的两倍（默认 60 秒），其余操作里挂住的单条 CDP 命令以此为上限，此前同样是 180 秒。`defaultTimeout` 为 0 时两者都不设时限，与 puppeteer 对 0 的约定一致。
- util-network-guard：`pinnedLookup` 转为公开 API（此前标 `@internal`），供自管连接作为 `net.connect` 的 `lookup` 传入；新增 `assertPortAllowed(port)`，按 `allowedPorts` 判定端口，`assertSafeUrl` 与浏览器网络闸共用这一判定；文档补上 `pinnedLookup` 与 `assertAddressesSafe`（写明传入的 IP 字面量须是规范形式），并更正 `assertSafeHost` 的说明：它只预检、不连接，单用它封不住 DNS 重绑定。

**行为变化与迁移**：

- 按 `net::ERR_BLOCKED_BY_CLIENT` 判断「被拦截」的调用方，改为匹配 `net::ERR_SOCKS_CONNECTION_FAILED`（它同时覆盖目标无法解析或连不上的情况）。
- `blockPrivate=true` 时浏览器不再使用系统代理设置：此前 Chrome 按系统代理（macOS 的网络设置、Linux 上的 `*_proxy` 环境变量等）出网，现在出站连接一律由插件所在进程直连目标。要经上游代理才能出网的部署，需让插件所在进程的直连可达（如透明代理），或把 `blockPrivate` 设为 `false`（同时失去私网拦截）。
- 配了 `network.allowedPorts` 的部署，`blockPrivate=true` 时浏览器也只能连到列表里的端口：页面或它的子资源用了其它端口（如 `:8080`、`:8443`）时以 `net::ERR_SOCKS_CONNECTION_FAILED` 失败，需要时把端口加进 `allowedPorts`。
- `headless=false` 的使用者会看到每个页面各开一个窗口。
- `browser_screenshot` 超时会关闭浏览器里的全部页面（含其它会话打开的），此前的 `pageId` 随之失效，需重新 `browser_navigate`。把 `defaultTimeout` 调得很小的部署，大页面的整页截图可能因此超时，需要时调大。
- 锁定了 24.40 以前的 puppeteer 的部署，升级本插件后 puppeteer 随之升级，绑定的 Chrome 版本通常也会变，需要重新下载一份 Chrome：npm 安装（含插件市场的安装与更新）会跑 puppeteer 的安装脚本，在安装时下载；跳过安装脚本时（pnpm 10 起默认、`--ignore-scripts`）在首次调用浏览器工具时下载，最长等 300 秒。可预先执行 `npx puppeteer browsers install chrome`，或用 `executablePath` 指向已装的 Chrome。

### 绘图渲染卡住时按时返回（@aalis/plugin-draw）

plugin-draw 按 patch 发布。

- 等字体、量内容高与截图（动图为逐帧截图）任一步超过 15 秒时，工具返回「渲染步骤超时（…）」，并关掉这一代 Chromium（不等关页面，也不等关闭落定），同一代里其它在飞的渲染随之失败并报错，下次渲染重新启动。此前 15 秒的步骤时限只让等待方先报错，挂住的截图仍持有浏览器级的锁，收尾关页面要等它，一次卡住的渲染要到 puppeteer 默认的 CDP 命令时限（180 秒）之后才返回，其间占着渲染槽，同一浏览器里其它渲染开新页也被挡住。
- 启动 Chromium 时显式设 `protocolTimeout` 为步骤时限的两倍（30 秒）：没套步骤时限的浏览器调用（开页、设视口、动图的时长探测与逐帧定格、关页面）挂住时以此为上限，此前是 180 秒。

### WebUI 管理接口按实际状态回报（@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-package-manager、@aalis/schema-config）

- 新建实例（`POST /api/plugins/:name/instances`）后激活失败、实例转为 `error` 态时，实例与配置照样保留并写入配置文件，但返回 500 并附失败原因（「已创建实例 X，但激活失败，已转为 error 态（原因）；配置已写入配置文件」），与启用、改配置两条路由同一写法。此前固定回 200「已创建实例」。前端建实例失败时同样刷新插件列表，显示出这个 `error` 态实例。
- 市场安装的插件装上后，package-manager 的 `install` 等插件状态机静置（`plugins.idle()`）再读主实例状态：激活失败时仍回 `ok: true`（包已装上、进了插件列表，改好配置即可重试），`message` 为「已安装 X，但激活失败，已转为 error 态（原因）」；慢激活转入后台仍在进行时为「已安装 X，仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准」；在等 required 依赖时为「已安装 X，尚未激活，正在等待 required 依赖满足」。此前一律回「已安装并加载」；安装时另有重算在飞，rescan 的登记只排队、立即返回，主实例还是 pending，随后的激活失败同样被报成「已安装并加载」。`PackageManagerDeps` 新增可选的 `idle()`，生产接线接 `plugins.idle()`；`pluginStatus` 的返回值须带 `instanceId` 与 `error`，自己实现 `PackageManagerDeps` 的代码要补上。
- 启用（`POST /api/plugins/:name/enable`）、改插件配置（`PUT /api/plugins/:name/config`）与新建实例（`POST /api/plugins/:name/instances`）在管理动作之后同样等插件状态机静置，再按实例状态回执。此前动作撞上在飞的重算时只排队、立即返回，路由立刻读到 pending，回 200 成功，随后的激活失败不出现在回执里。转入后台的慢激活不等（重算对单个激活至多等到慢激活阈值），回执附「仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准」；在等 required 依赖的附「尚未激活，正在等待 required 依赖满足」；两者都回 200。前端启停与建实例成功后的提示改为显示服务端回执，此前是固定的「已启用」「已创建实例 X」。
- 启停、改插件配置与新建实例的落盘失败时（被拒 409、写入失败 500，均带 `applied: true`），插件在动作之后没有进入预期状态的（激活失败、未在宽限内停止、仍在激活、在等依赖，或对禁用插件改配置后保持禁用、按禁用标记登记的新实例），`error` 开头先说明这一点，再说明未写入配置文件。此前只说明落盘，激活失败的原因被丢掉。
- 删除实例（`DELETE /api/plugins/:instanceId/instance`）改为先从配置文件删掉配置段与禁用标记并落盘，落盘成功后再卸载。此前先卸载后落盘：卸载途中有人改了配置文件时，热重载会按仍带配置段的文件把实例重新登记，落盘随后删掉配置段，回 200「已删除」，实例却在运行、文件里没有它。落盘成功而随后卸载失败时回 500 与 `{ error }`：「已从配置文件删除实例 X，但卸载失败（原因）；重启后不再登记」。此前卸载失败回 400 与原始错误，配置段未删。
- 改插件配置（`PUT /api/plugins/:name/config`）对已禁用的插件照样换上新配置并写回配置文件，插件保持禁用，启用时按新配置激活，回执附「插件已禁用，启用时按新配置激活」。此前回 409「先启用插件再修改配置」，配置不写入。
- 新建实例时，配置文件的 `disabledPlugins` 里已有该实例（手改配置文件留下）的，照旧以禁用态登记，回执改为「已创建实例 X；配置文件的 disabledPlugins 里有它，已按禁用态登记，启用后激活」。此前只说「已创建实例 X」。
- 模型选择框旁的「刷新」（`POST /api/llm-providers/:contextId/refresh`）改为按模型条目的 `providerId` 找提供者，与 `/api/llm-providers` 的聚合同一口径。此前按条目的 `contextId` 找，而 llm-openai、llm-ollama 的每个模型条目以「<实例 id>/<模型 id>」登记，永远对不上，刷新一律回 404。找不到可刷新的条目时回执改为中文并区分两种情况：提供者名下有模型但都不提供运行时刷新时为「提供者 X 不支持运行时刷新模型列表（例如关闭了模型发现 discoverModels）」，名下没有已注册的模型时为「提供者 X 当前没有已注册的模型，无法刷新」。此前两种情况都是半英文的「no refreshable LLM provider registered for contextId=… (provider 可能为静态注册型，不支持运行时刷新)」。
- `GET /api/status` 新增 `appName`（全局配置里的应用名称）；`name` 仍是对话对象的显示名，装有人设时为人设名。仪表盘的「应用名称」卡片改显示 `appName`：此前显示的是人设名，装了人设（standard 档默认装）以后改应用名称在界面上看不出变化。设置页里全局配置 `name` 的说明（schema-config）同步改为「装有人设时仪表盘仍显示它，聊天显示人设名」。
- `autoOpen` 只在访问 token 为新生成时打开浏览器：persist 模式首次生成 token 时打开一次，之后的重启与插件重载读回同一 token，不再打开；ephemeral 模式每次激活都换 token，照旧每次打开；fixed 模式用配置的 fixedToken，不打开，`fixedToken` 为空时按 persist 处理。此前每次激活都打开，在 WebUI 里改 webui-server 的配置、配置文件热重载、`/restart` 与市场更新引起的重启，都会多开一个标签页。默认值仍为 `true`。
- 市场检索源不可达、降级为本地已装列表时，同样按搜索词 `q` 过滤。此前降级列表忽略 `q`，直接调用接口时拿到全部已装包；内置前端在本地过滤，界面不受影响。

**迁移**：

- 靠 `PUT /api/plugins/:name/config` 回 409 判断插件已禁用的调用方，改读 `/api/plugins` 的 `state`。这条依赖本批 core 的新语义（禁用态 `updateConfig` 收下配置、返回 true）：配合旧版 core 时，对禁用插件的 PUT 会回 404「插件不存在」。plugin-webui-server 的 `@aalis/core` peer 下限已抬到 `>=0.19.0 <1.0.0`。
- 新建实例回 500 时实例已登记、配置已写入配置文件：调用方不要按「没建成」重试同名实例（会回「已存在」），改好配置经 `PUT /api/plugins/:name/config` 保存即重试激活。
- 删除实例落盘失败时回 409 或 500 与 `{ error }`（不带 `applied`），实例不卸载，文档里的配置段与禁用标记还原，文案为「未删除实例 X：未写入配置文件（原因）」；此前回 `applied: true`，实例已在运行态卸载。
- 习惯每次启动都自动弹出页面的，persist 模式下改从 `data/webui/access.txt` 取一键登录链接，或直接访问已登录过的地址（cookie 仍有效）；要每次都换 token 并打开，用 `tokenMode: ephemeral`。
- plugin-webui-client 读 `appName`：只升级客户端、服务端仍是旧版时，仪表盘「应用名称」显示「-」。两个包同批发布。
- 启用、改插件配置、新建实例与市场安装的回执要等重算落定：动作撞上在飞的重算或别的插件正在前台激活时，请求会等到它们落定才返回（每个前台激活至多等到慢激活阈值，默认 60 秒；阈值设为 0 时不设限）。按回执 200 判断「已激活」的调用方，改为同时看 `message` 或 `/api/plugins` 的 `state`：200 也可能是仍在激活或在等依赖。

### /clear 回执与清理并发（@aalis/plugin-commands、@aalis/api-memory、@aalis/plugin-memory-summary、@aalis/plugin-memory-vector、@aalis/plugin-persona、@aalis/plugin-checkpoint、@aalis/plugin-user-profile、@aalis/plugin-user-relation）

- api-memory：`memory:clear` 的结果行新增可选字段 `type`，即这一行所属的清理类型（取值同 `/clear --type`）。处理某个清理类型的中间件须在各行标注它，成败都标。memory-summary、memory-vector、persona、checkpoint、user-profile、user-relation 与 plugin-commands 自己的消息历史行、附件行都已标注。`listMetadata` 与 `MetadataEntry.updatedAt` 的说明写明后端约定：读不出的条目跳过并记 warn（点名 namespace 与 key），不让整个命名空间读失败；读不到写入时间时 `updatedAt` 为 0。
- `/clear` 与 `/clear all` 用 `--type` 显式指定的类型没有插件处理（插件未安装或未激活）时，回执另加一行说明该类型未清理；此前不提，单独 `-t vector` 回「无可清除的记忆模块。」。会话级 `/clear` 显式指定 `user-profile` 或 `user-relation` 时，说明它们只在 `/clear all` 时清理。不指定类型时不加说明。
- 要清消息历史（指定了 `context` 或不指定类型）而记忆服务不可用，或 `/clear all` 时记忆后端没有实现 `clearAll`，整条指令不执行、不清任何类型，回执说明原因。此前 `memory:clear` 链上的其它中间件照常执行，按所选类型清掉能清的部分（如摘要、待办、转发原文；不带类型时还有附件、向量、档案、关系图），消息历史却没清，留下「消息还在、其余已清」的半截状态。不含 `context` 的类型照常清理。
- 删除只读的 `/clear list` 子指令：它沿点路径继承 `/clear` 的确认，列类型也要真人点确认。类型说明并进 `--type` 选项，用 `/help clear` 查看；未知类型的提示末尾指向 `/help clear`。
- 指令解析：有子指令、自身不接收位置参数的指令收到多余的词时，回「未知子指令或多余参数: <词>。输入 /help <指令> 查看用法。」（前缀随 `commandPrefix`），不执行，也不进入权限确认。此前多余的词被忽略、按父指令执行：`/clear list`（删除子指令后）或把 `/clear all` 敲成 `/clear al`，会进入 `/clear` 的确认，点了确认就清掉当前会话；`/clear -t context vector`（`-t` 只取下一个词）确认后只清 `context`。第一方指令里同样适用的还有 `/session`（plugin-agent）、`/profile`、`/profile clear`、`/profile self`、`/instruct`（plugin-user-profile）与 `/maimai`（plugin-maimai），如 `/session 看看` 此前照常显示会话配置、`/profile clear 我` 此前照常清掉自己的档案，现在都回上述提示、不执行。其余指令多出的位置参数仍忽略。
- memory-summary：摘要已过清理比对、正在落库（写摘要、裁切、写分隔线）时开始的清理，先等这次落库完成再删；此前在 mongodb 等异步后端上，这次写入可能晚于清理落地，摘要被写回。
- memory-vector：存量模型标记的读写与全局清空向量库时的删除排成一队，清空时在途的读写先完成再删；此前在异步后端上，清空前读到的旧标记可能在删除之后进缓存，在途的写入可能在删除之后落库。
- user-relation：清空关系图前先等已发出的写入落定再列举删除；此前清空提交当口正在落库的那一条可能晚于删除落地，被删的键复活。清空开始之后，不看清空代数的路径新发出的写入不受此约束（与此前相同）。
- `/clear` 与删除会话因此可能多等一次在途的数据库写入，时长受后端超时约束。

**破坏性变更与迁移**：

- **`/clear list` 删除**：改用 `/help clear` 查看可清理类型。定时任务或 workflow 里发 `/clear list` 的，改发 `/help clear`；继续发 `/clear list` 会收到「未知子指令或多余参数」与 `/help clear` 的提示，不会清理。
- **指令多余参数**：第三方插件注册的指令若有子指令、自身不声明位置参数、又依赖「多出的词被忽略、执行父指令」，现在会回「未知子指令或多余参数」。需要接收自由文本的，给父指令声明位置参数（如 `[tail:text]`）。
- **`CLEAR_TYPES` 类型**：plugin-commands 导出的 `CLEAR_TYPES` 由字面量元组（`as const`）改为 `ReadonlyArray<{ id: string; label: string; globalOnly?: boolean }>`；`user-profile`、`user-relation` 的 `label` 去掉「（仅全局清理）」，改由 `globalOnly: true` 表示。按字面量类型使用 `id` 的代码改用 `string`。
- **第三方 `memory:clear` 中间件**：处理内置清理类型（如自带的向量或档案实现）的，在 `results` 各行加上 `type`，否则用户显式指定该类型时，回执会多一行「没有已启用的插件处理这一类型」。
- **同批升级**：plugin-commands 与 memory-summary、memory-vector、persona、checkpoint、user-profile、user-relation 同批升级。只升级 plugin-commands 时，旧版插件的结果行不带 `type`，显式指定它们的类型会多出「没有已启用的插件处理」一行（该插件自己的清理结果照常显示）。
- **第三方记忆后端**：没有实现 `clearAll` 的，含 `context` 的 `/clear all`（含不带类型的）整条拒绝执行。要支持全局清理消息历史，实现 `clearAll`。

### 记忆后端的同库检测、元数据读取与清理（@aalis/plugin-memory-sqlite、@aalis/plugin-memory-mongodb、@aalis/plugin-session-manager、@aalis/api-memory、@aalis/plugin-memory-inmemory、@aalis/plugin-user-profile、@aalis/plugin-user-relation、@aalis/plugin-memory-summary、@aalis/plugin-todo-list、@aalis/plugin-adapter-onebot）

- memory-sqlite 判断两个实例是否打开了同一个库，改按文件身份（设备号与 inode）比较，文件系统不提供 inode 时退回按本地路径比较。此前按本地路径字符串比较：大小写不敏感的卷上（macOS 默认的 APFS 等）`data/aalis.db` 与 `data/AALIS.db` 是同一个文件，硬链接同理，两个实例都能激活并共写同一个库。现在后激活的那个以一行 `ConfigError` 失败，两边路径写法不同时，消息一并给出占用者打开的路径。为取文件身份，冲突的实例会先打开这个文件再立即关闭，不设 WAL、不建表。plugin-memory-sqlite 因此直接使用 `node:fs` 的 `statSync`，理由登记在 `docs/architecture/node-usage-policy.md`。`biome.json` 没有对它整条关掉 `noRestrictedImports`，而是为这个文件单独写了一段规则：`node:fs` 只放行 `statSync`，其余受限的 `node:*` 照常报错。
- memory-sqlite 激活时开库之后的任何一步失败（取文件身份、撞库、设 WAL、建表、发布服务），都先关掉刚打开的数据库连接再报错。此前设 WAL 或建表失败时连接不关，一直留到进程退出。
- memory-sqlite 与 memory-mongodb 的 `listMetadata` 逐条容错：读不出的条目（sqlite 里 `data` 不是 JSON 对象的行，mongodb 里 `data` 不是对象的文档）跳过，并记一条 warn 点名命名空间与键，同一命名空间的其余条目照常返回。此前一行坏数据会让整个命名空间读取失败，会话表、关系图、用户画像、待办等按命名空间全量读取的插件一起失效。`/clear` 整体清空命名空间时这些条目一并删除，见下一条。读不出写入时间的条目照常返回，`updatedAt` 记为 0：memory-sqlite 里 `updatedAt` 被改成无法解析的文本或 BLOB 的行，memory-mongodb 里缺 `updatedAt` 或它不是日期的文档。此前 sqlite 对前一种文本返回 NaN（按写入时间回收的消费方，如合并转发缓存的 7 天回收，因此永远不回收这一条），对 BLOB 抛 TypeError，整个命名空间读取失败；mongodb 对这类文档抛 TypeError。这两类数据只会来自手工修改或外部写入，本插件写入的数据不受影响。
- api-memory 新增可选方法 `listMetadataKeys(namespace)`：只列键、不读 `data`，读不出的条目也列出，memory-sqlite、memory-mongodb、memory-inmemory 都已实现。另新增函数 `clearMetadataNamespaces(mem, namespaces, logger)`：在一次 `commitMetadata` 里整体清空若干命名空间，返回各命名空间删掉的键；后端实现了 `listMetadataKeys` 时，读不出的条目一并删除，并记一条 info「清理时一并删除了 N 条读不出的数据：namespace/key、…」（超过 10 条只列前 10 条）。user-profile（用户档案与第三方行为指令）、user-relation（关系图与其向量）、memory-summary、todo-list、adapter-onebot（合并转发原文）的全局清理（`/clear all`，以及 `/profile clear nuke`、`/relation cleanup all`）改用它，读不出的条目一并删除，带条数的回执包含它们。与 0.18 相比：sqlite 里 `data` 不是合法 JSON 的行，此前会让所在命名空间的这一类清理整体失败、回执报失败，现在一并删除并计入条数；`data` 是合法 JSON 但不是对象的条目，此前随清理照常删除，现在仍一并删除。
- session-manager 读会话表失败时按 1、3、10 秒的间隔重试三次（每次重试前记一条 warn），其间仍用原来的会话表与落盘目标；重试用尽仍失败才按原来的方式降级（记 error，会话列表为空，改动不落盘）。此前只读一次，一次连接抖动就要等 memory 换人或进程重启才恢复。本插件激活时（启动时，或随 memory 胜者卸载、停用、重载而重新激活时）等读表（含重试）结束才对外提供服务：后端持续不可用时，这次重算约多等 14 秒，拓扑序排在它之后的插件随之推迟激活，启动时 `app:ready` 也随之推迟。14 秒是三次重试间隔之和，各次读取本身的耗时另计：如 memory-mongodb 连不上库时，每次读取要等到服务器选择超时（`connectTimeoutMs`，默认 5 秒）。运行中另一个后端成为胜者时（新装或切换偏好）服务不中断，重试在后台进行。换后端、停用或停机会中止重试等待，停机不被拖住，停用或停机时尚未读完的激活不再发布服务与登记；被中止时只记一行 info，不记 error。

**迁移**：

- 有两个 memory-sqlite 实例通过只差大小写的路径或硬链接指向同一个库文件的，升级后后激活的那个会报配置错误，请给它另配 `path`。此前这两个实例一直在共写同一个库。
- 第三方 memory 后端请按 `@aalis/api-memory` 里 `listMetadata` 与 `MetadataEntry.updatedAt` 的说明实现：读不出的条目跳过并记 warn，不让整个命名空间读失败；读不到写入时间时 `updatedAt` 为 0。要让 `/clear` 连读不出的条目一并删除，再实现 `listMetadataKeys`（只列键、不读 `data`，读不出的条目也列出）；不实现时，插件整体清理命名空间按 `listMetadata` 枚举键，读不出的条目留在库里。
- 直接构造 `SQLiteMemoryService`（plugin-memory-sqlite 从包入口导出）的代码，第二个参数须带 `logger`（至少有 `warn` 方法），`listMetadata` 跳过读不出的行时用它点名。此前第二个参数可以省略。
- 在元数据里存数据的第三方插件，整体清空自己的命名空间可改用 `clearMetadataNamespaces`，读不出的条目一并删除。
- plugin-user-relation 从包入口导出的实现类：`RelationStore.clearAll` 与 `RelationService.clearAll` 改为必须传入 `logger`（至少有 `info`），用来记下清理时一并删除的读不出的条目。直接调用它们的代码补上这个参数。

### LLM 提供者的模型发现与错误信息（@aalis/plugin-llm-openai、@aalis/plugin-llm-ollama、@aalis/plugin-llm-deepseek、@aalis/plugin-agent）

- 一个模型都没有时（模型发现失败且未配置 `customModels`，或已连接但模型列表为空），实例的错误信息改为真实原因，如「未配置 customModels，没有可注册的模型；模型发现失败 <地址>/models: fetch failed ← connect ECONNREFUSED …」或「已连接 <地址>，但未发现任何可用模型；可在 customModels 里写明要用的模型」（llm-ollama 另提示先 `ollama pull`），激活失败日志只有一行、不带堆栈。实例照旧转为出错、不自动重试。llm-ollama 发现的模型都不是对话模型（如只装了嵌入模型）、一个条目都没注册时同样如此，错误信息为「Ollama 已连接 <地址>，但没有可用的对话模型：<模型> 都没有报告对话能力（如嵌入模型）；先用 ollama pull 下载对话模型」。此前错误信息是 core 的通用文案「声明 provides [llm] 但未实际注册这些服务」，真实原因只在前一行 warn 里（非对话模型的情形只有一行 info「注册 0 个 model entry」）；那条「不注册任何 LLM entry」的 warn 随之删除。
- agent 在一个 LLM 都解析不到时发回会话的提示只点名出错的实例，原因指向 `/doctor`：「未找到任何具备 chat 能力的 LLM —— 以下 LLM 插件激活失败：<实例>、<实例>。可用 /doctor 查看原因（需要相应权限）。」出错的实例全部列出；`/doctor` 本批改为受限指令（见下一节），收到提示的人不一定能运行，故注明需要权限。此前提示带每个实例错误信息的前 120 个字符，至多列 3 个实例，末尾是「改好配置后重启即可，详情见 /doctor。」；上一条改为真实原因后，错误信息里的发现地址与网络层原因（如内网地址与端口）会随这条提示发进群聊。原因见日志、WebUI 与 `/doctor` 的 `plugins.errored`。
- 新增配置 `discoverModels`（默认 `true`，行为不变）。网关不提供模型列表接口（llm-openai、llm-deepseek 为 `/models`，llm-ollama 为 `/api/tags`）时关闭：启动时不发发现请求、不记 warn，只注册 `customModels`，记一行 info「未开启模型发现: …」；llm-openai、llm-ollama 的模型条目不提供 `refresh`，WebUI 的「刷新」提示该 provider 不支持运行时刷新。关闭时 `customModels` 必填，留空则实例转为出错，错误为 `ConfigError: 缺少配置项 customModels（关闭 discoverModels 时必填）…`。开着且发现失败时照旧记一条 warn，只注册 `customModels`。
- llm-deepseek 的模型发现失败与另两家一致：warn 只有一行、不带堆栈，写作「启动时只注册 customModels 里的模型；模型发现失败 <地址>: <原因>」，底层原因（如 `connect ECONNREFUSED`）内联在消息里。此前是「fetchRemoteModelIds 异常 <地址>:」后接整段堆栈与因果链，HTTP 非 2xx 时附带整个响应体。llm-openai、llm-ollama 的这条 warn 同样改为提示在前，此前是「模型发现失败 <地址>: <原因>；启动时只注册 customModels 里的模型」。
- 非 2xx 响应体先把换行与连续空白折叠成一个空格，再截断到 500 个字符并以「…」收尾（按代理对安全截断），才写进模型发现失败的原因与 warn 日志；对话请求的错误信息不再带响应体，见下一条。此前网关的 HTML 错误页会整页（可达数十 KB、多行）进入日志、WebUI「刷新模型」的报错，以及经 agent 以「[错误] …」发回的会话。内容审查关键词与 llm-ollama 音频路径的 `unknown format` 诊断仍按完整响应体判断。
- 对话请求（`chat`、`chatStream`，以及 llm-ollama 带音频的请求）失败时抛出的错误会经 agent 发回会话，改为只写状态码与原因。非 2xx 写作「<提供者> API 错误 (<状态码>)：<提示>；上游说明：<说明>」：401 与 403 提示「密钥无效或没有权限」，402 提示「余额不足或需要付费」，404 提示「模型或地址不对」，429 提示「请求过多或额度不足」，5xx 提示「上游服务故障」，其它状态码不加提示；说明取上游 JSON 里的 `error.message`、`error` 字符串（Ollama 的写法）或顶层 `message`，折成一行、截断到 500 个字符，取不到（不是 JSON、没有这些字段或说明为空）时写「详情见日志」。<提供者> 在 llm-openai 为 `LLM`，另两家为 `DeepSeek`、`Ollama`。超时写作「<提供者> 请求超时：<timeout> 秒内没有完成，可在配置里调大 timeout」，连不上写作「<提供者> 连不上服务：检查 baseUrl 与网络，详情见日志」；非流式请求（llm-ollama 带音频的请求一律走非流式）的应答是 200 但不是 JSON 时写作「<提供者> 应答不是 JSON (200)；详情见日志」，流式请求不在此列。响应体摘录，或底层原因（如 `fetch failed ← connect ECONNREFUSED <地址>`）连同耗时，各记一条 warn。调用方中止时原样抛出、不记 warn；读流时连接被断开（`terminated`）等其它错误记 warn 后原样抛出。内容审查类错误的固定提示不变。此前错误信息带着响应体；超时与连不上是 fetch 的英文原文（「The operation was aborted due to timeout」「fetch failed」），不带原因，非流式请求也不记日志；非流式请求遇到 200 的 HTML 应答报的是 JSON 解析的 SyntaxError，带着响应体开头与其中的换行。
- 模型发现的响应是 200 但不是模型列表时（llm-openai、llm-deepseek 缺 `data` 数组或列表项缺字符串 `id`，llm-ollama 缺 `models` 数组或列表项缺字符串 `name`），原因写作「响应不是模型列表（需要 data 数组，每项带字符串 id）: <响应摘录>」（llm-ollama 为 models 与 name），摘录同样折叠空白、截断到 500 个字符，网关用 200 返回的错误说明会留在摘录里。按发现失败处理：有 `customModels` 时记 warn、只注册它们，没有时实例转为出错，刷新时报错且不增删条目。此前原因是 JS 内部报错，如「Cannot read properties of undefined (reading 'map')」。响应不是 JSON 时（如网关用 200 返回门户页），原因写作「响应不是 JSON: <响应摘录>」，摘录同样折叠空白、截断；此前是 JSON 解析的 SyntaxError，带着响应体开头与其中的换行，实例的错误信息与激活失败日志会断成两行。
- 模型发现的报错与启动日志里，URL 去掉查询串再显示（有的网关把密钥写在查询串里）；没有查询串时照配置原样显示。
- `baseUrl` 带用户名或密码（`user:pass@`，含只写用户名或只写密码、协议后少写斜杠等写法）或解析不了时，读配置即抛配置错误：实例转为出错、不发请求，错误信息不带地址。llm-openai、llm-deepseek 为「baseUrl 不能带用户名或密码（user:pass@），密钥请填在 apiKey」，llm-ollama 为「baseUrl 不能带用户名或密码（user:pass@），本插件不支持带凭据访问 Ollama」，解析不了时为「baseUrl 不是有效的 URL，需写成完整地址，如 <该插件的默认地址>」。此前带凭据的地址每次请求都被 fetch 拒发，凭据却会出现在模型发现的报错、模型条目的名称（WebUI 的模型下拉）与日志里，对话失败时还会以「[错误] Request cannot be constructed from a URL that includes credentials: <完整地址>」发回会话；解析不了的地址同样每次请求都失败，报错原文带着整个地址。
- llm-ollama 在「刷新模型」时并行探测新模型的能力，与启动时一致，新增条目仍按发现顺序登记。此前逐个探测，每个新模型最长要等 10 秒。
- llm-openai、llm-ollama 新增依赖 `@aalis/util-text-normalize`（`>=0.5.2 <1.0.0`，已发布的版本即可）。

**迁移**：网关不提供模型列表、只靠 `customModels` 配模型的，把 `discoverModels` 设为 `false`，启动时不再记发现失败的 warn，也不再白等发现请求超时（最长 10 秒）。

`baseUrl` 写了 `user:pass@` 的（此前请求本就发不出去）：llm-openai、llm-deepseek 去掉地址里的凭据，把密钥填在 `apiKey`；llm-ollama 不支持带凭据的地址，改用不需要凭据的地址。解析不了的 `baseUrl` 改成完整地址（带 `http://` 或 `https://`）。

### /doctor 改为受限（@aalis/plugin-doctor）

- `/doctor` 声明为受限指令（`visibility: 'restricted'`）：需要等级 2，不需要确认；owner 不受等级限制，装有 `@aalis/plugin-authority` 时本机 CLI 的 `aalis doctor` 照常可用。WebUI 的「系统诊断」页不经指令，不受影响。此前是公开指令，默认等级（0）的用户在群聊里也能运行，而报告带存储根的宿主路径（`storage.roots`）与插件的报错原文（`plugins.errored`），报错原文里可能有内网地址与端口。诊断输出的格式不变。

**迁移**：需要让某些用户使用 `/doctor` 的，给他们等级 2，或在 WebUI 的权限管理页经 `authorityOverrides` 调低能力键 `command:doctor` 的门槛。反过来，只让 owner 使用的，把这个门槛调到比任何已授予的等级都高的整数，如 99。未装或未启用 `@aalis/plugin-authority` 的部署，指令没有执行守卫，受限指令一律被拒，`/doctor` 与 `aalis doctor` 因此不再可用（WebUI 的「系统诊断」页不受影响）；需要时安装 `@aalis/plugin-authority`（create-aalis 的 minimal 及以上各档已包含）。

### 零散修复（@aalis/plugin-cli、@aalis/plugin-flow-control、@aalis/plugin-storage-local、@aalis/runtime）

storage-local 与 plugin-cli 按 patch 发布；runtime 因下面所列入口解析的反方向变化，并须配本批 core（见开头的下限说明），按次版本发布；flow-control 本节这一项是修复，它随回复闸门职责重组按次版本发布。

- flow-control 的禁言表写盘在飞时 storage 换人（或同一 storage 重载）触发重读，读到的文件可能不含这次写。此前写一成功就清掉「未落盘改动」记录，随后读回的旧禁言按较晚的到期时刻合并回内存，解禁被撤回，新 storage 上的文件也不再补写，群里按旧禁言沉默到原到期时刻。现在写盘期间开始了重读的，这次写成功也不清记录：重读时这些会话以内存为准，读完补写到当前 storage。写链在等上一次读回时又开始了重读的，现在接着等新的一次读回再写；此前这一步直接写整表，会冲掉新 storage 文件里其它会话的禁言，解禁同样可能被撤回。
- storage-local 的 `storage.delete` 审计日志由 warn 改为 info，与写入、重命名、移动同级；`/clear`、市场更新预检、checkpoint 清理等正常删除不再输出一串 WARN。
- runtime 的 `createNodeModulesPluginLoader` 改按 `import()` 的规则定位插件：包目录按 `node_modules` 逐级上溯定位，直接读其中的 `package.json`；入口有 `exports` 时取 `"."` 的 import 条件目标（`node` / `import` / `default`，Node 启用 require(esm) 时另有 `module-sync`，与 `import()` 一致），没有 `exports` 时按 `main`，依次试 `main`、`main.js`、`main/index.js`，最后 `index.js`。此前用 CommonJS 的 `require.resolve`：`exports` 没开放 `./package.json` 的包读不到元数据，报「exports 映射未导出 "./package.json"」并跳过；开放了的，`exports` 只写 `import` 条件时报「入口无法解析」并跳过，同时写了 `import` 与 `require` 的双入口包加载的是 `require` 条件的产物。入口解析失败的告警改为写明可能的原因。
- runtime 在配置热重载时登记新出现的 `name:suffix` 段，模块定义改取该模块在册实例的（主实例优先）。此前只按主实例取：主实例被 `unload`、同模块的后缀实例还在册时，新加的后缀段被报「对应的模块未找到」并跳过，而冷启动会照常登记。第一方路径（WebUI 不允许删主实例，市场卸载连同全部实例一起卸掉）不会走到这里，影响的是经 plugins 服务直接卸载主实例的第三方插件或嵌入宿主。
- runtime 的文件日志在启动时不再覆盖上一轮：守护进程写 `data/latest.log` 之前，先把旧文件改名为 `data/latest.1.log`，已有的依次后移（`latest.1.log` 改为 `latest.2.log`，依此类推），保留 5 份，更早的删除；`fileLog` 传了自定义路径的，编号同样插在扩展名前。此前每次启动直接覆盖 `latest.log`，上一轮运行的日志连同崩溃时写进去的错误全部丢失。轮转失败（如日志目录没有写权限，或 Windows 上文件被别的程序占用）不拦启动：照旧覆盖写 `latest.log`，并记一条 warn 写明原因。不接在原内容后面写，是为了保持一个文件只装一轮，WebUI 的历史分页与 CLI 的启动恢复依赖这一点。子命令进程（`aalis doctor` 等）照旧不写、也不轮转文件日志。公开导出的 `setupFileLogger` 同样先轮转。
- plugin-cli 帮助页的日志提示随之更正：`latest.log` 每次启动时上一轮改名为 `latest.1.log`，保留 5 份，跨重启持续跟随用 `tail -F`。此前写的是「每次启动覆盖」「可用 tail -f 查看」。

**行为变化与迁移**：

- 此前因上述原因被跳过的插件（`keywords` 含 `aalis-plugin`，且 `exports` 只写 `import` 条件或没开放 `./package.json`），升级 runtime 后会被发现，并像其它插件一样默认启用。不想启用的，在配置里禁用，或从项目依赖中移除。双入口插件改为加载 `import` 条件的产物，两份产物行为不一致的，以 ESM 产物为准修正。
- 反方向：`exports` 的 `"."` 只写 `require` 条件（没有 `node`、`import`、`default` 可用的目标，且开放了 `./package.json`）的插件，此前能加载，升级 runtime 后报「入口无法解析」并跳过，与 `import()` 包名的行为一致。插件作者给 `"."` 加 `default` 或 `import` 条件，或把目标直接写成字符串（如 `"exports": "./index.cjs"`）；CommonJS 产物照样能被 `import()` 加载。
- 按 WARN 级筛查删除记录的，改看 info 级的 `storage.delete` 行；默认 `logLevel: info` 下照常输出。
- 日志目录（默认 `data/`）下多出 `latest.1.log` 到 `latest.5.log`，文件日志占用的磁盘最多为 6 轮运行的日志之和；份数固定，没有配置项。每次守护进程启动都算一轮，`/restart`、市场更新引起的重启与更新失败后的回滚重启也各算一轮。WebUI 日志页与 CLI 历史日志照旧只读 `latest.log`。自行备份或清理日志的脚本要把这几个文件算进去。
- 用 `tail -f` 跟日志的，改用 `tail -F`。此前每次启动截断 `latest.log`，`tail -f` 会从头接着读；现在旧文件被改名，`tail -f` 跟着它停在 `latest.1.log` 上，看不到新一轮的日志。

### send_attachment 发送前核对文件格式（@aalis/plugin-image-sender）

- `send_attachment` 按 `storage_uri` 或 `history_ref` 从存储库取文件时，先按字节区间读文件开头 4 KiB（不整份载入），按 `kind` 的内置白名单核对格式签名：`image` 认 PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC；`audio` 认 MP3（ID3v2 标签或 Layer III 帧头）、WAV、OGG、FLAC、AMR、SILK、M4A；`video` 认 MP4、MOV、WebM、MKV、AVI。AVIF、HEIC、M4A、MOV 与 MP4 按 ftyp 盒的品牌区分，WebM 与 MKV 按 EBML 的 DocType 区分。不是这些格式的文件拒发，工具结果说明不能按该类型发送；是别类媒体时说出检测到的格式与该用的 `kind`，模型可以改 `kind` 重发。此前这两条来源只确认文件存在就转成本地路径发出，onebot 适配器把文件按 base64 内联当图片发送、不看内容；工具是公开的，群里任何人都能诱导模型把存储根里的配置、令牌、记忆库、日志当图片发到群里。工具仍保持公开、不加确认；白名单内置、不做配置；不限定目录；`url` 来源不变。
- `history_ref` 解析到不在存储库内的来源（`file://` 路径、`/root/…` 或 `C:\…` 这类宿主机绝对路径，或历史附件里的 data URI 等）时拒发：这类来源读不了文件头，无从核对。此前这些来源原样发出，其中 `file://` 路径与宿主机绝对路径能外发存储根以外的任意本机文件。
- `storage_uri` 读取失败时如实报原因：只有文件不存在才报「存储资源不存在」，未知存储根、根不可读、目标是目录等报各自的错误。此前一律报「存储资源不存在」。

**行为变化**：

- 以 `storage_uri` 或 `history_ref` 发送白名单以外格式的文件（如 SVG、TIFF、ICO、裸 AAC、FLV），或 `kind` 与文件格式不符（如把 GIF 按 `video` 发、把只有音轨但品牌为 `isom` / `mp42` 的 MP4 按 `audio` 发）的调用现在会被拒。
- `history_ref` 不再接受 `file://` 引用，也不再发送历史附件里不在存储库内的来源（宿主机绝对路径、`file://` 路径、data URI）。onebot 入站落盘失败时，语音等附件会退回平台给的本机路径，这类历史附件不能再用 `history_ref` 重发。
- 存储提供者须实现 `readFileRange`（字节区间读取）：未实现的根上，`storage_uri` 与 `history_ref` 的发送会失败并报「不支持 readFileRange」。第一方 plugin-storage-local 已实现。

## 2026-09-27（core 0.18.0 minor；103 个包：88 minor / 6 patch / 9 新包 api-plugin-source、api-host-config、api-hooks、api-contributions、plugin-hooks、plugin-contributions、api-user-relation、api-package-manager、api-session-history）

core 只做插件的注册、激活、关停与两种原语（事件、服务）。插件从哪里来、配置存在哪里由宿主负责；钩子与贡献点改为普通插件提供的服务。同批各包删除对旧数据、旧配置与弃用接口的兼容，删除无人使用的公开接口，并收紧若干安全默认值。升级前请先读末尾「版本与必须同批升级的包」一节。

### 插件发现外迁到 runtime（@aalis/core、@aalis/runtime、新包 @aalis/api-plugin-source）

- core 删除 `AppOptions.pluginLoader`、`App.autoLoadPlugins()`、`App.rescanPlugins()`、`AppService.rescanPlugins` 与 `PluginLoader` / `PluginDescriptor` 类型；这两个类型改由 `@aalis/runtime` 导出。`pluginDefinitionOf` 从 core 包根移到 `@aalis/api-plugin-source`。
- 新增 `app.pluginAll(items)`：整批同步落账后只重算一次，依赖方在同一次重算里排在它 required 服务的全部提供者之后激活，不会先挂到先登记的后备提供者上。条目为 `{ definition, config?, instanceId?, disabled? }`，返回值逐项对应。
- 拓扑排序里同时就绪的插件按登记序激活。这条规则对所有重算生效：冷启动与提供者重启后的重新激活走同一个确定次序。可见影响：memory-history、memory-summary、message-archive、session-manager、memory-vector 的激活次序后移；`agent:turn:after` 与 `memory:clear` 两条钩子链、`outbound:message` 与 `token:usage` 两个事件上的监听次序随之改变；工具表里 memory-history、memory-vector 的工具位置改变，升级后第一轮提示前缀缓存失效一次。
- runtime 新增 `createPluginDiscovery(app, loader, doc)`（冷启动 `loadAll`、热扫描 `rescan`、热重载登记后缀实例 `registerConfiguredInstances`）；`startAalis` 在根上独占提供 `plugin-source` 服务。`rescan()` 返回本次新登记的主实例名（定义名）。
- 市场与 WebUI 经 `optional(pluginSource)` 热扫描。宿主不提供插件来源时，市场视同本次没有新插件，WebUI 扫描接口返回 503。

**迁移**：自组装宿主改为 `createPluginDiscovery(app, loader, doc).loadAll()`，或直接 `app.pluginAll(...)`。自定义加载器的 `PluginLoader` / `PluginDescriptor` 类型改从 `@aalis/runtime` 导入。插件包入口判定改从 `@aalis/api-plugin-source` 导入 `pluginDefinitionOf`。需要热扫描的插件在 `uses` 里声明 `optional(pluginSource)` 后调 `rescan()`。runtime 包入口引入 node 模块，非 Node 宿主要自己实现这层发现驱动。

### 配置文档外迁到 runtime（@aalis/core、@aalis/runtime、@aalis/plugin-webui-server、新包 @aalis/api-host-config）

- core 不再持有配置文档，只持三样运行态：各实例的配置、禁用态、服务偏好。删除 `ConfigManager` / `ConfigProvider` / `AalisConfig`、`App.config`、`AppOptions.config` / `configProvider` / `pluginDefaults`、`AppService.saveConfig`、`hostConfig` 描述符与 `HostConfig` 类型。`AppOptions` 新增可选的 `name`（启动横幅）与 `logLevel`（默认 Logger 级别）。
- `app.plugin(definition, config?, instanceId?, { disabled })` 与 `plugins.register` 同形：传入的配置原样生效，core 不再合并「宿主 `pluginDefaults` ← 配置文件 ← 传入」，也不再读禁用名单，禁用态由调用方传入。
- 管理动作（`plugins.enable` / `disable` / `updateConfig` / `bounce`）只改运行态，不再写配置文档。要跨重启保留，调用方在动作成功后经 host-config 写文档再 `save()`；WebUI 的启停与改配置路由、mcp-client 的自服务开关已这样做。
- 新包 `@aalis/api-host-config`：`AalisConfig`（各域配置字段的 declaration merging 目标）、`HostConfig`（文档读写面加 `save()`）、`hostConfig` 描述符，以及宿主拒写的错误类 `ConfigSaveRefusedError` 与判据 `isConfigSaveRefused(err)`；服务名仍是 `host-config`。`save()` 兑现即已落盘；失败时以拒绝传出，并已记一笔日志（拒写记告警，其它失败记 error）、标记为已处理。配置源有尚未生效的外部修改而拒写时，拒绝原因是 `ConfigSaveRefusedError`；`isConfigSaveRefused` 按错误名判定，进程里装有两份本包时也认得。
- runtime 新增 `createConfigStore(initial, provider?)` 与 `installHostConfig(app, store, opts?)`（独占登记 host-config、应用文档里的服务偏好；`opts` 为配置同步选项）；`ConfigProvider` 类型改由 `@aalis/runtime` 导出。`syncPluginDefaults` 改为 `(app, store, opts?)`，`handleConfigChanged` / `installConfigHotReload` 改为 `(app, store, discovery, opts?)`（`discovery` 即 `createPluginDiscovery` 的返回值），`withPluginConfigSync(loader, app, store, opts)` 改为导出。`startAalis` 的装配序为：文档 → App → host-config → 加载政策 → 发现 → 热重载；热重载在 `app:stopping` 时停止监听。宿主不持久化（`createConfigStore` 未传 provider，或 provider 不提供 `save`）时，host-config 的 `save()` 立即兑现、不写盘，也不再记「配置已保存」。
- authority、cli、mcp-client 删去只为落盘而声明的 `app` 依赖，改用 host-config 的 `save()`；webui-server 与 package-manager 同样改用 `save()`。host-config 不再由 core 保证在场：plugin-authority 缺它时激活失败；cli、package-manager 降级；mcp-client 的 `mcp_set_server_enabled` 不改动运行态并返回失败；WebUI 读写文档的路由与服务偏好路由返回 503。市场依赖图与 WebUI 服务页把根上的提供者标为「宿主」。
- host-config 新增只读的 `trimUnknownFields`，声明宿主的裁剪政策（`installHostConfig` 按 `opts` 填入；`startAalis({ configSync: { trimUnknownFields: false } })` 时为 false，不声明按 true）。WebUI 保存插件配置按它裁剪：宿主保留未知字段时，WebUI 也不再删掉 schema 外字段，不附「已忽略」。此前 WebUI 总按 schema 裁剪，与宿主政策无关。

**迁移**：
- `hostConfig` / `HostConfig` 改从 `@aalis/api-host-config` 导入；`appService.saveConfig()` 改为 `hostConfig.save()`。
- 向 `'@aalis/core'` 增广 `AalisConfig` 的，改为 `declare module '@aalis/api-host-config'`。
- 直接调管理动作又要持久化的插件，动作成功后自己写文档并 `save()`。
- 自组装宿主：`const store = createConfigStore(config, provider); const app = new App({ name: store.get('name'), logLevel: ... }); installHostConfig(app, store);`，登记插件时按文档传配置与 `{ disabled }`。默认值须深合并进配置（`withPluginConfigSync` 即此政策），不能顶层浅合并：只写了半块的嵌套组会把默认值整块顶掉。自定义配置来源的 `ConfigProvider` 类型改从 `@aalis/runtime` 导入。
- 自定义 `ConfigProvider`（或自行实现 `HostConfig` 的宿主）为免覆盖外部修改而拒绝保存时，抛 `@aalis/api-host-config` 的 `ConfigSaveRefusedError`：宿主据此只记告警，WebUI 据此回 409；抛其它错误按写入失败处理（记 error，WebUI 回 500）。调用方区分两者用 `isConfigSaveRefused(err)`，不用 `instanceof`。
- 不提供 host-config 的嵌入式宿主不能使用 plugin-authority。
- JS 调用方仍向 `new App` 传 `config` 时会被静默忽略（TS 对对象字面量会报错）。

### 钩子与贡献点拆为契约包 + 插件（@aalis/core、新包 @aalis/api-hooks / @aalis/api-contributions / @aalis/plugin-hooks / @aalis/plugin-contributions）

- core 删除内置服务 `hooks` / `contributions`、两张注册表、扩展点 `HookContextMap` / `ContributionPointMap` 与相关类型（`Hooks`、`Contributions`、`MiddlewareFn`、`MiddlewareNext`、`ContributionSpec`、`ContributionHandle`）。内置服务从八项变为六项：events、lifecycle、logger、config、provide、services；core 的扩展点只剩 `AalisEvents`。
- 钩子与贡献点改由插件提供：契约在 `@aalis/api-hooks` / `@aalis/api-contributions`（描述符的门面经 `registrar` 登记，激活关闭时同一拍撤回），默认提供者是 `@aalis/plugin-hooks` / `@aalis/plugin-contributions`。服务名仍是 `hooks` / `contributions`，插件 manifest 不用改名。提供者不独占。
- 没有提供者时 `hooks.run` 返回被拒的 Promise，不执行默认动作；`contributions.collect` 抛服务不可用。
- 链内按登记顺序执行。登记序是门面在登记时分配的序号，进程内全部 api-hooks 副本共用一个计数器；提供者契约 `HookRegistry.register` 多一个 `order` 参数，提供者按它升序插入。提供者重启时依赖它的插件先关闭、再按拓扑序重新激活，链序与冷启动相同。以更高优先级换上第二个提供者时，消费者不重启，登记整批重挂，链序不变。相位内的中间件应与顺序无关。
- 运行中换提供者的已知现状：换人瞬间正在执行的链会跳过已移走的中间件；换人到各插件登记重挂完成前新发起的链只看得到已搬过来的中间件。两种情形下截停者都可能缺席、默认动作照样执行。只在运行中上线第二个钩子提供者时出现，第一方部署只有一个提供者。
- 卡链告警改由 plugin-hooks 的日志器发出，文案不变。

**迁移**：
- 插件把 `hooks` / `Hooks` / `MiddlewareFn` / `MiddlewareNext` 改从 `@aalis/api-hooks` 导入，`contributions` / `Contributions` / `ContributionSpec` / `ContributionHandle` 改从 `@aalis/api-contributions` 导入，并在 dependencies 里加上对应契约包；core peer 抬到 `>=0.18.0 <1.0.0`。
- 增广目标：`HookContextMap` 改为 `declare module '@aalis/api-hooks'`，`ContributionPointMap` 改为 `declare module '@aalis/api-contributions'`；同一个块里若还有 `AalisEvents`，要拆开，`AalisEvents` 仍增广 `'@aalis/core'`。
- 部署必须装上 `@aalis/plugin-hooks` 与 `@aalis/plugin-contributions`。npm 加载器只发现项目 package.json 的直接依赖，市场的「更新」不会补这两个依赖：已有项目执行 `npm i @aalis/plugin-hooks @aalis/plugin-contributions`。漏装时 gateway、agent、指令等全部停在 pending，启动日志逐个打印「缺少服务: hooks、contributions」。新建项目的 minimal 及以上各档已包含，bare 档须自行安装。
- 嵌入式宿主把两个插件与其余插件放进同一批 `app.pluginAll`。
- 旧版插件配新 core：插件的编译产物以具名 ESM 导入 core 的 `hooks` / `contributions` / `hostConfig`，在模块链接阶段就失败（`does not provide an export named ...`），日志为「加载插件 "X" 失败」。

### 插件名与实例 id 解析（@aalis/core）

- `parseInstanceId` 以第一个 `:` 切出实例后缀，带不带 scope 同一规则；此前不带 scope 且后缀含 `/` 的实例 id（如 `plain:a/b`）会丢掉后缀。
- `definePlugin` 的 `name` 含 `:` 即视为带实例后缀而拒绝；此前 `odd:scope/plugin` 这类非法 npm 名会被放过。

**迁移**：定义 `name` 含 `:` 的插件改名。

### 契约包：删除与新增的公开面（@aalis/api-tools、@aalis/api-storage、@aalis/api-media、@aalis/api-commands、@aalis/api-webui、@aalis/api-doctor、@aalis/api-embedding、@aalis/api-agent、@aalis/api-persona、@aalis/api-flow-control、@aalis/schema-message、@aalis/schema-log）

- api-tools：删除 `asToolExecutionResult`。`ToolService.execute` 自 0.8.0 起一律返回 `ToolExecutionResult`。
- api-storage：`StorageService.move` / `mkdir` 从可选改为必填。新增 `isStorageNotFound(err)`：有 `code` 时只认 `'ENOENT'`，没有 `code` 才退回文案匹配；`readFile` 等按路径定位的方法约定目标不存在时抛 `code: 'ENOENT'`，其它失败不得用这个 code。`createStorageGateway` 的返回类型收窄，`resolveLocalPath` / `readFileRange` / `watch` 变为必有。网关路由失败时区分两种报错：根已注册、但没有提供者满足所需能力（如在只读根上写入）时报「存储根 X 不支持 write」，只列出缺少的能力；根名未注册时报「未知存储根: X（已注册根: …）」，不再附「需能力 […]」。
- api-media：`MediaService.rememberDescriptionAlias` 改为必填。删除 `TranscribeOptions.prefer`、`TranscribeOptions.withTimestamps` 与 `DescribeVideoOptions.maxTokens`，实现从未读取过它们。`describeImage` 的契约说明改正为识别出错时抛出（行为未变，此前文档写错）。
- api-commands：删除 `OptionSpec.takesValue`。
- api-webui：删除 `WebUIService.setClientDir` 与 `WebuiClientProvider.label`。
- api-doctor：删除 `CheckSpec.label`（从未被读取）。
- api-embedding：`EmbeddingService` 新增可选的 `readonly modelId`（向量空间标识：同值即向量可比，换模型必须换值）。
- api-agent：`agent:reply:before` 的数据新增可选字段 `visibleContent`。
- api-persona：`PersonaSessionOptions` 新增可选字段 `systemPromptExtra`。
- api-flow-control：删除 `FlowControlService.ensureState`（没有调用方；`recordIncoming` 与带 platform 的 `setMuted` 会按需建会话状态）。
- schema-message：删除类型别名 `_MessageRef`；新增运行时导出 `WellKnownMetadataKeys`（`VisibleContent = 'visibleContent'`）。`buildAttachmentRefMatcher` 的 desc 字符类收紧到与 `parseAttachmentRefs` 一致（排除 `|`）：schema-message 0.8.1 之前写入、desc 含裸 `|` 的存量占位符不再匹配，plugin-media 的 `update_image_description` 改写不了它们，消息本身不变。
- schema-log：`parseLogLine` 不再解析旧的 `seq|timestamp|level|scope|message` 行（runtime 0.12 及更早的写入格式），不带 `@aalis/log:1 ` 前缀的行一律返回 `null`。

**迁移**：
- 读工具结果改为 `(await tools.execute(...)).content`（需要图片再读 `.images`）；自己实现 `ToolService` 的必须返回 `{ content, images? }`。只注册工具、handler 返回字符串的插件不用改。
- 第三方存储提供者须实现 `move` / `mkdir`（根不支持时在方法里抛错），目标不存在时抛带 `code: 'ENOENT'` 的错误。经 `createStorageGateway` 调用的代码可以删掉对 `move` / `mkdir` / `resolveLocalPath` / `readFileRange` / `watch` 的存在性判断：这些方法在网关上恒存在，目标根不支持时由调用本身抛错，需要时 try/catch。判断「文件不存在」改用 `isStorageNotFound`；按「未知存储根」文案识别能力不足的代码改为匹配「不支持」。
- 第三方 `MediaService` 实现须提供 `rememberDescriptionAlias`，没有描述缓存的写空方法即可。`media.transcribe` 去掉 `prefer` / `withTimestamps`，音频处理器改用插件配置 `audio.prefer` 选定；`describeVideo` 去掉 `maxTokens`，抽帧描述沿用 `vision.maxTokens`。依赖 `describeImage`「失败返回空串」的调用方自行 try/catch。
- 选项是否取值按 `type !== 'boolean'` 判断，`valueOptional` 只表示值可省略。
- 要换前端，改为在插件里 `provide(webuiClient, { getClientDir }, { label })`；主动提供的前端默认先于自动发现的前端胜出，已存过 `webui-client` 服务偏好时到 WebUI「服务」页切换。展示名优先取提供方插件的 displayName，没有时取 provide 的 `label` 选项。
- `registerCheck` 调用里删掉 `label`。
- 第三方 embedding 提供者建议声明 `modelId`，取值 `<provider>:<model>`；不声明时行为不变。
- 中间件改写 `agent:reply:before` 的 `content`、使其不再是可见正文时（如保留 JSON 给前端渲染），填写 `visibleContent`。自定义 persona 实现把 `systemPromptExtra` 追加在人设提示之后。
- 第三方 `FlowControlService` 实现删掉 `ensureState`，调用它的代码删掉该调用。
- `_MessageRef` 改用 `Message`（二者等价）。
- 自行用 `parseLogLine` 读旧日志归档的代码，先把旧行转成新格式或自行解析。WebUI 日志页与 CLI 历史日志不受影响：runtime 0.13 起每次启动截断重写 `data/latest.log`。

### 实现包不再转导出契约类型（@aalis/plugin-message-archive、@aalis/plugin-persona、@aalis/plugin-authority、@aalis/plugin-doctor、@aalis/plugin-session-manager、@aalis/plugin-flow-control、@aalis/plugin-workflow、@aalis/plugin-tool-system、@aalis/plugin-webui-server、@aalis/plugin-mcp-client、@aalis/plugin-media）

以下导出从实现包删除，只影响类型或内部符号，运行时不变：

| 包 | 删除的导出 | 改从 |
|---|---|---|
| plugin-message-archive | `ArchiveIncomingResult` / `ArchiveNoticeOptions` / `MessageArchiveService` | `@aalis/api-message-archive` |
| plugin-persona | `OutputFormat` / `OutputFormatField` / `PersonaService` / `PersonaSessionOptions` | `@aalis/api-persona` |
| plugin-authority | `AuthorityService`；`AuthorityManager` | 前者 `@aalis/api-authority`；后者无替代，经 `authority` 服务使用 |
| plugin-doctor | `CheckCategory` / `CheckLevel` / `CheckResult` / `CheckSpec` / `DoctorReport` / `DoctorService` | `@aalis/api-doctor` |
| plugin-session-manager | `PlatformProfile` / `SessionConfig` / `SessionInfo` / `SessionManagerService` / `SessionTreeNode` | `@aalis/api-session-manager` |
| plugin-flow-control | `FlowControlService` / `FlowSessionStateSnapshot`（`FlowControlConfig` 仍从本包导出） | `@aalis/api-flow-control` |
| plugin-workflow | `NodeSpec` / `TriggerSpec` / `WorkflowDef` / `WorkflowRun` / `WorkflowService` | `@aalis/api-workflow` |
| plugin-tool-system | `ToolsBasicConfig` | 无替代 |
| plugin-webui-server | `WSIncoming` / `WSIncomingSchema` | 无替代（协议 schema 属实现细节） |
| plugin-mcp-client | `configSchema` | 读默认导出的 `.configSchema` |
| plugin-media | `legacyVisionMode` | 无替代（见下文 `vision.mode`） |

**迁移**：按上表改导入来源。

### 服务契约整理（新包 @aalis/api-user-relation、@aalis/api-package-manager；@aalis/api-tool-session 改名 @aalis/api-session-history；@aalis/plugin-user-relation、@aalis/plugin-user-profile、@aalis/plugin-package-manager、@aalis/plugin-webui-server、@aalis/plugin-tool-onebot、@aalis/plugin-tool-session）

- 新包 `@aalis/api-user-relation`：`user-relation` 的描述符 `userRelation` 与查询接口 `UserRelationService`（目前只含 `getCommunityPeers`）。plugin-user-relation 改从这里导入描述符，不再导出 `userRelation`；实现类 `RelationService` 与图数据类型仍由它导出。plugin-user-profile 改用契约包的描述符，删去本地的同名定义。
- 新包 `@aalis/api-package-manager`：`package-manager` 的描述符 `packageManager` 与 `PackageManagerService` / `UpdateTarget` / `UpdateResult`，plugin-package-manager 不再导出这四项。plugin-webui-server 在 `uses` 里以 `optional(packageManager)` 声明 package-manager，不再按服务名动态查询；插件页的依赖声明因此多出可选的 package-manager，服务缺席时市场的安装、卸载、更新仍返回 503。
- `@aalis/api-tool-session` 改名为 `@aalis/api-session-history`，从 0.1.0 起版，导出与服务名 `session-history` 不变；旧包在 npm 上标为弃用，不再更新。服务按名寻址，仍依赖旧包的已发布插件与依赖新包的插件混装时照常互通。

**迁移**：
- `userRelation` 改从 `@aalis/api-user-relation` 导入，`packageManager` / `PackageManagerService` / `UpdateTarget` / `UpdateResult` 改从 `@aalis/api-package-manager` 导入，并把契约包加进 `dependencies`。两个描述符是运行时值：从实现包导入它们的已发布插件会在模块链接阶段失败（`does not provide an export named 'userRelation'`）。
- 契约里的 `UserRelationService` 只含 `getCommunityPeers`。需要关系图的其它能力时请提需求扩充契约，不要改为依赖实现包。
- 依赖 `@aalis/api-tool-session` 的包改依赖 `@aalis/api-session-history`，导入路径随之替换，其余不变。

### 存储路径只接受 storage URI（@aalis/plugin-checkpoint、@aalis/plugin-scheduler、@aalis/plugin-workflow、@aalis/plugin-office）

下列配置项不再把相对路径或裸名自动转换为 storage URI。写成非 URI 时插件拒绝激活，错误里给出正确写法；未设或留空时用默认值。

| 包 | 配置项 | 默认值 | 旧写法举例 → 新写法 |
|---|---|---|---|
| plugin-checkpoint | `rootDir` | `data:/checkpoints` | `data/checkpoints` → `data:/checkpoints` |
| plugin-scheduler | `persistPath` | `data:/scheduler-jobs.json` | `data/scheduler-jobs.json` → `data:/scheduler-jobs.json` |
| plugin-workflow | `defsDir` / `runsFile` | `workspace:/workflows` / `data:/workflow-runs.json` | `workspace/workflows` → `workspace:/workflows` |
| plugin-office | `outputDir` | `workspace:/` | `workspace` → `workspace:/`；`data/docs` → `data:/docs` |

plugin-checkpoint 同时删除读取 manifest 时对旧条目的过滤（自指条目与 data / tmp 等不记账根上的条目）。0.10.x 及更早写下的回合若含这类条目，回滚会照常处理它们，可能删掉别处落盘的文件或检查点自身的备份。

**迁移**：升级前把上表配置项改成 storage URI，或删掉该键使用默认值。checkpoint 在升级前执行 `/clear all --type checkpoint` 或删除 `data/checkpoints`；0.10.x 及更早写下的回合不再支持回滚。

### 持久化文件读不懂时不回写（@aalis/runtime、@aalis/plugin-authority、@aalis/plugin-flow-control、@aalis/plugin-scheduler、@aalis/plugin-workflow、@aalis/plugin-vectorstore-flat）

整表写回的持久化文件统一按三态处理：文件不存在按全新开始；文件在但读不出、解析失败或结构不对时记日志、本次运行按空表工作且不再写回该文件，改动只在内存生效，原文件保留待修；读成功照常。「不存在」统一以 `isStorageNotFound` 判定，带其它错误码的失败（如 `EACCES`）不再被当成新建。

- plugin-authority：`users.json` 不是有效的 v5 结构时（包括 v1–v4 旧模型与更高版本），不再静默丢弃并在下次保存时覆盖，改为记 error、本次运行拒写，等级改动只在内存生效。旧版本文件不做迁移。
- plugin-authority 因加载失败而拒写期间，`/level` 的回复与 WebUI 权限管理页设置等级、删除记录的提示末尾注明「仅本次运行生效，未写入 users.json（加载失败，见日志）」。页面显示这段附注需要同批的新版 plugin-webui-client。
- plugin-authority 首次读取 users.json 落定之前（storage 晚于本插件上线时，包括 storage 刚上线、读取尚未发起的间隙）与 storage 重新上线触发的重读期间不再写盘，读完后再落盘，停机与卸载会等进行中的读取与这次落盘完成。此前首次读取期间或 storage 刚上线的间隙里的一次改动会用只含这条改动的快照覆盖整个 users.json，重读期间的改动会覆盖读不懂的 users.json。storage 上线前改等级、删记录时，`/level` 的回复与 WebUI 设置等级、删除记录的提示末尾注明「未写入 users.json（等级表尚未载入），载入后写入」；首次读取发起之前（storage 未上线，或刚上线、读取尚未发起）停机或卸载，这些改动不写入。`/level` 与 WebUI 设置等级、删除记录先等进行中的读取完成再改，写入结束后才回复。读取过程出现意外异常（如存储抛出无法转成字符串的错误值）时按读不懂处理，本次运行拒写。
- plugin-authority 读成功后以文件内容重建等级表，不再把文件里的记录并入内存：运行中从 users.json 删掉的记录随重读消失（此前仍留在内存）。自上次成功写入以来改过或删过的用户以内存为准，读完后一并写入，包括 storage 上线前（首次读取尚未开始）的改动与删除，以及读取开始时尚未写完的改动；此前文件里有的用户一律以文件为准，这些改动在内存里被撤回，删掉的记录随文件回来。以内存为准时，内存记录里没有的备注沿用文件里的。首次读取落定之前、以及读取失败而拒写期间把等级降为 0，也保留这条记录：它以 0 级写入 users.json，并沿用文件里的备注（其余时候降为 0 级且无备注仍直接删除记录）。重读时 users.json 不存在则保留内存里的等级表。
- plugin-authority 写 users.json 失败（storage 不在线、权限不足、磁盘写满）时记 error（此前为 warn），`/level` 的回复与 WebUI 设置等级、删除记录的提示末尾注明「未写入 users.json（写入失败，见日志），下次保存时重试」，此前照常报成功。改动留在内存，下次保存（再次改等级、storage 重新上线后的重读、停机或卸载）时重写。
- plugin-authority 的日志上报自身出错（日志订阅者同步抛错，或写入、加载 users.json 的错误值转不成字符串）时不再外抛；加载失败的错误值转不成字符串时照常记下告警。此前写 users.json 的保存链会停在拒绝：此后的保存都不再写盘，停机与卸载等待落盘时抛错，没人等待的拒绝还会被宿主当作致命错误退出进程；加载 users.json 的成功或失败日志抛错时，storage 已在线则 authority 激活失败，晚上线则同样以未处理的拒绝退出进程。
- plugin-flow-control：禁言表 `data:/flow-control-mutes.json` 读不出、坏 JSON 或顶层不是对象时不再整表覆盖；storage 换人后重读成功即恢复落盘。optional 的 storage 晚于本插件上线或换人重读时，自上次成功写盘以来 `setMuted` 改过的会话（含解禁，含尚无状态的会话）以内存为准，其余会话按较晚到期合并，读完后把这些改动补写进文件。
- plugin-scheduler：动态任务文件读失败（含激活时 storage 不在场）、解析失败或合法 JSON 但不是数组时，本次运行不写该文件。拒写期间 `scheduler_create_job` 的回执末尾注明「仅本次运行生效，未写入 <persistPath>（加载失败，见日志）」，WebUI「计划任务」表单保存后同样显示这句附注。
- plugin-workflow：运行历史文件读失败（含激活时 storage 不在场）、解析失败或结构不对时，本次运行拒写该文件，也不安排任何 once 触发（含 runAt 在未来的）；这期间经 `workflow_define` 定义启用中的 once，回执带 `note`，说明本次运行不会触发、可用 `workflow_run` 手动执行；WebUI 新建或覆盖表单保存 once、「禁用/启用」启用 once 时同样显示这句说明，手动执行指向「立即运行」。0.11.x 及更早写出的顶层数组格式同样按读不懂处理。列定义目录报错带非 `ENOENT` 的 code 时按扫描失败处理，不再据此清空 once 记账。
- plugin-vectorstore-flat：`vectors.json` 读不出、解析失败或不是数组时，本次运行按空库在内存中工作且不再写入，`clear` 也不写。此前文档写明的「坏文件不影响后续写入」不再成立。
- runtime：保存配置文件前比对盘上内容，手改尚未生效或另一个进程写过时拒绝本次保存，报「配置文件有尚未生效的外部修改，为免覆盖已拒绝本次保存（<路径>）」，不再静默覆盖手改；拒写时抛 `@aalis/api-host-config` 的 `ConfigSaveRefusedError`，只记一条告警。启动与热扫描时配置同步落盘遇到拒写同样只记一行告警「配置同步未落盘：…」，不带堆栈；其它落盘失败照旧记告警并附错误。拒写之后调用方的文档已领先于文件，下一次文件变更即使内容与上次生效的那份逐字节相同（例如把改坏的文件原样改回）也照常热重载，按文件重新对账。监听武装后立即对账一次；平台不支持文件监听时告警，此后手改需重启才生效。
- 统一判据后，tool-system 的 `file_append`、checkpoint 回滚删除遇到带非 `ENOENT` code 的错误时如实报错。

**迁移**：
- 出现上述告警时修复或移走对应文件后重启。workflow 的 once 也可以用 `workflow_run` 手动执行。
- `users.json` 仍是 v1–v4 格式的，删除或移走该文件后重启，即按全新开始。
- `/level` 回复或 WebUI 提示带「仅本次运行生效」附注时，按日志修复或移走 users.json 后重启，再重做这些等级改动。storage 晚于 authority 上线、且在启动窗口里改过等级的旧版本部署，核对 users.json 是否缺了原有记录。带「未写入 users.json（写入失败，见日志）」附注时，恢复 storage、修好写入权限或腾出磁盘空间即可，改动在下次保存时写入。带「等级表尚未载入」附注的改动在 storage 上线、读完 users.json 后写入，首次读取发起之前（storage 未上线或刚上线）就停机的需重做。
- `workflow-runs.json` 顶层是数组的，改成 `{"runs": <原数组>}` 或删除。
- 遇到配置保存被拒时，等热重载吸收手改或修正配置语法后重做该操作；进程没有监听配置文件时（子命令进程、平台不支持监听）重启后再做。直接调用 `createFsYamlConfigProvider().provider.save()` 的自定义宿主须接住这一抛错，用 `isConfigSaveRefused(err)` 与写入失败区分；经 host-config 的保存由宿主记日志，拒写记一条告警，其它失败记 error。

### 删除已发布版本的旧配置与旧数据兼容（@aalis/plugin-memory-history、@aalis/plugin-media、@aalis/plugin-llm-openai、@aalis/plugin-embedding-openai、@aalis/plugin-office、@aalis/runtime、@aalis/plugin-webui-server、@aalis/plugin-file-reader、@aalis/plugin-memory-vector）

- plugin-memory-history：不再识别 `scope: 'off'`。该值现在按 `same-platform` 处理，被动注入按 `injectEnabled` 的默认值（true）打开，不报错。
- plugin-media：删除已弃用的 `vision.mode` 及其自动迁移，同时删除对 host-config 的可选依赖。配置里仍有 `vision.mode` 的部署，升级后首次启动时配置同步会把它当作 schema 外字段裁掉并写回文件（日志「裁掉 schema 外字段 [vision.mode]」），生效的是新键默认值 `recognizeOnArrival: true`、`delivery: auto`：原来是 `disabled` 或 `passthrough` 的部署会开始在图片到达时识别，隐私与识别成本随之变化。描述缓存加载时不再剔除 0.12.x 写入的失败占位条目；读取发送者画像时不再接受字符串数组形式的事实。
- plugin-llm-openai、plugin-embedding-openai：`baseUrl` 恰为 `https://api.openai.com` 时不再在内存里自动补成 `.../v1`（这个垫片从不写回，配置文件里仍是旧值）。不改的话 llm-openai 的 `/models` 与 `/chat/completions` 返回 404：自动发现不到模型（启动日志「未发现任何可用模型」），`customModels` 里的模型仍会注册但每次请求失败；embedding-openai 启动连通性检查只打 warn、服务照常注册，之后每次 embed 都 404，向量索引与召回全部失效。
- plugin-office：`doc_add_paragraph` 删除已废弃的 `indent`（磅）参数与 `spacing.line` 行距别名，仍传时被忽略、回落到 preset 或 `doc_set_style` 的默认值。
- runtime：`startAalis({ subcommands })` 在运行时也只接受数组。JS 宿主传 `true` 会按「不分发」处理，带参数启动时直接进守护进程。TypeScript 宿主自 0.12.0 起类型已只收 `string[]`，不受影响。
- plugin-webui-server、plugin-file-reader：「已上传的文件」只认把 sessionId 里的 `:` `/` `\` 替换成 `_` 后的会话目录名。plugin-file-reader 0.11.0 之前按原样 sessionId（含 `:`）建的目录，在 WebUI 按会话列表里不再出现，下载与删除返回 404（不带 sessionId 的全量列表仍能列出）；会话删除（如 `/clear`）也不再顺带清理这类目录。另外，WebUI 配置表单的 `dynamicOptions` 下拉聚合非 llm 服务的模型时只接受 `listModels()` 返回 `string[]`，返回 `{ id, capabilities }` 对象的第三方服务会显示成 `[object Object]`。
- plugin-memory-vector：删除检索期对存量「[跨会话委派 META]」向量的过滤（0.11.0 起索引侧已不再写入这类向量）。不删的话，这些旧向量会重新进入召回。

**迁移**：
- memory-history：仍在用 `scope: 'off'` 的改为 `injectEnabled: false`，`scope` 删掉或改为 `same-platform` / `cross-platform`。
- media：在 0.13.0 及以上版本启动过的部署已经自动迁移，无需操作。配置里仍有 `vision.mode` 的，升级前按旧值改写：`describe` → `recognizeOnArrival: true` + `delivery: describe`；`passthrough` / `passthrough-raw` → `recognizeOnArrival: false` + `delivery: passthrough`；`disabled` → `recognizeOnArrival: false` + `delivery: describe`。从 0.12.x 直接升级的，先删除 `data/media/descriptions.json`（纯派生缓存，删掉只损失复用），或先在 0.13.0–0.14.x 上正常启停一次。
- llm-openai、embedding-openai：`baseUrl` 写成含版本段的完整前缀，如 `https://api.openai.com/v1`。
- office：首行缩进改用 `firstLineIndentChars`（字符数），行距改用顶层 `lineHeight`。
- runtime：原来传 `subcommands: true` 的删掉这一项（默认按 `process.argv` 分发），原来传 `false` 的改传 `[]`。
- 上传文件目录：把 pluginData 根（默认 `data/plugins`）下 `file-reader/` 里含冒号的会话目录改名为替换后的名字；同一会话的新目录已存在时，把文件移进去再删掉空的旧目录。第三方服务的 `listModels()` 改为返回模型 id 字符串数组。
- memory-vector：升级前停机，从向量库删除 content 以「[跨会话委派 META]」开头的向量。LanceDB 执行 ``table.delete(`metadata_json LIKE '%"content":"[跨会话委派 META]%'`)``；其它后端按 `metadata.content` 前缀删除。

### 删除首个 npm 版本之前的数据兼容（@aalis/plugin-memory-sqlite、@aalis/plugin-user-profile、@aalis/plugin-user-relation、@aalis/plugin-webui-client）

这几个包删除了对首个 npm 版本（0.1.0，2026-06-14）之前数据格式的读取兼容与启动迁移，只影响在那之前从源码运行积累的数据，已发布版本写出的数据不受影响。user-relation 随之收紧的类型与返回形状见「关系图」一节。

**迁移**：从 npm 版本开始使用的部署无需操作。仍在使用 2026-06-14 之前从源码运行积累的数据的，升级前把数据补齐到当前结构，或清空后重新积累。

### 配置字段类型 list / map 与 MCP 配置（@aalis/schema-config、@aalis/plugin-webui-client、@aalis/plugin-mcp-client、@aalis/plugin-mcp-server）

- schema-config 新增中立字段类型 `list`（有序字符串数组）与 `map`（字符串到字符串的映射），`validateConfig` 校验它们的形状。WebUI 配置表单以多行文本编辑：list 每行一项，map 每行一条 `KEY=VALUE`。数字、布尔值按字符串显示，编辑后写成字符串；值里有逐行文本表达不了的内容（项或值含换行、list 的空白项、`null`、嵌套的数组或对象、map 的键为空或带首尾空白或含 `=` 等）时，该字段只读显示，需在配置文件中编辑。旧版 WebUI 存下的空串按空列表 / 空映射显示，保存时写成 `[]` / `{}`。
- plugin-mcp-client 的配置 schema 重新挂到插件定义上，WebUI 表单、默认值补齐与未知字段裁剪恢复生效。`servers[].args` 改为 list、`env` 改为 map，不再解析字符串形态：`args` 不是数组或 `env` 不是对象（包括旧版 WebUI 新建条目时写入的空串 `args: ''` / `env: ''`）时，该 server 告警且不启动，其它 server 照常。
- plugin-mcp-server 的 `toolGroups` 改为分组名字符串数组（WebUI 用多选加自定义项编辑）。值不是数组或含非字符串元素时激活失败（插件显示为出错，错误信息即原因），不监听，不再兼容 `[{ name }]`。`['']` 现在按字面组名处理、什么都不暴露（此前等于全部暴露）。
- plugin-mcp-server 的 `port` 不是 1–65535 的整数时同样激活失败。此前只记 error，插件显示运行中、doctor 无异常，实际没有监听。
- plugin-mcp-client 的 `mcp_set_server_enabled` 在配置文件写入失败时（包括配置文件有尚未生效的外部修改而拒写），不再只返回一条错误。返回的文本说明运行态已切换、插件会 bounce，并给出写入失败的原因：配置文件里仍是原值，重启或配置重新载入后可能回退。此前 agent 只看到错误，会误以为开关没有变。

**迁移**：
- mcp-client：字符串形态的 `args` 改写为数组。旧规则先按行、再按空白切分，所以 `"-y @scope/pkg"` 与 `"-y\n@scope/pkg"` 都改为 `["-y", "@scope/pkg"]`。`env: "KEY=VALUE"` 改为 `{ KEY: "VALUE" }`，`#` 注释行删掉。旧 WebUI 留下的 `args: ''` / `env: ''` 删掉该键，或改为 `[]` / `{}`，也可以在新版 WebUI 打开 mcp-client 的配置保存一次。配置顶层写了 schema 以外字段的，启动时会被裁掉并告警。
- mcp-server：`toolGroups: [{ name: search }]` 改为 `[search]`；全部暴露写 `[]` 或 `['*']`；裸 `'*'` 与 YAML 裸键 `toolGroups:` 改为 `[]` 或 `['*']`。
- 自行实现配置表单宿主的第三方需要支持 `list` / `map`；对字段类型做穷尽 switch 的代码会编译报错，补上分支。

### 未装 plugin-authority 时拒绝受限能力（@aalis/plugin-tools、@aalis/plugin-commands、@aalis/plugin-tool-onebot）

- 工具与指令的执行守卫缺席时改为 fail-closed：声明了 `confirm`，或按 `capabilityMinLevel` 定级高于默认等级的能力（一般即 restricted，或 risk 为 sensitive / dangerous）一律拒绝，提示「需要权限校验或确认，但未安装权限插件 @aalis/plugin-authority，已拒绝执行」；其余照常执行。指令按整条点路径取最严的声明：未装 authority 时 `/clear`、`/clear list`、`/clear all`、`/shutdown`、`/restart` 等不可用，`aalis <子命令>` 一次性模式同样适用。此前守卫缺席时一律放行。
- plugin-tool-onebot：`sessionHistory.enabled=false` 只关两个 OneBot 专属历史工具，`allow*` 会话历史访问规则始终生效。此前关掉该开关会连带撤掉访问规则。访问规则改为跟随 tool-session 提供者注册：此前 tool-session 重启或晚于 `app:ready` 上线后规则会静默丢失，群聊可读私聊历史。OneBot 平台晚于 `app:ready` 上线时也会补注册工具。

**迁移**：需要受限工具或指令的部署安装 `@aalis/plugin-authority`（create-aalis 的 minimal 及以上各档已包含）。嵌入式宿主或测试可自行 `setExecutionGuard`。想保留 tool-onebot 旧行为，把对应 `allow*` 设为 true。

### 浏览器工具的私网拦截改在浏览器级（@aalis/plugin-tool-browser）

- `blockPrivate=true`（默认）时，私网与本机拦截从逐页的请求拦截改为浏览器级拦截。此前 SharedWorker、Service Worker 与页面自己 `window.open` 打开的窗口发出的请求不经本插件的拦截；现在与页面、dedicated worker 一样逐个判定，被拒的请求以 `net::ERR_BLOCKED_BY_CLIENT` 失败。WebSocket 连接仍不经过这道拦截。
- 判定超过 10 秒未完成的请求按拒绝处理；此前没有时限，会一直挂到导航超时。
- 请求拦截开启失败时关掉刚启动的浏览器并报错，浏览器不会在没有拦截的情况下运行。

### 市场装卸与 WebUI 接口（@aalis/plugin-package-manager、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-authority）

- 市场安装前经 `npm view <spec> keywords --json` 检查类型关键词，只放行带 `aalis-plugin` 或 `aalis-interface` 的包；内核、宿主、契约、schema、工具库类包被拒，并提示改用「更新所选」。
- 市场安装压掉 `legacy-peer-deps`（与更新预检同口径）：用户或项目 `.npmrc` 里的 `legacy-peer-deps=true` 不再作用于市场安装，peer 冲突时安装失败并列出冲突。安装与更新预检列出的冲突保留根项目的声明行（`… from the root project`），看得出冲突由哪条根依赖引起。
- 服务依赖者卸载闸从 WebUI 路由移入 package-manager 服务层；`PackageManagerService` 新增必需方法 `serviceDependents(name)`，市场卸载前预警改调它。被服务依赖阻断的卸载由 HTTP 409 改为 200 加 `{ ok: false, message }`。卸载成功消息与两个卸载确认弹窗提示：插件写入 data/ 等存储根的数据不会删除。
- 卸载闸与卸载前预警判定服务依赖时看插件状态：同类提供者只算已激活或激活中的，已禁用、激活失败或等待依赖的都不算替代；已禁用的插件不算会被打断的依赖方。此前卸掉唯一在用的提供者时，一个已禁用的同类提供者就能让卸载放行、预警为空；已禁用的插件反而会挡住卸载。
- 市场卡片的最新版与「可更新」、系统组件的最新版、未安装包的依赖图，改为按包名向安装实际使用的 npm 源查（package-manager 在项目根执行 `npm config get registry` 的结果）；`PackageManagerService` 为此另新增必需方法 `registry()`。`marketplaceRegistry` 只用于检索（package-manager 缺席时版本也退回检索源查，此时本就不能装卸）；`GET /api/marketplace?q=` 的检索结果另按搜索词在包名、描述、关键词上过滤（WebUI 市场页自己在前端过滤，看不出变化）。此前这些版本号取自检索源，检索源比安装源新时，卡片会给出装不到的「可更新」版本。安装源查不到时不显示最新版与可更新，市场页顶部说明原因；未安装、查不到最新版的卡片显示「版本未知」。
- 删除 `GET /api/logs`，改调 `GET /api/logs/tail`（默认 200 条，结果相同）。
- `GET /api/status` 的响应不再包含 `services` 布尔表。webui-server 不再以可选依赖声明 memory 服务，WebUI 依赖展示里不再列出 memory。
- persist 模式的访问令牌改为经 storage 跟随读回：storage 晚于 WebUI 上线时不再生成新令牌。
- 启停插件、修改插件配置、新建或删除实例、设置或清除服务偏好的接口，在改动已生效、但保存配置文件失败时返回 JSON `{ error, applied: true }`，此前是 Express 默认的 HTML 500。`applied: true` 表示改动已在运行态生效、没有写进文件。宿主拒写（文件里有尚未生效的外部修改）时返回 409：修好配置文件后，插件配置随热重载回到文件里的值，没写进文件的新建实例随热重载卸载，删掉而配置段仍在文件里的实例随热重载重新登记；启停与服务偏好在重启时以文件为准。其它失败（没有写权限、磁盘写满等）返回 500：文件没有变化，改动保留在配置文档里，下一次保存成功时一并写入。
- 启用插件后激活失败、插件转为 error 态时，接口返回 500 并附失败原因，配置文件照样记为启用；修改插件配置后按新配置重新激活失败时，同样返回 500 并附原因，新配置照样写入配置文件。此前两者都回报成功。
- 新建多实例时，如果内核拒绝登记（停机进行中），返回 409，配置不写入文件。此前会回报「已创建实例」并把配置写进文件，下次启动会按文件登记这个实例。
- 删除实例时一并清除它的禁用标记。停用后删除、再用同一后缀重建的实例以启用态登记；此前以禁用态登记，回执却是「已创建」。
- 全局配置（`PUT /api/config`）保存失败时撤回文档里的改动，拒写返回 409、其它失败返回 500，响应为 `{ error }`（不带 `applied`）；此前一律返回 500 且改动留在文档里，会被下一次任意保存写进文件。保存成功后重启失败（宿主不支持重启）时不撤回，记一条错误日志，响应 `restart: false` 并说明改动在下次启动生效，WebUI 不再一直停在「正在重启」。此前先回复 `restart: true` 再重启。`POST /api/config/save` 遇到拒写同样返回 409，其它失败仍返回 500。
- `PUT /api/config` 只在 `logLevel` 变化时重启应用；只改 `name` 时保存即生效，不再整进程重启。WebUI 保存全局配置后立即重新拉取系统状态，界面上的名称随即更新（装有人设时界面显示人设名）。
- `PUT /api/plugins/:name/config` 裁掉插件 schema 未声明的字段时不再只记日志：本次提交里的列在响应的 `ignored` 里；配置文档里原有、本次没有提交的照旧随保存从配置文件删除，列在 `removed` 里；两者都附在 `message` 末尾。插件运行中、且提交后的配置与运行态和配置文档都相同时，不再重载插件及其下游，只把配置文档写回文件，回复「插件 X 配置无改动，已写回配置文件」；上一次保存写文件失败（500）后原样重新提交，即可补写。写回时保留配置文件里该插件原有的键序，缺的默认键追加在末尾，此前按 schema 默认值的顺序重排。插件配置页保存成功后显示服务端返回的 `message`，不再固定显示「配置已更新，正在重载…」。
- WebSocket 收到非 JSON 帧时只记一行告警「WebUI 收到协议违规消息: 非 JSON 帧」，不再记成「WebUI 消息处理失败」并带整段栈。
- 权限管理页的操作提示改为显示服务端返回的回执；提示停留时长按字数计算，至少 2.2 秒。例如撤销已不存在的临时委托时显示「不存在或已过期」，不再误报「已撤销」。
- plugin-authority 的页面动作 `setAuthorityOverride` 返回值新增 `revokedGrants`（因门槛变更撤销的会话授予条数）。权限管理页整组设最低等级时等全部请求落定再提示：按各条的 `revokedGrants` 合计撤销数，有失败时列出成功与失败条数及去重后的原因，无论成败都刷新页面。此前一条失败就只显示该条错误、不刷新，成功时也不提示撤销数。
- 会话历史里的附件引用改为按文件名之后的固定格式定界剥离：文件名含半角括号或方括号（如 `report (1).txt`、`data [v2].csv`）时，内联文件正文、大文件引用（含早期的单行格式）、超限、处理失败与降级引用都整块隐藏，用户气泡里不再露出文件正文、文件 ID 或「说明：…」残片；大文件引用之后的图片描述不再被一并隐藏。最早那批文件头不带文件 ID 的内联文件块（`[文件: <名称>]` 下一行即「--- 文件内容 ---」）同样整块隐藏。
- 配置表单里动态选项的下拉框，在拉取失败或没有可选项时显示「无可选项」，不再一直显示「加载中...」。
- 声明式页面的成功回执 `{ ok: true, message }` 带 message 时，WebUI 显示它：表单代替「已保存」，按钮组代替「完成」，表格行内操作先弹窗告知。
- 关系图「字段含义」里的「完整文档」链接改指公开仓库里的文档，此前打开的是 WebUI 首页。

**迁移**：
- 依赖 `legacy-peer-deps` 才能从市场装上的插件，先升级冲突的包解决 peer 冲突；不要用 `--legacy-peer-deps` 绕过。
- 自己实现 `PackageManagerService` 的第三方补上 `serviceDependents` 与 `registry`。按状态码判断卸载被拒的脚本改为读响应的 `ok` 字段。
- 自写客户端收到带 `applied: true` 的 409 或 500 时按「已生效、未落盘」处理，不要当作改动失败：409 先修好配置文件，由热重载按文件对账；500 在修好写入条件后，下一次成功保存会把改动一并写入。服务偏好接口原有的 409（提供者拒绝该偏好）不带 `applied`。
- 读过 `status.services` 的自写前端改为请求 `GET /api/services`，响应形如 `{ services: { <服务名>: { providers, preferred } } }`：某服务的键存在且 `providers` 非空即表示在场。原表的 llm、agent、memory、persona、cli 都对应同名服务；原 `webui-server` 一项在本插件运行时恒为 true，可直接删掉。

### 关系图（@aalis/plugin-user-relation、@aalis/api-embedding、@aalis/plugin-embedding-ollama、@aalis/plugin-embedding-openai）

- `/relation orphans` 与 `/relation cleanup orphans` 改用与自动孤儿清理相同的判定（6 类边都算引用）：只挂 event-entity / entity-entity 边的事件和实体不再被列为孤儿，也不再被误删。cleanup orphans 顺带清理悬空边，报告多一项「悬空边 N 条」。
- 整理时先确认事件节点仍存在再写它的向量，整理期间节点被并发删除时不再留下孤儿向量。
- 开启 auto-link 的整理在严格等价合并时先核实两端实体仍存在：同一轮里已被合并删除的实体不再生成悬空的 is-alias-of 边，也不再送 LLM 核验、写否决缓存。此前同名组有 3 个及以上实体，或成员已在另一同名组被吸收时，会留下这类边。
- community_overview 不传 algorithm 时改用配置项 `communityAlgorithm`（此前固定为 louvain）。配置了 leiden / slpa 的实例默认结果会变。
- 删除第一方页面没用到的 8 个页面动作：getStats、getPerson、getEvent、deleteEdge、triggerExtraction、expandPerson、findPath、searchEvents。手动提取入口一并移除，提取只由 `triggerEveryNMessages` 自动触发，0 表示关闭自动提取（效果与 `extractionEnabled=false` 相同）。
- `RelationService` 删除 `getPerson`、`findEntityByName`、`findPersonEntityEdge`、`findPersonEventEdge`、`deleteEdge`、`triggerExtraction`、`setTriggerExtractionHandler`。
- 返回形状：`pruneOrphans` 去掉 `deletedPersonIds` / `deletedEventIds` / `deletedEntityIds`，只留计数；`evictByQuota` 去掉 `orphanSamples`；`consolidate` 去掉恒为 0 的 `partOfEdgesCreated`，`/relation consolidate` 与 `maintain` 的输出也去掉 part-of 统计；`getCommunityOverview()` 与社群概览工具返回的 `bridges[]` 去掉 `crossCommunityDegree`。
- 参数收窄：`correctEdge` 去掉 `force`（weight ≥ 0.5 的边须先 weaken 再 remove）；`rewriteWeights` 去掉 `opts.now`；`scoreBetween` 去掉 `beta`（固定 0.5）；`consolidate` 去掉 `entityCosThreshold`（固定 0.86）；`findEventDuplicates` 去掉三个阈值（固定 0.7 / 0.4 / 0.5）；`findEventByTitle` 的 `scope` 改为必填；`createEvent` / `createEntity` 的入参不再接受 `weight`、`lastMentionedAt`、`mentionCount` 与事件的 `occurrences`（原本就被忽略），事件的 `sessionScope` 仍可选传。
- 类型：`EventNode` 的 `sessionScope` / `occurrences` / `weight` / `lastMentionedAt` / `mentionCount`，`EntityNode` 的 `weight` / `lastMentionedAt` / `mentionCount`，`PersonNode` 的 `lastMentionedAt` / `mentionCount` 改为必填。
- 向量失效键并入 embedding 提供者的 `modelId`；两个第一方提供者分别声明 `ollama:<model>` / `openai:<model>`。本插件与 embedding 提供者都升级后，库里已有的事件与实体向量视为过期：事件向量在第一次事件去重扫描时按 8 路并发全部重算一次（会触发扫描的有：配置了 `consolidationModel` 且开启 auto-link 的整理，即 `/relation maintain`、`/relation consolidate --auto-link` 或 `consolidationAutoLink=true` 时的自动整理，以及 `/relation event-duplicates`）；实体向量在宽召回比对到时按需重算。此后换 embedding 模型（包括同维度换模型）都会自动重算。
- 超配额淘汰与 `/relation rewrite-weights` 的衰减回写，如果和 `/clear all` 或 `/relation cleanup all` 交叠（回写期间开始清空，或清空进行中开始回写），清空完成后不再写回剩余的节点与边；只有清空提交那一刻正在写入的一条可能保留。淘汰末尾回写人物的 PageRank 与社群标签前，会先确认人物仍存在，并以库中当前内容为基底。此前清空回执报成功后，关系图会被部分写回，可能带悬空边。
- 关系图注入构建出错（如读图失败）时，由 agent 记一条 warn「agent:prompt 贡献 "…/user-relation" 构建失败（本轮缺席）」，不再只在开启 `debug` 时记 debug；`debug` 的配置说明相应去掉「注入」。

**迁移**：
- 要 community_overview 旧结果，调用时显式传 `algorithm: 'louvain'`。
- 经 `POST /api/page-action/:plugin/:method` 按名调用被删页面动作的脚本，改用 Agent 工具（`user_relation_expand_node` / `user_relation_find_path` / `user_relation_search_events` / `user_relation_delete_edge` 等）或 `/relation` 指令。
- 被删服务方法的替代：`getPerson(platform, userId)` → `(await service.getNeighborhood('<platform>:<userId>')).person`，或在 `loadAll().persons` 里查找；`findEntityByName(name)` → 已知 kind 时用 `findEntityByKindAndName(kind, name)`（只比对 name、不看 aliases），跨 kind 或按别名查找时在 `loadAll().entities` 上自行比对；`findPersonEntityEdge` / `findPersonEventEdge` → 在 `loadAll().edges` 上按 kind、端点与 role 筛选；`deleteEdge(edgeId)` → `deleteEdgeWithGuard({ edgeId, reason })` 或 `correctEdge({ edgeId, action: 'remove', reason })`，两者都带保护（alias 边禁删；前者拒删 weight ≥ 0.8 或 evidence ≥ 5 的边，后者要求 weight < 0.5），已没有无保护的公开删边方法；`triggerExtraction` / `setTriggerExtractionHandler` 无替代。
- 读 `crossCommunityDegree` 的改用 `communityWeights.length`。
- 旧版留下的悬空 is-alias-of 边：图超出配额、触发超配额淘汰时随其中的孤儿清理移除；图未超配额或关闭了淘汰的实例，运行一次 `/relation cleanup orphans` 或 `/relation maintain`。
- 向量重算无需手动操作；使用计费 embedding API 的实例会看到一次性的调用量上升。

### agent、persona 与记忆（@aalis/plugin-agent、@aalis/plugin-persona、@aalis/plugin-memory-vector、@aalis/plugin-memory-summary、@aalis/plugin-user-profile）

- 并行工具批次里单个工具的钩子、守卫或结果处理抛错，只让该工具失败并转成它自己的错误结果，同批其它工具照常落定；执行前与执行后的失败分别给出结果，执行后的失败明说「已执行」。`agent:tool:after` 钩子失败时不回退到原始结果（fail-closed），原始输出不交给模型。已发出 `tool:execute` start 的失败工具补发 end（result 为同一份错误），WebUI 流式缓冲里这一段不再一直显示执行中。
- `agent:tool:before` 钩子往工具参数里放了 JSON 序列化不了的值（如 BigInt、循环引用）时，工具照常执行，调试日志里的参数写成「（无法序列化：原因）」。此前记这条调试日志就会抛错（与日志级别无关），整轮回复以错误结束。
- 在提交点之前被 latest-wins、手动停止或拆卸中止的回合，不再落库、不再外发。
- 上游返回空流时也按 persona 的要求重试。
- 会话配置的额外系统提示（`SessionConfig.systemPromptExtra`，WebUI 的「额外提示」）开始生效：agent 透传给 persona，追加在人设提示之后、结构化输出格式说明之前；未装 persona 时不生效。
- persona 不再搜索 `configDir:/personas`，只在 `personasDir`（默认 `data/personas`）查找人设卡。`personasDir` 的配置说明改正为 storage URI 口径（解析方式未变）：不含 `:/` 时首段视为存储根名，单段裸名归 `data` 根。scheduler 等合成回合按 sessionId 约定推断会话类型，只用于提示词、不回写消息；子任务会话（`<父会话 id>::<后缀>`）不推断。
- persona 的非主卡 `outputFormat` 改为按卡缓存：显示名相同的两张卡不再共用格式，热改非主卡的 `outputFormat` 后无需重启即生效。
- 结构化输出（persona `outputFormat`）落库时，assistant 消息的 metadata 带解码后的可见正文（`visibleContent`），只在它与落库内容不同时写入。memory-vector 建索引、扩窗与召回的渲染优先读它，memory-summary 的摘要输入同样优先读它，JSON 信封与状态字段不再进入摘要；升级前落库的消息没有这个键，仍按原文呈现。
- memory_recall 在 `crossSessionMode=user` 下与被动注入一致，对当前用户本人发言或被 @ 的命中乘 `search.userPriorityBoost`（此前工具路径不加权）；回合中止信号传给查询 embedding 与扩窗取数，回合中止时工具返回「回合已中止」，不记 warn。
- memory-vector 写入的向量带 embedding 提供者的 `modelId`，被动注入与 memory_recall 只召回与当前模型相同的向量：同维度换模型后，其它模型的向量不再混入检索。每个当前模型在一次运行中首次排除时记一条 warn，列出被排除向量的模型并写明处理办法（改回原模型、重新 embed，或 `/clear all -t vector` 清空向量库）。排除发生在取回候选之后、候选池不放大，其它模型的向量占多数时命中会变少。升级前写入的向量不带 `modelId`，升级后首次检索时记下当时的模型作为它们的模型（记忆元数据 namespace `memory-vector`、key `legacy-model`）；memory 服务不在或元数据读写出错时，本次按当前模型对待、下次检索再试，读写连续出错只记一次 warn。全局清空向量库时（`/clear all -t vector`，或不带类型的 `/clear all`）一并删除存量标记，之后的检索按当时的模型重新记下；只清消息历史不影响存量标记。提供者未声明 `modelId` 时不按模型过滤。
- memory-summary：`keepRecent` 大于 `threshold`、历史条数介于两者之间时，自动摘要不再每轮重复摘要同一批消息；与 `session:compress` 一致，历史不多于 `keepRecent` 时不摘要。`session:compress` 路径的日志文案改为「会话已压缩 / 会话已裁切（无摘要）」。
- user-profile：记忆后端读取档案或指令出错时，关系分更新、事实提取、自反思、指令提取以及 `/profile forget`、`/instruct add`、`/instruct remove` 放弃本次写入，这三条指令回复「添加失败」或「删除失败」及原因。此前读错按「无档案」处理，随后以空档案覆盖写回，一次瞬时读错即可清空整份档案或指令表。只读展示（提示注入、`user_profile_lookup`、`/profile`、`/instruct` 等）读失败仍按暂无档案处理。
- user-profile：事实提取、自反思与指令提取在 LLM 返回后，以重读的档案或指令表为基底合并写回。此前以调用 LLM 前读到的快照为基底：调用期间执行的 `/clear all`、`/profile clear`、`/profile clear nuke`、`/profile self clear`、`/instruct clear` 回执报成功，LLM 返回后清掉的事实、关系分、互动次数或指令被整份写回；`/profile forget` 删掉的事实也会原样复活；`/instruct remove` 删掉的指令随快照复活，`/instruct add` 手动添加的指令被整表覆盖丢掉。该次调用新提取出的事实与指令照常写入。

**迁移**：
- 自写 `agent:tool:before` / `agent:tool:after` 钩子的第三方：抛错现在只让当前工具失败（`agent:tool:before` 抛错等于拦截该工具），同批其它工具照常落定。
- 放在 `configDir:/personas` 的人设卡移到 `personasDir`。按旧说明把 `personasDir` 写成相对项目根路径的，改写为 storage URI（如 `data:/personas`），或把人设卡移到该值实际指向的存储根下。
- 要恢复 memory_recall 旧排序，把 `search.userPriorityBoost` 设为 1（同时影响被动注入）。
- memory-vector 升级后先用原 embedding 模型完成至少一次检索（一轮对话即可）再更换模型；升级时同时换模型，存量向量会被记成新模型、与新向量混在一起检索，需清空向量库。
- 升级前以 JSON 信封建索引的 assistant 向量不会自动更新；可停机后删除，由新消息重建。LanceDB 执行 ``table.delete(`metadata_json LIKE '%"role":"assistant"%' AND metadata_json LIKE '%"content":"{%'`)``。memory-vector、memory-summary 依赖 plugin-agent 写入的可见正文与 schema-message 的新导出，与这两个包同批升级。

### /clear 按层清理（@aalis/api-memory、@aalis/plugin-memory-sqlite、@aalis/plugin-memory-mongodb、@aalis/plugin-memory-inmemory、@aalis/plugin-memory-summary、@aalis/plugin-memory-vector、@aalis/plugin-todo-list、@aalis/plugin-adapter-onebot、@aalis/plugin-user-profile、@aalis/plugin-tool-search、@aalis/plugin-commands、@aalis/plugin-media）

- 记忆后端的 `clearAll` 只清消息与归档，不再连记忆元数据一起删除（sqlite 的 `metadata` 表、mongodb 的 `metadata` 集合、inmemory 的元数据）。此前 `/clear all -t context` 会连带删掉用户档案、第三方行为指令、关系图、摘要、待办、会话表与 maimai 绑定；现在各命名空间由归属插件在 `memory:clear` 中间件里按清理类型自行清理。
- `context` 类型管会话级短期上下文：除消息（含归档）与角色状态外，还清会话摘要（memory-summary）、已发现工具集（tool-search）与待办（todo-list）；全局清理时另清 OneBot 合并转发原文（adapter-onebot 的 `onebot:forward` 与各实例的内存缓存）。转发原文没有会话归属，会话级清理不动它，靠 7 天回收。`summary` 仍可单独选。会话级 `/clear -t context` 因此多清本会话的摘要与待办。
- 向量、用户档案与关系图属跨会话长期层，只在指定对应类型或不指定类型时清理。memory-vector 全局清空向量库时一并删除存量标记并复位缓存；user-profile 清档案时同时清第三方行为指令，不再看 `enableInstructions`。
- 任何类型都不清会话表（`sessions`）与 maimai 绑定（`maimai-binding`）：`/clear all` 不再删除会话名称、父子关系、会话级配置与好友码绑定。
- tool-search 只在清理类型为空或含 `context` 时重置已发现工具集，`/clear -t image` 这类无关清理不再重置。
- todo-list 经 `memory:clear` 清理待办（删除会话同样经这条钩子），不再监听 `session:deleted`；每个被清的会话发一次 `todo:updated`（`items` 为 `[]`）。todo-list 与 adapter-onebot 新增对 `hooks` 服务的可选依赖（`@aalis/api-hooks`）。
- `/clear list` 与 `/clear` 的帮助里 `context` 的说明注明含摘要与待办，示例 `--type context,summary` 改为 `--type context,vector`。
- 记忆后端没有实现 `clearAll` 时，`/clear all` 回报一条失败（记忆后端不支持全局清空，消息历史未清理），不再退化为只清当前会话并报成功。
- media 参与 `memory:clear`：图片描述（含动图）归入 `image` 类型，视频描述（`describeVideo` 的结果，合并转发里的视频和 image-sender 发出的视频走它）归入 `video` 类型，各按所选类型清理，不指定类型时两类都清。`/clear all` 清空所选类型的描述与来源别名：两类都清时删除快照 `data:/media/descriptions.json`，只清一类时重写快照、另一类保留。会话级 `/clear` 与删除会话只清带本会话语境的图片描述（开启 `contextHistory` 后带着会话语境识别出的，键里带会话目录；`senderContext` 单独开启不产生这类描述）；不带语境的描述与视频描述跨会话共享，会话级清理不删。回执多一行「所有图片与视频描述缓存已清空（N 条）」或「当前会话图片与视频描述缓存已清空（N 条）」，只选一类时只写那一类。启动时读快照失败的那次运行里，会话级清理只能清内存、回执报失败；`/clear all` 照样删除快照（只清一类时也整份删除），此后同一次运行不再报失败。视频描述的缓存键加了 `#video` 后缀，升级前缓存的视频描述不再命中，同一视频再出现时重新识别一次。

**迁移**：
- 把数据存在记忆元数据里、靠 `/clear all` 的 `clearAll` 顺带清掉的第三方插件，改为挂 `memory:clear` 中间件，按 `scope` 与 `types` 自行删除自己的命名空间。
- 第三方记忆后端的 `clearAll` 只清消息与归档，不清元数据。
- 插件未安装或未激活时，`/clear all` 不再清它留在记忆元数据里的数据（此前由 `clearAll` 一并删除）。

### 模型与媒体（@aalis/schema-config、@aalis/plugin-llm-openai、@aalis/plugin-llm-deepseek、@aalis/plugin-llm-ollama、@aalis/plugin-embedding-openai、@aalis/plugin-websearch-serper、@aalis/plugin-media、@aalis/plugin-asr-openai、@aalis/plugin-asr-whisper-cpp、@aalis/plugin-file-reader、@aalis/plugin-image-sender、@aalis/plugin-office）

- llm-openai、llm-deepseek 的 `modelCapabilities` 覆盖行改为按最后一个冒号切分，带冒号的模型 id（如经 Ollama `/v1` 接入的 `qwen3:8b`、`xxx:free`）的覆盖行开始生效。
- llm-openai 内置能力表补上 gpt-4.1、gpt-5（含 thinking）、qwen-vl / qwen2.5-vl / qwen3-vl、glm-4v / glm-4.1v / glm-4.5v 的 vision；llm-ollama 在 `/api/show` 探测失败时，名称带 vision / vl 的模型不再被家族前缀抢先匹配而丢掉 vision。这些模型因此进入 media 的视觉候选池，`vision.delivery=auto` 时也会直通原图。
- llm-openai、llm-ollama：启动时模型发现失败（不可达、超时、非 2xx）会记 warn 并带上 URL 与原因，包括 fetch 的底层原因如 `connect ECONNREFUSED`，仍照常注册 `customModels`；此前静默按空列表处理，不记原因。WebUI「刷新模型」遇到发现失败时返回错误并带原因，已注册的条目保留；此前按空列表处理，会注销全部自动发现的条目，界面还显示刷新成功。
- llm-deepseek：模型发现失败的告警带上底层原因（如 DNS 解析失败、拒绝连接），此前只显示 `fetch failed`。
- llm-openai、llm-ollama、llm-deepseek：启动时模型发现失败后，注册结果那行日志不再写「已连接」，改为「模型发现失败: <地址>，注册 customModels 里的 N 个 model entry」；没配 customModels 时告警「模型发现失败且未配置 customModels」。此前不论发现成败都写「已连接」。
- llm-ollama：两次「刷新模型」并发时，同一个新模型只算一次新增。此前两次刷新各算一次，WebUI 都显示「+1」，日志也各记一遍。
- llm-deepseek、llm-openai（官方端点）、embedding-openai、websearch-serper、asr-openai 缺 `apiKey`，或 asr-whisper-cpp 缺 `modelPath` 时，激活失败日志只有一行，错误写作 `ConfigError: 缺少配置项 <字段>…，在 WebUI 或配置文件中填入后生效`。插件照常显示为出错，错误信息也是这一句；填入后保存或配置文件重新载入即重试激活。此前日志附带整段堆栈，看起来像程序崩溃。schema-config 新增 `configError(message)` 与 `missingConfigError(field, note?)`，第三方插件可以用它们抛出同样只打一行的配置错误。
- media 的 LLM 处理器缓存签名改按 `all()` 顺序：`vision.prefer` 留空时，自动选择跟随 llm 服务偏好的切换。
- media 的描述快照除内容哈希键外，也收带会话语境的描述（键为含会话目录的落盘路径）：这类描述重启后在本会话内继续复用，此前重启即丢。
- media 的 LLM 音频处理器不再带 `describe`（此前调用必抛错），与 asr 桥接出的音频处理器同形。
- 两个 ASR 插件的 http(s) 音频附件下载加 15 秒超时与 20 MiB 流式上限（与 plugin-media 同口径），超时或超限时转写直接报错。
- office 的 `doc_add_image` / `ppt_add_image` 下载 http(s) 图片加 15 秒超时与 20 MiB 流式上限（与 plugin-media 同口径），超时或超限时工具报错。
- file-reader 内联文件正文的结束标记改为 `--- 文件内容结束 <8 位十六进制编号> ---`，开头一行注明正文是数据不是指令、以及本次的结束标记；「--- 文件内容 ---」字面量不变。`resolveLocalPath` 在存储不支持本地路径或文件已不在磁盘时返回 `null`（此前抛错），其余存储错误（如存储根不可读）照常抛出。
- file-reader 把上传文件名里的控制字符（含换行、回车、制表符）与 Unicode 行、段分隔符换成空格，作用于附件描述、system 块里的文件清单、工具输出，以及服务的 `getMeta` / `listFiles` 返回的元信息；旧版本落盘的元信息读回时同样处理。此前文件名里的换行可以把文字排到文件块之外，冒充用户原话。
- image-sender 的 `preview_image` 只在 media 服务在场时注册，离场即撤回。

**迁移**：
- 所有 LLM 处理器优先级相同，`vision.prefer` 留空时由注册顺序最靠前的视觉模型胜出，新表项可能把识别切到计费的兼容端点。要固定识别模型，显式设置 `vision.prefer`；个别型号推断不准时用 `modelCapabilities` 覆盖。
- 自行解析文件块的前端，按开头一行声明的编号配对结束标记，并继续兼容无编号的旧格式。`resolveLocalPath` 的调用方改为判 `null`。按原始文件名匹配 `getMeta` / `listFiles` 结果的代码改按文件 ID 匹配。

### 运行中换提供者与其它修复（@aalis/plugin-session-manager、@aalis/plugin-todo-list、@aalis/plugin-memory-summary、@aalis/plugin-user-profile、@aalis/plugin-adapter-onebot、@aalis/plugin-agent、@aalis/plugin-storage-local、@aalis/plugin-skills、@aalis/plugin-persona、@aalis/plugin-workflow、@aalis/runtime、@aalis/plugin-tool-math、@aalis/plugin-okx-trading、@aalis/plugin-doctor、@aalis/plugin-memory-sqlite、@aalis/plugin-memory-mongodb、@aalis/plugin-checkpoint、@aalis/core）

- session-manager 的会话表跟随 memory 胜者：运行中换后端后显示新后端的会话，换人前以及新表加载期间未落盘的变更写回旧后端。换后端即换库，不跨后端合并。
- session-manager 读取会话表失败时（如 MongoDB 连接抖动、sqlite 里某条会话元数据损坏）记 error，会话列表为空，这个后端上的会话改动不落盘。此前会以空表为准，之后被建档或改配置的会话在后端的原记录（名称、标题、父子关系、会话级模型与人设）会被空白记录覆盖。
- todo-list、memory-summary、user-profile 一次操作只绑定开头取到的 memory 实例：WebUI 切换 memory 偏好时，不再出现 A 被裁剪、摘要写进 B，或把 A 的整张事实表写进 B 的情况。todo-list 有 memory 时每次读当前胜者。
- memory-summary 在摘要生成途中遇到 `/clear`（不带类型，或带 `-t context` / `-t summary`）或删除会话时，丢弃这次结果：不写摘要、不裁切历史、不写「对话已压缩」分隔线，手动压缩报失败。此前摘要模型晚于清理返回时，被清掉的对话会以摘要重新注入提示词，还会多出一条分隔线。
- adapter-onebot 合并转发的媒体落盘与 agent 在没有 media 时读回落盘图片，改走 storage 网关按根路由：此前多根部署下写 `data:/` 会被胜者根（通常是 workspace）拒绝，转发里的图片退回会过期的原始 URL。
- adapter-onebot 展开合并转发时，嵌套转发段的 id、系统提示行里的转发 id 与节点发送者 id 也剥除 NUL：外部消息无法再经转发 id 伪造或搬运其它媒体的识别描述，发送者 id 里的 NUL 也不再带进行前缀与参与者名单。
- storage-local 关闭时关掉 `storage.watch` 建的监听器；skills 与 persona 的目录监听改为跟随 storage 提供者，提供者重启、改配置换目录或晚于 `app:ready` 上线时重挂监听并重新扫描。
- skills 与 persona 的目录重扫改为串行：同一时刻只跑一次，进行中再触发只排一次尾随重扫。persona 扫描期间新增的卡不再被并发的旧扫描剔除。skills 扫完后整体替换技能缓存，扫描期间读到的是上一版完整列表，扫描失败时保留上一版，不再出现并发扫描造成的虚假「重复 skill 名称」告警；任何一次重扫（含 `load_skill`、`list_skills` 的按需重扫）都会作废已编译的 triggers，改过的触发正则随之生效；扫描进行中经服务创建、更新、删除的技能与附属文件，不再被扫描收尾的整体替换盖掉（写入时排一次尾随重扫）。`SkillsService.rescan()` 在扫描进行中被调用时，等尾随那次重扫完成后返回。
- 技能目录本身列不出（storage 缺席、读错误，不是目录不存在）也算扫描失败：保留上一版技能并记 warn，`load_skill`、`list_skills`、`skill_rescan` 的按需重扫返回错误。此前按空目录处理，技能全部消失且没有日志。persona 同理：人设目录列不出时本次扫描失败并记 warn，已载入的卡不再被剔除。
- workflow 删除定义时，已写入文件的定义（启动时从文件载入的，或以默认的写入磁盘方式定义的）如果文件删不掉（所在根不可删、无权限、文件被占用），改为报错：`workflow_remove` 返回错误，WebUI 删除提示失败原因，定义、触发器与 once 记账都保留。此前只记 warn 仍回「已删除」并清掉 once 记账，文件留在盘上，下次启动定义被重新载入，runAt 已过的 once 会再触发一次。只在内存里的定义（`persist: false`）行为不变：storage 不在场或根不可删时照常删除。不存在的 id，`workflow_remove` 照旧回「不存在」，WebUI 删除改为提示「工作流不存在」，此前提示「操作失败」。skills 同理：技能目录删不掉时 `skill_delete` 与 WebUI 删除报错，技能留在列表里（此前回成功、技能从列表消失，重扫或重启后又出现）；附属文件删不掉时 `skill_remove_file` 报错，不再回「skill 不存在或文件不存在」。目标本就不存在时行为不变。
- runtime 冷启动时对 `plugins` 下找不到插件的单实例配置段逐段告警一次：「配置段 "<键>" 对应的插件未找到，已忽略；若已卸载可删除该段（其中可能含密钥）」。
- runtime 配置热重载以文件为准处理后缀实例：`name:suffix` 实例在配置文件里没有配置段时（手动删掉了，或拒写期间经 WebUI 新建、没写进文件），热重载时卸载该实例，与冷启动只登记文件里有配置段的后缀实例一致。此前热重载会把它的运行态配置换成 schema 默认值（没有默认值时为 `{}`），并把默认值作为新配置段写回文件。文件里新出现、所属模块已登记的后缀实例配置段随热重载登记，判据与冷启动、热扫描相同，首次激活即带 schema 默认值；此前热重载不理会新增的配置段，要重启或调用 WebUI 服务端的 `POST /api/plugins/scan` 才登记。外部编辑器分几次写入时，中途缺了配置段而被卸载的实例，随后续的完整写入重新登记；拒写期间经 WebUI 删除、配置段仍在文件里的实例，修好配置文件后随热重载重新登记。主实例不受影响。
- runtime 保存配置文件时，临时文件在创建时就沿用原文件的权限位，不再先以默认权限（通常 0644）建出再改权限；没有原文件时按 0600 创建，由保存首次创建的配置文件因此是 0600（此前按 umask，通常 0644）。写临时文件或改名失败时先删掉临时文件再报错，配置目录里不再留下含密钥的临时文件。
- tool-math 的 `math_calculus` 单次调用的求值总时长上限为 2 秒，超时返回「计算超时（超过 2 秒），请简化表达式」（integral 为「…请简化表达式或减小 n」）；integral 的分段数 `n` 最大 1000000，超出直接返回错误。此前昂贵的表达式配上大 `n` 或迭代求根会同步占住事件循环，长时间卡住整个进程。
- okx-trading 的 11 个分页查询工具返回给模型的条数与请求条数一致（未传 `limit` 用 `defaultPageLimit`，上限 `maxPageLimit`）；此前固定只展示前 20 条，其余标「已截断」。调大 `maxPageLimit` 会相应增加单次工具结果的体积。
- plugin-doctor 诊断报告里的 `plugins.pending` 逐个列出实例缺少的 required 服务（如 `@aalis/plugin-memory-vector: 缺少服务: embedding`，与 runtime 启动告警同一写法），每行一个；此前只列实例名，以逗号分隔。
- plugin-memory-sqlite：换了 Node 大版本后 better-sqlite3 原生模块加载失败（原始错误含 `NODE_MODULE_VERSION`）时，激活错误改为中文说明并给出两条出路：用装依赖时的 Node 启动，或在项目根执行 `npm rebuild better-sqlite3`（pnpm 工程用 `pnpm rebuild better-sqlite3`），末尾附原始错误首行。CPU 架构不符、缺系统库等其它原生加载失败报「better-sqlite3 原生模块无法加载：<原始错误>」，不给重编指引。原始错误都保留在 `cause` 里。
- memory-mongodb 连接失败、memory-sqlite 数据库路径解析失败时，抛出的错误以 `cause` 带上原始错误，error 日志在调用栈之后逐层多出 `[cause] <类名>: <消息>` 行（如 `[cause] MongoServerSelectionError: connect ECONNREFUSED …`）。消息文字不变。
- memory-sqlite 的 `path`、memory-mongodb 的 `database` 默认值改为留空，留空时按实例派生：主实例仍用 `data:/aalis.db` / `aalis`，带后缀的实例在文件名或库名上加后缀（如 `@aalis/plugin-memory-sqlite:b` 用 `data:/aalis-b.db`，`@aalis/plugin-memory-mongodb:b` 用 `aalis-b`）。此前新建后缀实例时，拿到的默认值与主实例相同，两者共写同一个库。现在两个实例解析到同一个库时，后激活的那个激活失败，报一行 `ConfigError`，点名占用这个库的实例。sqlite 按本地文件路径比较；mongodb 按连接串字面加库名比较，`metadata` 集合与消息集合同库，所以 `collection` 不同也算共用。配置文件里写明的值照用，主实例不受影响。
- checkpoint 列出回合或读取 manifest 失败时，除目标不存在外都记 warn（带 URI 与原因），如 storage 暂不可用、权限被拒或 manifest 损坏。同一 URI 同一原因只记第一次，读取恢复（或确认不存在）后再失败才再记；WebUI 每次消息变化都会列一次回合，storage 不在线时不会每条消息都记一条。此前这些情况不留日志，回合从列表里静默消失。
- core 的 `DefaultLogger` 渲染附加参数时不再抛错：JSON 序列化与转字符串都失败的对象（如带循环引用或 BigInt 字段的 null 原型对象）输出 `[object Object]`；渲染过程本身抛错（已撤销的 Proxy、`stack` getter 或 Proxy 陷阱抛错）或结果转不成字符串（如 `Error.stack` 被赋成 null 原型对象）的参数输出 `[无法渲染的参数]`，其余参数照常输出。此前这些参数会让日志调用本身抛错，在 catch 与拆卸路径里盖掉原本要记的错误。`toJSON` 返回 `undefined` 的对象，由输出空串改为输出 `undefined`。
- core 的 `DefaultLogger` 渲染错误参数时带出因果链：在 stack 之后沿 `cause` 逐层另起一行，每层以 `[cause] 名称: 消息` 开头，至多 5 层，循环引用与超出层数时末行写 `[循环引用]` / `[超过 5 层，其余省略]`；`AggregateError`（无论在最外层还是 cause 层）追加 `[errors] N 项` 并逐项另起一行、缩进两格列出，至多 10 条，其余写「…另 N 项」；多行消息原样续行。只有最外层带 stack，不展开错误对象的其它属性（如 `code`）；非 Error 的 cause 按附加参数规则渲染后取首行。例：`fetch` 连 localhost 被拒、localhost 解析出 IPv6 与 IPv4 两个地址时，`TypeError: fetch failed` 的 stack 之后列出 `[cause] AggregateError`、`[errors] 2 项` 与两条 `Error: connect ECONNREFUSED …`，此前只有 `TypeError: fetch failed` 与调用帧。
- core 的 `PluginEntry.error`（WebUI 插件页、plugin-doctor 与 agent 插件状态里显示的激活失败说明）在错误消息后接 cause 链摘要：各层取消息首行，以 ` ← ` 相连，如 `fetch failed ← connect ECONNREFUSED 127.0.0.1:11434`，层数上限与收尾写法同日志；`AggregateError` 层（无论在最外层还是 cause 层）之后以 `: ` 接其子错误的首行，以 `; ` 相连，至多 3 条，其余写「…另 N 项」，如上一条里 localhost 那个 `fetch` 例子，摘要为 `fetch failed ← AggregateError: connect ECONNREFUSED ::1:11434; connect ECONNREFUSED 127.0.0.1:11434`。包装错误常把 cause 的消息拼在自己的消息末尾：上一层首行以本层首行结尾，且两者相同或其间以 `:` / `：`（其后可有空白）分隔时，省略本层（plugin-memory-sqlite 的开库错误因此不变）；本层首行只出现在上一层中间，或紧接在其它文字之后（如 `Request failed with status 500` 的 cause `500`）时照常列出。消息为空的错误显示其名称，此前为空串。非 Error 的值（抛出值本身、cause 层与子错误）按日志附加参数规则渲染后只取首行，超过 200 字符截断并以「…」结尾，带字符串 `stack` 的对象因此只留 stack 首行；抛出值为普通对象时显示 JSON，此前为 `[object Object]`，多行字符串此前整段显示。日志照旧完整输出。`apply` 抛出 null 原型对象等转不成字符串的值时，插件此前停在 `activating` 并记一条「recompute(…) 报错」，现在转为 `error`。注册校验失败的日志原因用同一规则；定义的字段 getter 抛出这类值时，`register` 此前以拒绝结束，现在兑现 `false`。
- core 抛出的服务不可用错误与双副本错误带上名称 `ServiceUnavailableError` / `ForeignCoreError`，stack 首行与 `String(err)` 由 `Error: …` 变为 `<名称>: …`。
- core 的插件管理面 `app.plugins` 与 `DefaultLogger`、`LogHub` 的私有成员改为 `#` 私有字段：用 `Proxy` 包装这三类对象后调用其方法抛 `TypeError`，此前照常工作；经方括号读取私有成员得到 `undefined`（`DefaultLogger` / `LogHub` 上的 `logger['scope']` 这类写法 TypeScript 也不再放行），`Object.keys` 也不再列出这些成员。

**迁移**：
- 直接 `npm uninstall` 过插件的部署，按告警删除残留配置段。
- `startAalis`（或自行接了 `installConfigHotReload` 的宿主）下，插件或宿主代码里以 `name:suffix` 登记、配置文件里没有配置段的实例，会在任何一次配置热重载时被卸载；要保留的，先经 host-config 写入配置段并 `save()`，再登记。自行接 `installConfigHotReload` / `handleConfigChanged` 的宿主，在 `store` 之后传入发现驱动（`createPluginDiscovery(...)` 的返回值，或自备 `registerConfiguredInstances()` 的对象），文件里新加的后缀实例随热重载登记。
- 依赖 `math_calculus` 更大积分分段数的，改用 1000000 以内的偶数，或简化表达式。
- memory-sqlite、memory-mongodb 已有的后缀实例，如果配置里写着与主实例相同的 `path` / `database`（此前经 WebUI 新建实例或配置同步都会写入默认值），升级后会激活失败：清空该字段即按实例派生一个新库（原库的数据仍归主实例），或另配一个位置。
- 按全文比对 `PluginEntry.error` 的代码，改为按前缀或正则匹配：带 cause 的错误后面多了 ` ← …` 摘要，AggregateError 后面多了 `: 子错误…`。按 `Error: 服务 "…" 不可用` 匹配日志或工具输出的，改为匹配 `ServiceUnavailableError:` 或消息本身。
- 用 `Proxy` 包装 `app.plugins`、`DefaultLogger` 或 `LogHub` 的，改为另写对象把调用转发给原对象（管理面按 `PluginManagerService` 接口、日志器按 `Logger` 接口实现）。

### 慢激活不再挡住启动，激活可取消（@aalis/core、@aalis/runtime、@aalis/schema-config、@aalis/plugin-doctor、@aalis/plugin-webui-server、@aalis/plugin-webui-client、@aalis/plugin-adapter-onebot、@aalis/plugin-cron-engine、@aalis/plugin-embedding-ollama、@aalis/plugin-embedding-openai、@aalis/plugin-llm-ollama、@aalis/plugin-llm-openai、@aalis/plugin-llm-deepseek、@aalis/plugin-mcp-client、@aalis/plugin-mcp-server、@aalis/plugin-memory-mongodb）

- 新增 `AppOptions.slowThresholdMs`（慢操作阈值，默认 60000，0 表示不设限）。插件激活超过它仍未完成时记一条 warn 点名，转入后台继续，其余插件照常激活，`register` / `pluginAll` / `plugins.idle()` 在阈值处返回，启动流程不再卡在插件登记，此后每隔同样时长提醒一次「仍在激活」。此前一个不返回的 `apply` 会让启动、`idle()` 与 `stop()` 一直等下去。
- 后台期间条目停在 `activating`，`getStatus()` 给出 `slow: true`（`PluginStatusEntry.slow`）。它经 `provide` 登记的服务不对外：`services.get` / `all` / `inspect` / `names` 与激活闸都看不到，阈值前已登记的在转入后台时撤下（发 `service:unregistered`），依赖它的插件保持 `pending`。它落定后：成功则转 `active` 并上线服务（发 `service:registered`），依赖方随之激活；失败进 `error`；都另触发一次重算。它的事件监听与经 `registrar` 登记到别处的条目（工具、指令、页面等）照常生效，`app:ready` / `app:started` 监听器可能在它的 `apply` 完成之前被调用。
- `app:*` 屏障事件（启动、停机、重启）的单个监听器超过 `slowThresholdMs` 仍未返回时记 warn 点名登记者，不再等它；它之后的拒绝照常按监听器抛错上报。
- 删除 `LifecycleCap.closed`，新增 `lifecycle.signal`（`AbortSignal`，reason 为 name 是 `AbortError` 的 `DOMException`）。`apply` 尚未完成时被停机或停用、卸载、重启接手，或后台激活因 required 依赖下线被拆，关闭计划冻结后立即 abort；其余在本激活的收尾段开始时（`onDrain` 之前）abort，依赖方先关闭时提供者的 `signal` 仍未断。abort 监听器同步执行，不得抛错：Node 宿主把监听器的异常当成未捕获异常，runtime 会因此退出进程。
- 停用、卸载、重启或停机撞上仍在初始化的插件，或后台激活的 required 依赖下线：先 abort，自它的收尾段开始最多再等 `disposeTimeoutMs`；到期仍未落定记 error「未在宽限内停止」、不再等待，流程继续。停用与重启的主体、管理动作同批的下游、依赖下线被拆的后台激活改为 `error`（`apply` 仍在跑，不再起新实例：重启因此不会重新激活，依赖恢复后也不自动重试，需 `enable` / `bounce`），卸载与停机只记日志。`slowThresholdMs` 与 `disposeTimeoutMs` 都非 0 时 `stop()` 总能结束。此前在飞激活超过宽限时静默转成目标态。
- 管理动作的同批拆卸扩到仍在初始化（在飞或后台）的 required 下游：提供者被停用、卸载、重启时这些下游先被 abort、先关，再按新实例重新激活，不再带着旧实例转 `active`。后台激活的 required 依赖下线时同样拆掉：宽限内落定的回到 `pending`，依赖恢复后重新激活；不响应 abort、超过宽限的转 `error`，依赖恢复后不自动重试（见上条）。
- 提供者被停用、卸载、重启时（含仍在初始化的），依赖它所提供服务、仍在 `pending` 的插件不再在它关闭期间激活：重算跳过 required 服务的当前提供者已开始关闭的条目，等提供者关完再判定，停用后保持 `pending`，重启后随新实例激活。此前有两种情形会让依赖方激活到正在关闭的实例上：先登记服务、再完成初始化的插件在初始化中被接手；已激活的提供者在 `onDrain` 里收尾时，重算恰好走到排在后面的依赖方（例如另一个插件的初始化刚结束）。初始化因此失败的依赖方停在 `error`、不自动重试，未失败的在服务撤下后被拆回 `pending`。
- `plugin:unloaded` 只发给发过 `plugin:loaded` 的激活：仍在初始化（在飞或后台）时被停用、卸载、重启，或随提供者同批拆下的，都不发；重启在途时再卸载同一插件也只发一次。此前在飞激活被管理动作拆下时也会发，按 loaded / unloaded 配对计数的监听器会失衡。
- `services.names()` 只列当前有对外提供者的服务名，与 `get` / `inspect` 一致。
- `disposeTimeoutMs` 与 `slowThresholdMs` 超过 2³¹−1（定时器的最大延迟）时按 2³¹−1 计；此前 `disposeTimeoutMs: Infinity` 会被运行时当成 1ms，清理几乎立刻被放弃等待。
- 清理项（`onDrain` / `onDispose` 等）超过 `disposeTimeoutMs` 被放弃等待后才拒绝的，拒绝原因照样记 warn「DisposableChain: dispose 抛出，已忽略 [<label>]」，不再静默丢弃。
- runtime 读配置文件顶层的 `slowThresholdMs` 注入 core（重启生效）；留空（YAML 空键）与没写一样按默认处理，不告警；不是非负有限数时记一条告警，照原样显示收到的值（如 `.inf` 显示为 `Infinity`），按默认值处理。`CORE_CONFIG_SCHEMA` 增加该键（默认 60000，最小 0），WebUI 设置页可改，保存后自动重启。`PUT /api/config` 对文档里没写的核心键按 schema 默认值比较：前端把默认值回填进草稿后回传不算改动，不写进文件、不触发重启。
- plugin-doctor 新增 `plugins.slow` 检查：列出激活超过阈值、仍在后台进行的实例（warn）；`plugins.errored` 的文案改为「N 个插件处于 error（激活失败或未在宽限内停止）」。
- runtime 启动收敛后的 pending 告警与 doctor 的 `plugins.pending`：缺的服务由仍在激活中（含已转入后台）的插件声明提供时，报「等待 <实例> 激活完成」，不再报成缺少服务。
- plugin-webui-server 的插件列表透传 `slow`；插件卡片显示「激活中」，已转入后台的显示「激活中（超过阈值）」；仪表盘另列「激活中插件」计数（含已转入后台的），此前只统计运行中与出错。停用路由遇到插件未在宽限内停止、转为 `error` 时返回 500 并说明实际状态，不再回报「已禁用」，配置文件照样记为禁用。
- adapter-onebot 与 cron-engine 的「已关闭就不再重连 / 排定时器」判断改读 `lifecycle.signal.aborted`，从本激活收尾段开始生效（此前从关闭计划冻结起）；两者的清理段照常清掉定时器与连接。
- 第一方插件 `apply` 里等待网络或子进程的步骤改为响应 `lifecycle.signal`，停用、重启或停机时在宽限内落定，不再因「未在宽限内停止」转 `error`。涉及 embedding-ollama 与 embedding-openai 的启动连通性检查，llm-ollama（`/api/tags` 与 `/api/show`）、llm-openai、llm-deepseek 的模型发现，mcp-client 各 server 的握手与列工具（握手中止时子进程随之关闭），memory-mongodb 的连接与建索引（中止时关闭客户端）。中止后 `apply` 不再往下走，不发布服务，也不记探测失败。llm-ollama 与 llm-openai 由 WebUI 触发的模型刷新同样随停用或停机中止并报错，不再等满请求超时后往已关闭的激活上登记条目。mcp-client 的 `@modelcontextprotocol/sdk` 下限抬到已验证的 1.29.0（中止握手用到 `Client.connect` 的第二参数）；导出的 `bridgeClientToTools` 新增可选的第四参数 `signal`。mcp-server 的 `@modelcontextprotocol/sdk` 下限同样从 ^1.0.4 抬到 1.29.0，与 mcp-client 一致。

**迁移**：
- `if (lifecycle.closed)` 改为 `if (lifecycle.signal.aborted)`。时机不同：`closed` 在关闭计划冻结时即为 true；`signal` 在本激活收尾段开始时 abort，`apply` 尚未完成的在冻结后立即 abort。依赖「冻结即真」的（例如想在依赖方收尾期间就停止提供），改为在自己的收尾段处理。
- 插件作者：不要在 `apply` 里做长时间下载或等待外部服务就绪。长任务在 `apply` 里发起、不等，或推迟到首次使用；用 `lifecycle.signal` 取消（`fetch(url, { signal })`、`signal.addEventListener('abort', …)`、循环里查 `signal.aborted`）。不接 `signal` 的慢 `apply` 在后台期间遇到停用、重启或 required 依赖下线，宽限后停在 `error`，依赖恢复后也要手动 `enable`。
- 插件作者：不要在 `apply`、`onDrain`、`onDispose` 里 await 针对自身或自身 required 提供者的 `bounce` / `updateConfig` / `disable` / `unload`。拆卸要等这些回调返回，两边互等到 `disposeTimeoutMs` 才解开；在 `apply` 里这样等的插件随后因「未在宽限内停止」转 `error`。0.17 下在 `apply` 里重启自己的 required 提供者，会经一次重试成功。
- 需要旧行为（无限等待激活与屏障监听器）的宿主传 `slowThresholdMs: 0`；配置文件里写 `slowThresholdMs: 0`。
- 读 `PluginStatusEntry` 的工具：`activating` 现在可能持续很久，按 `slow` 区分。依赖某插件服务的插件在它后台激活期间保持 `pending`，runtime 启动告警与 doctor 的 `plugins.pending` 把这类缺口报成「等待 <实例> 激活完成」。
- 测试用 `vi.useFakeTimers()` 的：激活落定前挂着一个阈值定时器，`vi.getTimerCount()` 会把它算进去，`vi.runAllTimers()` 撞上不落定的激活会在提醒定时器上空转。先 `await app.plugins.idle()` 再装假定时器，或用 `vi.runOnlyPendingTimers()`。
- runtime 的重启策略等新实例报就绪（默认 30 秒）才判定接管成功，报就绪在启动完成之后。`slowThresholdMs` 设得比 30 秒短时，新实例会带着仍在后台激活的插件报就绪，更新失败的回滚不再兜住卡住的激活；需要这层兜底就别把阈值调到 30 秒以下。

### 包入口收紧（@aalis/core）

- `package.json` 新增 `exports`，只开放包根 `@aalis/core` 与 `@aalis/core/package.json`。`@aalis/core/dist/…` 等深路径导入在 Node 下报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，TypeScript（`moduleResolution` 为 `bundler` / `node16` / `nodenext`）报找不到模块。`main` 与 `types` 保留，`moduleResolution: node` 的旧工程照常解析包根。
- 包根新增类型导出 `OptionalUse`（`optional()` 的返回类型）、`FollowCleanup`（`follow` 回调的返回类型）、`PluginRegistration`（`app.pluginAll` 的条目类型）。三者此前只在内部模块导出，插件开 `declaration` 构建时，推断类型写成 `import("@aalis/core/dist/…")` 深路径；现在写成 `import("@aalis/core").X`。
- 发布包附带 `src/`：`dist` 里的 source map 与 declaration map 指向的源码随包在场，调试器与编辑器的「转到定义」能跳到 TypeScript 源码。安装体积约增加 200 KB。

**迁移**：从 `@aalis/core/dist/…` 深路径导入的，改为从包根 `@aalis/core` 导入；包根没有导出的内部模块不再能导入。用 `Parameters<App['pluginAll']>[0][number]` 推导条目类型的，可以改用 `PluginRegistration`。按 `@aalis/core/package.json` 读版本号的照常可用。用了 `optional()` 且开 `declaration` 的插件要在 core 0.18.0 下重新构建：旧产物 `.d.ts` 里的深路径在 `exports` 下解析不到。

### 包清单元数据（41 个包）

各包 `package.json` 里的 `aalis.types`、`aalis.util`、`aalis.core`、`aalis.tooling` 已移除，当前框架不读取它们（加载器与市场早已只看 keywords）。`aalis.service` 与 `aalis.client` 不变。

**迁移**：外部脚本若靠这些字段识别包类型，改看 `keywords`：契约包 `aalis-api`，schema 包 `aalis-schema`，工具库 `aalis-util`，内核 `aalis-core`，宿主 `@aalis/runtime` 为 `aalis-runtime`。脚手架 `create-aalis` 与 `create-aalis-plugin` 没有对应的类型关键词，按包名识别。

### 版本与必须同批升级的包

本批共 103 个包：88 个 minor、6 个 patch、9 个新包。所有随本批发布、带 core peer 的包，peer 下限统一为 `>=0.18.0 <1.0.0`（schema-message 的 core peer 只为类型声明，仍为 `>=0.2.0`）；包间依赖的下限抬到本批的新版本。api-code-sandbox、plugin-code-sandbox-os、plugin-maimai、plugin-process-local、plugin-tool-code-runner 本批无改动，沿用已发布版本。

- 基础（minor）：core 0.18.0、runtime 0.14.0、schema-config 0.13.0、schema-log 0.2.0、schema-message 0.9.0
- 契约包（minor）：api-agent 0.9.0、api-asr 0.11.0、api-authority 0.10.0、api-commands 0.7.0、api-cron-engine 0.7.0、api-doctor 0.7.0、api-embedding 0.7.0、api-flow-control 0.7.0、api-gateway 0.7.0、api-llm 0.12.0、api-media 0.11.0、api-memory 0.7.0、api-message-archive 0.7.0、api-persona 0.8.0、api-platform 0.8.0、api-process 0.8.0、api-session-confirm 0.7.0、api-session-manager 0.10.0、api-storage 0.7.0、api-tools 0.10.0、api-vectorstore 0.7.0、api-webui 0.11.0、api-workflow 0.11.0
- 插件（minor）：plugin-adapter-onebot 0.14.0、plugin-agent 0.15.0、plugin-asr-openai 0.11.0、plugin-asr-whisper-cpp 0.11.0、plugin-authority 0.13.0、plugin-checkpoint 0.13.0、plugin-cli 0.12.0、plugin-commands 0.12.0、plugin-cron-engine 0.8.0、plugin-doctor 0.7.0、plugin-draw 0.3.0、plugin-embedding-ollama 0.11.0、plugin-embedding-openai 0.12.0、plugin-file-reader 0.13.0、plugin-flow-control 0.11.0、plugin-gateway 0.7.0、plugin-image-sender 0.7.0、plugin-llm-deepseek 0.13.0、plugin-llm-ollama 0.11.0、plugin-llm-openai 0.13.0、plugin-mcp-client 0.12.0、plugin-mcp-server 0.12.0、plugin-media 0.15.0、plugin-memory-history 0.12.0、plugin-memory-inmemory 0.11.0、plugin-memory-mongodb 0.11.0、plugin-memory-sqlite 0.11.0、plugin-memory-summary 0.12.0、plugin-memory-vector 0.13.0、plugin-message-archive 0.12.0、plugin-office 0.11.0、plugin-okx-trading 0.11.0、plugin-package-manager 0.7.0、plugin-persona 0.11.0、plugin-prompt-budget 0.7.0、plugin-scheduler 0.13.0、plugin-session-confirm 0.7.0、plugin-session-manager 0.13.0、plugin-skills 0.12.0、plugin-storage-local 0.12.0、plugin-subtask 0.13.0、plugin-todo-list 0.11.0、plugin-tool-browser 0.12.0、plugin-tool-math 0.11.0、plugin-tool-onebot 0.11.0、plugin-tool-search 0.11.0、plugin-tool-session 0.13.0、plugin-tool-system 0.12.0、plugin-tools 0.9.0、plugin-trigger-policy 0.13.0、plugin-user-profile 0.13.0、plugin-user-relation 0.14.0、plugin-vectorstore-flat 0.12.0、plugin-vectorstore-lancedb 0.12.0、plugin-websearch-serper 0.11.0、plugin-webui-server 0.13.0、plugin-workflow 0.14.0
- 脚手架与前端（minor）：create-aalis 0.6.0、create-aalis-plugin 0.11.0、plugin-webui-client 0.13.0
- 工具库（patch）：util-bounded-map 0.6.1、util-cron 0.1.3、util-dep-spec 0.1.1、util-json-repair 0.5.4、util-network-guard 0.6.2、util-text-normalize 0.5.2
- 新包（0.1.0）：api-contributions、api-hooks、api-host-config、api-package-manager、api-plugin-source、api-session-history（原 api-tool-session）、api-user-relation、plugin-contributions、plugin-hooks

已有项目在项目目录执行下面这条命令，一次把 package.json 里的全部 `@aalis` 包升到最新，并装上两个新插件：

```sh
npm i $(node -p "Object.keys(require('./package.json').dependencies).filter(n => n.startsWith('@aalis/')).map(n => n + '@latest').join(' ')") @aalis/plugin-hooks@latest @aalis/plugin-contributions@latest
```

下列约束无法完全用依赖范围表达，混装会出错：

- `@aalis/core` 与 `@aalis/runtime` 同批升级。旧 runtime 以具名 ESM 导入 core 已删除的 `pluginDefinitionOf`，进程启动时即在模块链接阶段失败；新 runtime 配旧 core 时调用不存在的 `app.pluginAll`，以 TypeError 失败。
- 所有以具名 ESM 从 core 导入 `hooks` / `contributions` / `hostConfig` 的插件须同批升级，并装上 `@aalis/plugin-hooks` 与 `@aalis/plugin-contributions`（见上文钩子一节）。
- `@aalis/api-tools` 删除了 `asToolExecutionResult`，而已发布的 plugin-agent 0.14.0、plugin-mcp-server 0.11.0、plugin-workflow 0.13.0 在运行时导入它，且依赖范围接受新版 api-tools：只升级 api-tools（包括被其它包的依赖带上来）会让这三个插件在模块链接阶段加载失败。三者须与 api-tools 同批升级。第三方直接导入 `asToolExecutionResult` 的改为读 `.content`。
- plugin-webui-server 与 plugin-package-manager 同批升级：新版 webui-server 调用 `serviceDependents` 与 `registry`，配旧 package-manager 时市场依赖图接口返回 500，卸载时也没有服务依赖者闸；市场卡片不显示最新版与可更新，并提示无法确定安装源。市场的「更新所选」允许只更新其中一个包，请同时勾选两者。
- plugin-webui-client 与 plugin-mcp-client、plugin-file-reader 同批升级：旧前端把 `list` 字段退回字符串输入框，一编辑就把数组写坏；也剥不掉新格式的文件块。
- plugin-adapter-onebot 无条件调用 `rememberDescriptionAlias`：装有 plugin-media 时须为 0.13.1 及以上，否则调用失败被附件缓存吞掉（只有 debug 日志「OneBot 附件缓存异常」），入站附件丢掉落盘 ref。
- plugin-memory-vector、plugin-memory-summary 与 plugin-agent、schema-message 同批升级（见 agent 一节）；plugin-user-relation 与 embedding 提供者同批升级后触发一次向量重算（见关系图一节）。
- plugin-mcp-client 旧版在 `mcp_set_server_enabled` 里调用已删除的 `appService.saveConfig()`，配新 core 时该工具以 TypeError 失败。
- plugin-cron-engine 与 plugin-adapter-onebot 旧版读已删除的 `lifecycle.closed`（配新 core 恒为 `undefined`）：卸载后仍被握着的 cron-engine 服务引用再 `subscribe` 会建出没人清的定时器，onebot 关闭期间断线会照常排重连。两者与 core 同批升级。

混装的三类报错：

- 模块链接失败：`does not provide an export named ...`。旧插件导入 core 已删除的导出、旧版 agent / mcp-server / workflow 导入 `asToolExecutionResult` 时，日志为「加载插件 "X" 失败」，该插件不加载；旧 runtime 导入 `pluginDefinitionOf` 时进程启动即退出。
- 运行时 TypeError：新 runtime 配旧 core 调 `pluginAll`、旧 mcp-client 调 `saveConfig`、新 webui-server 调旧 package-manager 的 `serviceDependents`。
- 类型层增广落空：仍向 `'@aalis/core'` 增广 `HookContextMap` / `ContributionPointMap` / `AalisConfig` 的包，增广本身不报错（在源码或发布的 .d.ts 里都一样），但对新契约包不生效。以这些键调用 `hooks.middleware` / `hooks.run` / `contributions.contribute` / `contributions.collect` 时类型检查报错（TS2345，键不在可选范围内）；`hostConfig.get` 取这些配置字段得到 `unknown`，按原类型使用时才报错。

下列混装不报错，只是 `/clear` 的清理结果与「/clear 按层清理」一节不同：

- 新插件配旧记忆后端（升级前的 plugin-memory-sqlite / plugin-memory-mongodb / plugin-memory-inmemory）：`/clear all -t context` 仍由旧后端连记忆元数据一起删除，用户档案、第三方行为指令、关系图、会话表与 maimai 绑定照旧被连带删掉；memory-vector 的存量标记也随之删除，之后的检索按当时的模型重记。
- 新记忆后端配旧插件：`/clear all` 不清旧 adapter-onebot 的合并转发原文与旧 todo-list 的待办；`/clear all -t context` 不清旧 memory-summary 的摘要；旧 user-profile 关闭 `enableInstructions` 时不清第三方行为指令。

---

## 2026-09-25（core 0.17.0 minor；89 包同批升级，另有 create-aalis 0.5.7 / create-aalis-plugin 0.10.0 / plugin-webui-client 0.12.6 / 新包 schema-log 0.1.0）

### 服务统一（@aalis/core）

- 八项默认基础服务与第三方服务共用同一容器、描述符与绑定路径，删除 builtin 品牌和装配分路。所有 `uses` 按 required / optional 归类并参与同一激活规则；基础服务在加载插件前已登记，仍须显式声明使用。
- 八项基础服务由根激活经 `provide` 独占登记，与第三方服务同一种登记（校验、`service:registered` 通知、独占、归属），只有 `provide` 自身直接登记一次来自举；宿主三项 `app` / `plugins` / `host-config` 同样由根激活独占登记。基础服务在容器里的提供者是「激活身份 → 这次激活的接口」，只认在 `uses` 里声明了该服务的激活：经 `services.get` 动态查到的是提供者函数，以未声明者的身份调用即抛错。
- `BindingPort` 新增 `identity`：这次激活的不透明资源身份。它是凭据，交给谁，谁就能以这次激活的名义调用认它的提供者；提供者据它把登记归到这次激活，第三方契约包也可据此提供按调用方区分的服务。
- 经 `events.on` / `hooks.middleware` / `contributions.contribute` / `provide` 的登记不再逐条记进激活的清理链：返回的退订就是原语自己的撤回（同步、幂等，只撤自己那一条）；激活关闭时先按归属同栈整体切断这些登记，同一拍撤掉经 `registrar` 登记到枢纽服务的条目（不等下游交接），再排空清理链（`follow` 清理、`track` 与 `onDispose`）。
- `services.get/all` 返回登记进容器的对象本身；新增 `services.inspect`，只读登记元数据（`contextId` / `priority` / `label` / `exclusive`，不含实例）。WebUI 服务页使用 inspect，展示基础服务。
- `provide(..., { exclusive: true })` 是通用独占登记策略；Core 基础服务也使用它防止同名第二提供者。该策略不等于永久驻留，退订后可重新登记。
- 内部目录调整为 `kernel` / `primitives` / `infrastructure` / `composition` / `orchestration`，描述符与绑定状态机分文件。深路径不属于公开 API，导入统一走 `@aalis/core`。

**迁移**：管理页只枚举登记时改用 `inspect`。经 `services.get/all` 动态查到的基础服务是提供者函数而不是接口，宿主要用基础服务经 `app.bind` 声明。动态查询的完整边界见 [服务文档](docs/core/service.md)。

### 收回内部对象、删除死接口（@aalis/core）

- `AppOptions` 不再接受注入 events / services / hooks / contributions 注册表，`config` 只接受快照。包根不再导出 `EventBus` / `HookRegistry` / `ServiceContainer` / `ContributionRegistry` / `PluginManager`；`App` 上的四个注册表字段收回，`app.plugins` 的类型是 `PluginManagerService`。
- 删除 `PluginDefinition.core`（「核心插件不能被禁用」）、`PluginManager.isShuttingDown` / `softReload`、`ConfigManager.reloadFrom`、`BindingPort.closed`（无使用方；插件判断本次激活是否已关闭用 `lifecycle.closed`），以及 `bounce` 对 `module` 选项的拒绝分支。

**迁移**：宿主查询服务经 `app.bind({ services })`；要禁止某插件被禁用的宿主在管理面自行拦截。

### 宿主三服务只交出契约方法（@aalis/core）

- `app` / `plugins` / `host-config` 在容器里只放契约列出的方法：App / PluginManager / ConfigManager 本体不再外露。`hostConfig` 描述符的类型改为 `HostConfig`（`get` / `getAll` / `set`、插件配置读写与启停、服务偏好），不含 `watch` / `unwatch` / `save`；经 `pluginsService` 拿到的 `getPlugin()` 返回不含内部激活记录的快照。

**迁移**：把 `ConfigManager` 类型标注改为 `HostConfig`；`hostConfig.require().save()` 改为 `appService` 的 `saveConfig()`。

### 完整服务声明展示与内部精简

- `PluginStatusEntry.uses` 返回全部显式声明的快照，保留参数别名、服务名及必需/可选类别；`requiredServices` / `optionalServices` 包含 Core 基础服务，不再有独立 builtin 类别。
- WebUI 插件详情显示上述全部声明，无配置项的插件也可展开。工具/命令的敏感标签仍单独展示；通过 `services` 动态查询的服务不属于静态声明清单。
- Core 移除仅用于白盒测试的 Host 映射和读取入口，测试观察移入测试夹具；移除生命周期中已由完成对象覆盖的重复状态。发布校验按职责归入 `composition/provide-validation.ts`。

### 清理宿主契约与初始化恢复

- 初始化期间本次 required 绑定的 `require()` 原样抛出服务不可用错误时，撤回该次资源后回到 `pending`，依赖已恢复时也不会漏掉重新激活。optional、普通业务异常、伪造/包装错误和其他激活的错误仍进入 `error`。自动尝试在同一次重算任务内按插件限额，持续失稳会点名暂缓；不会通过排队的服务通知反复重置限额。

- 新增 `@aalis/schema-log` 0.1.0，统一 `formatLogLine` / `parseLogLine`（从 Core 移除，runtime、CLI、WebUI 改从 schema 包导入）。日志记录类型 `LogEntry` / `LogLevel` 与日志通道、Logger 留在 Core；schema-log 以 peer 依赖引用 Core 的类型，Core 保持零依赖。发布时须包含新包。
- 新写日志采用 `@aalis/log:1 ` 前缀的单行 JSON，完整保留反斜杠、换行与分隔符；读取兼容旧分隔格式，支持同一文件内混合记录。旧文件中已经丢失的转义信息无法恢复。
- 删除未被生产代码使用的 `AppOptions.dataDir`、`ConfigManagerOptions.dataDir`、`ConfigManager.getConfigDir()` 与 `createFsYamlConfigProvider()` 返回值的 `dataDir`；宿主文件监听仍使用自己的实际目录。
- `onDrain` 负责业务交接，不能等待同一关停计划中排在它之后的阶段（会互等）；外部调用者仍可等待完整关闭。本次未增加超时。

### 本批收敛

- Core 删除旧 `Context` 类及中转门面：基础服务的提供者按调用方激活身份连接原语注册表，`Activation` 只保存身份、资源和依赖关系，装配与基础服务的登记由 `ActivationHost` 承担。服务观察只报告胜者变化，异步交接统一在绑定与资源层处理。
- `App.stop()` 在屏障与清理期间被再次调用，也返回同一个完整关闭 Promise；不再用全局事件阶段判断调用者、提前兑现外部调用。监听器或清理回调不能 await / 返回自己的停机 Promise。本批不新增 `apply` / 屏障超时，既有 `disposeTimeoutMs` 不构成全局停机时限。
- `registrar` 同键登记在同步重入、撤回与关闭交错时仍按条目身份归属，过期登记取得的清理句柄会撤回，不留卸载后仍可执行的条目；关闭等待已发起的异步撤回。
- runtime 在加载定义后、首次交给 Core 注册前完成默认值回填与未知字段裁剪，主实例与配置中的复用实例共用此路径，避免首次 `apply` 配置与保存配置不一致。schema 政策留在宿主。
- Agent 缺少 message-archive 时，首次实际写入告警、每次激活最多一次；对话继续，服务恢复后后续消息恢复归档，不补写缺席期间的消息。minimal 模板包含归档插件；归档职责不进入 Core。

### 版本与必须同批升级的包

**升级**：core 0.17.0 把插件入口从公开激活记录改成定义对象与按激活绑定的能力。旧版插件（具名 `export const name` / `inject` / `provides`、`export default function`、`apply(ctx, config)`）配新 runtime **不会被加载**——`pluginDefinitionOf` 记 warn 后跳过；新插件配旧 core 没有 `definePlugin`。契约包删除全部 `useXxxService(ctx)` helper，描述符改为运行时值导出。下列 **89** 个包必须同批升级（自身即 core，或 core peer 已抬到 `>=0.17.0 <1.0.0`）：

- `@aalis/core` 0.17.0
- 25 个 `@aalis/api-*`（均 minor）：agent 0.8.0 / asr 0.10.0 / authority 0.9.0 / code-sandbox 0.6.0 / commands 0.6.0 / cron-engine 0.6.0 / doctor 0.6.0 / embedding 0.6.0 / flow-control 0.6.0 / gateway 0.6.0 / llm 0.11.0 / media 0.10.0 / memory 0.6.0 / message-archive 0.6.0 / persona 0.7.0 / platform 0.7.0 / process 0.7.0 / session-confirm 0.6.0 / session-manager 0.9.0 / storage 0.6.0 / tool-session 0.6.0 / tools 0.9.0 / vectorstore 0.6.0 / webui 0.10.0 / workflow 0.10.0
- 61 个第一方插件（均 minor）：adapter-onebot 0.13.0 / agent 0.14.0 / asr-openai 0.10.0 / asr-whisper-cpp 0.10.0 / authority 0.12.0 / checkpoint 0.12.0 / cli 0.11.0 / code-sandbox-os 0.6.0 / commands 0.11.0 / cron-engine 0.7.0 / doctor 0.6.0 / draw 0.2.0 / embedding-ollama 0.10.0 / embedding-openai 0.11.0 / file-reader 0.12.0 / flow-control 0.10.0 / gateway 0.6.0 / image-sender 0.6.0 / llm-deepseek 0.12.0 / llm-ollama 0.10.0 / llm-openai 0.12.0 / maimai 0.10.0 / mcp-client 0.11.0 / mcp-server 0.11.0 / media 0.14.0 / memory-history 0.11.0 / memory-inmemory 0.10.0 / memory-mongodb 0.10.0 / memory-sqlite 0.10.0 / memory-summary 0.11.0 / memory-vector 0.12.0 / message-archive 0.11.0 / office 0.10.0 / okx-trading 0.10.0 / package-manager 0.6.0 / persona 0.10.0 / process-local 0.7.0 / prompt-budget 0.6.0 / scheduler 0.12.0 / session-confirm 0.6.0 / session-manager 0.12.0 / skills 0.11.0 / storage-local 0.11.0 / subtask 0.12.0 / todo-list 0.10.0 / tool-browser 0.11.0 / tool-code-runner 0.10.0 / tool-math 0.10.0 / tool-onebot 0.10.0 / tool-search 0.10.0 / tool-session 0.12.0 / tool-system 0.11.0 / tools 0.8.0 / trigger-policy 0.12.0 / user-profile 0.12.0 / user-relation 0.13.0 / vectorstore-flat 0.11.0 / vectorstore-lancedb 0.11.0 / websearch-serper 0.10.0 / webui-server 0.12.0 / workflow 0.13.0
- `@aalis/runtime` 0.13.0（加载器）
- `@aalis/schema-config` 0.12.0（`PluginMeta.configSchema`；53 个消费方 dependencies 下限同步抬到 `>=0.12.0`）

脚手架 `create-aalis-plugin` 0.10.0、`create-aalis` 0.5.7（minimal 档加入 message-archive）与前端 `@aalis/plugin-webui-client` 0.12.6 同批发版，无 core peer，不计入上面 89。`plugin-todo-list` 把 `@aalis/api-memory` / `@aalis/api-webui` 从 `devDependencies` 归位到 `dependencies`（值导入描述符）；`@aalis/api-session-manager` 仍是 type-only，留在 `devDependencies`。api-* 互依里的 type-only 导入不抬下限。脚手架项目里 `@aalis/core` 若仍是 caret 区间，请显式装 `0.17.0` 与上列 peer 已抬的包，再 `npm update`；不要用 `--legacy-peer-deps` 绕过。

### 插件形状：`definePlugin`（@aalis/core / @aalis/runtime）

入口必须是 `export default definePlugin({ name, uses, provides, apply })`。`name` 须为非空字符串，且不含 instanceId 的 `:suffix` 与保留字符 `#`。`uses` 的值是描述符（或 `optional(描述符)`），没有默认注入——写了什么，`apply` 就只能碰到什么。`provides` 是描述符数组，激活后按本次 `instanceId` 校验确已登记。

```ts
import { definePlugin, defineService, logger, provide } from '@aalis/core';

const counter = defineService<{ n: number }>('counter');

export default definePlugin({
  name: '@scope/plugin-example',
  uses: { logger, provide },
  provides: [counter],
  apply({ logger, provide }) {
    provide(counter, { n: 1 });
    logger.info('ready');
  },
});
```

**迁移**：删掉具名 `export const name` / `inject` / `provides` 与 `export default function (ctx, config)`。`inject: { x: 'tools' }` 改为 `uses: { x: tools }`（值导入契约包描述符）；可选依赖包一层 `optional(tools)`。`apply(ctx, config)` 改为 `apply(caps)`，配置改从 `uses` 里的 `config` 读。加载器不再接受具名导出或函数 / 类 default，会 warn 并跳过该包。

### 能力入口（@aalis/core）

四原语与配置、日志、生命周期、发布、动态查询均须在 `uses` 里声明对应描述符。对照：

| 0.16 | 0.17 |
|---|---|
| `ctx.on` / `ctx.emit` | `events.on` / `events.emit` |
| `ctx.logger` | `logger` |
| `ctx.config` / `apply` 第二参 | `config`（本插件配置视图，只读） |
| `ctx.onDispose` | `lifecycle.onDispose`；新增 `lifecycle.onDrain` |
| `ctx.provide(name, impl)` | `provide(descriptor, impl, options?)` |
| `ctx.getService` / `ctx.getAllServices` | `uses` 后 `x.current` / `x.require()` / `x.all()` |
| `ctx.whenService(name, attach)` | `x.follow(attach)` |
| `ctx.useModule` | 已删除；改用顶层插件（`plugins.register` + `reusable` 多实例） |
| `ctx.middleware` / `ctx.runHook` | `hooks.middleware` / `hooks.run` |
| `ctx.contribute` / `ctx.collect` | `contributions.contribute` / `contributions.collect` |
| 整份宿主配置 | `hostConfig`（普通宿主服务，须显式 `uses`） |
| 动态按名取服务 | `services.get` / `services.all`（不增加声明依赖，不建立依赖边） |

`current` / `require()` 返回**当时点解析的实例**，不是自动转发的代理；把引用存起来须自行承担它失效。`require()` 在 required 依赖丢失到调度收敛之间也可能短暂抛错。`all()` 每次调用重新枚举；手动缓存的引用（例如 `all()[1]`）不建立关停边、不自动转发，也不保护被主动卸载的提供者。

`follow(attach)`：在场即调 `attach`；换人时先跑上次返回的清理，等它的 Promise 落定之后才用新实例再挂；下线与关闭时清理。`attach` 必须同步：需要清理就返回函数，不需要就不返回。返回 thenable 会被接住并 warn，不会当 cleanup 用。拒绝被隔离并报告，但不证明旧资源已释放。

```ts
import { storage } from '@aalis/api-storage';
import { definePlugin, lifecycle } from '@aalis/core';

export default definePlugin({
  name: '@scope/plugin-follow',
  uses: { storage, lifecycle },
  apply({ storage, lifecycle }) {
    storage.follow(svc => {
      const off = svc.watch?.('data:/example', () => {});
      return () => off?.();
    });
    lifecycle.onDrain(async () => {
      await storage.current?.stat('data:/example').catch(() => undefined);
    });
    lifecycle.onDispose(() => {});
  },
});
```

`services.get` 是动态查询：不参与激活闸、不自动跟随、不产生依赖边，关停期可能拿空。需要声明等待与跟随就把描述符写进 `uses`。

**迁移**：按上表改名即可。`whenService` 的 cleanup 语义由 `follow` 接过（含异步清理被关闭等待）。宿主要读整份配置，在 `uses` 里声明 `hostConfig`，不要假定会默认注入。

### 服务契约（各 `@aalis/api-*`）

每个契约包导出运行时描述符（`defineService` 的产物）。消费方必须把它放进 `dependencies`（值导入），不能只写 type-only / `devDependencies`。类型随描述符走，不再有全局服务类型表，也没有 `ServiceOf`。

`useToolService` / `useCommandService` / `useWebuiService` / `useAgent` / `useStorage` 等 helper 全部删除。`createStorageGateway` 等绑定 helper 的第一参改为 `ServiceRef`（`uses` 里声明的那一项直接传入）。

第三方能力作者用 `defineService(name, bind)` 自定义绑定接口，经 `BindingPort` 的 `registrar` / `follow` / `track` 接入归属与清理；`serviceRef(port, extra)` 可在调用型接口上叠登记方法——不要对象展开，`current` 是 getter。

**迁移**：`import { tools } from '@aalis/api-tools'`，写进 `uses`；`useToolService(ctx)` 改为 `caps.tools`。`createStorageGateway(ctx.getService('storage'))` 改为 `createStorageGateway(caps.storage)`。实现插件 `provide(tools, impl)`，不要 `ctx.provide('tools', impl)`。

### 调度与宿主入口（@aalis/core）

级联 bounce 开关与 `evictDownstreamConsumers` 删除。非管理动作引起的提供者换人（提供者自行撤回登记、偏好切换、更高优先级上线）不重启消费者；有状态接线走 `follow`；管理动作拆掉当前胜者见下一段。管理器的手动 `bounce(instanceId, { config? })` 仍在：拆掉当前激活 → pending → 重算后重新激活，不换代码。

管理动作重启 required 依赖方：`unload` / `disable` / `bounce`（`updateConfig` 即 `bounce`）一个提供者时，此刻 required 解析到它（胜者归要走的激活所有）的 active 依赖方按传递闭包并入同一批，先收尾、先关，之后转 pending 再重新激活；有后备提供者时同样重启，不在空档里切到后备。0.16 只级联声明了 `requiresBounceOnDepChange` 的下游。required 依赖方排在该服务的全部声明提供者之后激活（首个之外的提供者若传递地依赖该依赖方则不排，避免伪环），`bounce` 后挂回首选提供者。

内部重算只分 `'changed' | 'shutdown'` 两档，不从包根导出。`PluginEntry.module` 改为 `definition`；`requiredDeps` / `optionalDeps` 改为 `required` / `optional`（服务名数组）。公开的 `PluginEntry` 类型不含内部激活字段。激活记录类不再从包根导出；`app.ctx` 删除。

宿主入口：`app.plugin(definition, config?, instanceId?)`、`app.bind(uses)`、`app.config`、`app.plugins`。管理类插件经 `appService` / `pluginsService` / `hostConfig` 描述符声明获取，不要直接 import `App` 类当运行时依赖。

**迁移**：`app.plugin(mod)` 的 `mod` 改为 `definePlugin` 的产物。`app.ctx.getService(...)` 改为 `app.bind({ services }).services.get(...)` 或给那段宿主代码写 `uses`。读插件条目用 `entry.definition`，不要 `entry.module`。依赖列表用 `entry.required` / `entry.optional`。required 依赖方的内存态要能承受提供者被 `unload` / `disable` / `bounce` 时随之发生的重启。

### 关停编排与 `app:stopping`（@aalis/core）

关停按激活为单位，每个激活拆成收尾（`lifecycle.onDrain`：此刻本激活的监听、登记与声明的依赖都还在）与撤回加清理（`lifecycle.onDispose`：对外登记已撤回）。依赖交接放 `onDrain`；`onDispose` 阶段依赖可能已不可用。边只来自框架管理的关系：声明的依赖（含尚未访问的 optional）在编排那一刻解析到的胜者，以及存活的托管绑定与尚未落地的撤回。经 `services` 动态查询不产生边，调用方缓存的裸引用不追踪。

普通依赖（别的插件）：消费者整个 close 完，提供者才 drain。根激活使用插件的服务：根 drain 先于该插件 close，根 `onDrain` 期间该插件尚未关闭，但可能已执行 drain。插件使用根激活登记的服务（基础服务、宿主服务与 `app.bind({ provide })` 的发布）：不往排序图加边——归属保证插件 close 先于根 close，因此插件 drain 时根尚未关闭，也可能已执行 drain。环内 optional 边构成的强连通分量（≥2 个激活）卡住时一次放行分量内全部 drain，再 close；无法解除的 required 环告警后强行放行。归属约束与环外约束一条不松。框架保证编排顺序与等待，不保证插件在 drain 中已主动撤回或关闭的实现仍可用。`App.stop()` 把全部 active 插件与根激活放进同一张计划。单独 `unload` / `disable` / `bounce` 走同一套分阶段关闭：此刻 required 解析到该插件的 active 下游（传递闭包）并入同一批，先收尾、先关；提供者清理之前，挂在它所提供服务上、尚未进关闭计划的 `follow` / `registrar` 跟随者由撤回段就地驱动交接，旧清理落定后提供者才清理。已进关闭计划的跟随者在各自的撤回段清理，可能晚于提供者的 `onDispose`，依赖交接放 `onDrain`。

`App.stop()` 单飞：重入返回同一 Promise。现序：停配置 watch → `beginShutdown()`（置停机态并冻计划）→ `plugins.idle()`（排干在飞重算）→ 发出 `app:stopping`（屏障，等监听器）→ 再 `idle()` → 执行已冻计划的 drain / close → 清 sticky → 根激活 `disposeAsync`。已静置时仍须先冻闸，否则 `idle()` 让出的微任务里 bounce 会留下 pending 幽灵。`app:stopping` 只在全局停机触发一次，bounce / unload / disable 不发；知会（告别语、状态条）可以挂它，资源清理走 `onDrain` / `onDispose`。发出时停机计划已冻：窗口内 `unload` / `disable` 汇入该计划后立即返回 true（不等拆卸完成，拆卸由停机计划执行）；`register` / `bounce` 返回 false（与定义或实例 id 校验失败同属政策挡下的 false 口径；`register` 不落账）。每次调用 `stop()` 都得到完整停机的同一 Promise；监听器与清理回调不得 await 或返回它，以免等待自身。监听器里对已冻激活 `provide` 记 warn 后忽略、不抛。停机完成后：对新定义 `register` 返回 false 且不落账；对已 disposed 实例的 `enable` / `updateConfig` / `bounce` 返回 false；`idle()` 落定。

**迁移**：数据交接（flush、abort 在飞工作并等待收尾）放 `onDrain`；拆连接、摘登记放 `onDispose`，不要假定此时依赖仍在。不要用 `events.on('app:stopping', …)` 当清理通道。

### 定义与登记校验（@aalis/core）

缺 `name`、空串、仅空白、含 `#`、`name` 带 `:suffix`、或 `name` / `instanceId` 为危险键 `__proto__` / `constructor` / `prototype`：`definePlugin` 抛错；手写对象绕过它时 `register` / `app.plugin` 返回 `false` 并 warn，不落账。显式 `instanceId` 同样须非空、不含 `#`，但允许 `name:suffix`（多实例）。`uses` 必须是纯对象（不能是数组或原始值）；值不是描述符的项，定义期抛、登记期 `false`。`apply` 必须是函数：定义期抛，手写 `register` 返回 false 且不落账。`provides` 元素必须是描述符。

`provide` 拒空实现（`null` / `undefined`）与非有限 `priority`（`NaN` / `Infinity` / 非数字）。按插件 id 取放配置时，危险键抛 `插件 id 不合法: ${id}`。

`provides` 声明了但激活后未按本次 `instanceId` 登记 → 本次激活进入 `error`。`provide(..., { onBehalfOf })` 的条目逻辑身份取被代者，清理仍归本激活；代登记**不计入**代理人的 `provides`，写进去会按「未提供」报错。

**迁移**：保证 `export default definePlugin({ name })` 的 `name` 与包名一致（不一致加载器会 warn，配置键 / 热扫描 / 卸载以定义名为准）。代登记的服务不要写进本插件的 `provides`。

### 配置合并（@aalis/core / @aalis/schema-config）

注册期逐层深合并（宿主 `pluginDefaults` ← 配置文件 ← `app.plugin` 第三参）：全程返回新对象。纯对象递归拷贝，数组拷一层（元素若为纯对象也拷）；`Date` / `Map` / 类实例等非纯对象按引用透传。危险键 `__proto__` / `constructor` / `prototype` 跳过。`bounce` / `updateConfig` 的入参先拷贝再挂：`entry.config` 与 `ConfigManager` 各持一份，调用方事后改 payload 或插件经内置 `config` 就地改嵌套都不得写穿快照。

`schema-config` 0.12.0：配置表单声明挂到 `PluginMeta.configSchema`（此前挂在插件模块形状上）。`defaultsFrom` 对 array / object default 返回拷贝。core 仍把 `configSchema` 当 opaque 透传，不解释字段。

**迁移**：插件在 `definePlugin({ configSchema })` 里声明。依赖 `@aalis/schema-config` 的包下限抬到 `>=0.12.0 <1.0.0`。不要再改 `pluginDefaults` 或 `bounce` 入参并假定那就是登记后的活对象。

### 加载器与双副本（@aalis/runtime / @aalis/core）

`@aalis/core` 公开面从包根导出 `pluginDefinitionOf`（加载器与市场共用判定）：只认 default 导出的定义对象（带非空 `name` 与 `apply` 函数）。具名导出、函数 / 类 default、普通对象缺字段，一律 warn「入口须 `export default definePlugin({ … })`」并跳过。定义 `name` 与包名不一致另 warn 一次，仍加载，但配置键以定义名为准。

进程里只能有一份 `@aalis/core`：另一份副本造的描述符、optional 包装在 `definePlugin` / `register` / `provide` 处一律拒绝，注册期按 error 记「来自另一份 @aalis/core」；runtime 的两个加载器在 import 插件前核对它解析到的 core 包目录，不是宿主那份就只拒载该插件并写明两条路径与修法。本地目录安装改用 `npm install --install-links` 或 `pnpm add file:`。

**迁移**：入口改 default 定义。继续使用 peer `>=0.17.0 <1.0.0` 并尽量去重，禁 caret；跨副本支持不替代版本约束。

### 热扫描、市场卸载与 WebUI 配置（@aalis/core / @aalis/plugin-package-manager / @aalis/plugin-webui-server）

`rescanPlugins` 与 `autoLoadPlugins` 共用配置键里的 `name:suffix` 多实例登记。返回值仍只含新发现的主描述符名，不含 `:suffix`。

市场装卸以加载器解析的**定义 name**为准（可与 npm 包名不同）。卸载在 `npm uninstall` 之前按定义 name 枚举注册表里全部 instanceId（主实例 + `name:suffix`），逐个 `unload` 并清理配置块与禁用标记。

PUT `/api/plugins/:name/config` 按 `configSchema` 裁掉未知键并 warn。裁剪与 runtime 共用 `@aalis/schema-config` 导出的 `removeExtraFields`。`:name` 非法时（含 `#`、危险键）core 抛错，路由返回 400 并透出原文。GET `/api/plugins` 列表对 `schema.secret` 字段回传掩码 `••••••`，编辑器 `GET /api/plugins/:name/config` 保持原文；列表不可作为配置备份。

### session-manager 关停收口（@aalis/plugin-session-manager）

`lifecycle.onDrain` 把仍为 `active` 的会话收口为 `completed` 并立即落盘；`waiting` / 已终态不动。不依赖 agent 钩子。`onDispose` 仍 `shutdown()` 再刷一次。

### `ServiceContainer.getEntries` 删除（@aalis/core）

它把容器内部的条目对象原样交出（只拷贝外层数组），调用方能改 `priority` / `contextId` / 清理归属 `owner` 绕过容器不变量；
`ServiceEntry` 类型随之不再从包根导出。

**迁移**：声明 `services` 后改用 `services.all(name)`，或在 `uses` 里声明该服务后 `x.all()`。元素是 `ServiceView` 投影（`instance` / `contextId` / `priority` / `label`），顺序相同。只看元数据请改用 `inspect`。

## 2026-09-20（core 0.16.0 minor；patch：api-tools 0.8.4 / plugin-agent 0.13.6）

### `bounce` 不再接受 `module`（@aalis/core）

`PluginManager.bounce(instanceId, { module })` 的模块热替换选项删除。它只换了模块引用，没有随之换新 `inject` 的依赖声明，
也在按旧模块 `provides` 疏散下游之前就换了引用——新模块声明的必需依赖缺失时仍会被激活。仓内没有调用方。

**迁移**：要在不改 instanceId 的前提下换代码，走 `await plugins.unload(id); await plugins.register(fresh, config, id)`。
与旧 `bounce` 的差异：注册表里的位置重置（只影响 required 依赖成环时的声明序兜底）、多发一次 `plugin:unloaded`。
`bounce(id, { config })` 与 `updateConfig` 不变。仍传 `module` 的调用（TypeScript 编译期报错；JavaScript 运行期）会记 warn 并返回 `false`，
不会静默跑旧代码。

## 2026-09-19（core 0.15.0 minor；patch：api-tools 0.8.3 / plugin-tools 0.7.4 / plugin-webui-server 0.11.11）

### `whenService` 的 cleanup 先于 `onDispose` 执行（@aalis/core）

Context 的清理链分成撤回段与清理段：`whenService` 回调返回的 cleanup 挂撤回段，拆卸时**先于全部 `onDispose` 回调**执行，
且执行时本 Context 的四原语登记已切断。此前它与 `onDispose` 按登记顺序 LIFO 交错，用户清理跑的时候，经 tools / commands /
webui 等枢纽服务交出去的登记仍在册，半拆的插件还会被枢纽派活；现在与四原语一样，用户清理开始前已撤净。

**迁移**：凡是"关闭在 `whenService` 的 cleanup、最终提交在 `onDispose`"的写法，顺序会从"提交 → 关闭"反转为"关闭 → 提交"。
依赖同一资源的最终提交与关闭要组织在同一个有序清理流程里——都放 `onDispose`（推荐），或都放 cleanup。
公开签名无变化；只调枢纽 `off()` 的 cleanup 不受影响（第一方已逐处核过）。分段只约束排空快照内的次序，排空期间迟到登记的清理仍立即执行。

## 2026-09-18（core 0.14.0 minor；patch：runtime 0.12.5 / api-commands 0.5.2 / api-tools 0.8.2 / api-webui 0.9.3 / plugin-adapter-onebot 0.12.4 / plugin-commands 0.10.1 / plugin-flow-control 0.9.4 / plugin-mcp-client 0.10.3 / plugin-persona 0.9.5 / plugin-skills 0.10.3 / plugin-tool-onebot 0.9.3 / plugin-tools 0.7.3 / plugin-webui-server 0.11.10）

**升级**：core 又走了次版本，且这次改了事件名与管理动词，**旧版第一方插件配新 core 会失效**——`ctx.on('ready')` 永远
收不到（静默），`plugins.enablePlugin` 不存在（TypeError）。下列包必须与 core 同批升级，它们的 core 下限已抬到 `>=0.14.0`：
runtime / plugin-adapter-onebot / plugin-flow-control / plugin-persona / plugin-skills / plugin-tool-onebot / plugin-webui-server /
plugin-mcp-client。脚手架项目里 `@aalis/core` 若仍是 caret 区间，请显式 `npm install @aalis/core@latest @aalis/runtime@latest`
再 `npm update`；不要用 `--legacy-peer-deps` 绕过。第三方插件按下面各节的迁移路径改。

### 四原语注册表统一形状（@aalis/core）

四个注册表（`EventBus` / `HookRegistry` / `ServiceContainer` / `ContributionRegistry`）此前各写各的，现统一为：
注册方法返回退订闭包；hooks / services / contributions 三家的形状是 `(键, 载荷, contextId, owner?)` 且 `contextId` 必填
（原先两家默认 `'root'`），events 保持 `(event, handler, owner?)`、注册者身份由 owner 派生；键按各自的扩展点接口约束
（`keyof AalisEvents` / `HookContextMap` / `ContributionPointMap`），services 例外——服务名保持开放（动态服务名是既定逃生舱），
约束落在载荷 `ServiceOf<K>` 与 `get` / `getAll` 的按键重载上。具体变化：

- `ServiceContainer.register(name, instance, contextId, owner?, options?)`：`priority` / `label` 收进 `options`；返回退订闭包
  （闭包返回这次是否真摘掉了条目），`unregisterEntry(name, entry)` 删除；`instance` 按 `ServiceTypeMap` 约束，`get` / `getAll`
  按键推导实例类型（未登记名仍走 `get<T>(name)` 兜底）。`getAll` 的元素类型具名为 `ServiceView<T>`（新导出，结构不变）。
- `ContributionRegistry.register` / `collect` 按 `ContributionPointMap` 约束贡献点名与 spec 类型。
- `HookRegistry.register` 的 `contextId` 不再默认 `'root'`。
- `EventBus.onHandlerError` 回调新增可选第三参 `contextId`（注册者的逻辑身份，无 owner 的裸登记为 `undefined`）——加法。
- `ConfigManager.watch(onChange)` 返回退订闭包（与 core 其余订阅口同形），`unwatch()` 保留为属主 App 的整体清扫口；
  已有订阅时再 `watch` 抛错，不再静默顶替——单订阅者口径成文。

**迁移**：经 `ctx.provide` / `ctx.middleware` / `ctx.contribute` / `ctx.on` 门面的代码不受影响。直接持有注册表
（`app.services` / `app.hooks` / `app.contributions` / `ctx.serviceContainer`，或自建 `new ServiceContainer()`）的代码：
`register` 的返回值由 `ServiceEntry` 改为退订闭包，按引用删除改为调用该闭包；位置参数 `priority` / `label` 改写进
`options`；补上 `contextId`。原先能编译的错误实现会开始报错：services 的未登记名仍落到 `unknown`、行为同旧，已登记名按契约
修正实现；contributions 的贡献点名必须已 declaration-merge 进 `ContributionPointMap`（0.8.0 起门面就是这个要求，现在注册表
这条旁路也关上了）。`packages/` 下零命中；`test/core/service.test.ts` 一处夹具因此改用合成名 `__t:llm`。

### 内置事件分「屏障 / 通知」两节，`plugin:loaded` 不再等监听器（@aalis/core）

core 自持的 11 条内置事件按「发射方等不等监听器」分两节，写进 `AalisEvents` 的 JSDoc，并由 `test/core/architecture.test.ts`
按调用形式守：屏障（`app:starting` / `app:ready` / `app:started` / `app:restarting` / `app:stopping`，后两者改名见下节）由 `App` 的
生命周期方法等监听器全部返回后才推进下一步；通知（`service:*` / `plugin:*` / `plugins:changed`）不等监听器。

**行为变化**：`plugin:loaded` 此前是唯一 `await` 监听器的通知事件，现与同节其余事件一样不等。此前一个慢监听器会挡住同一轮
recompute 里下一个插件的激活，监听器里 `await plugins.idle()` 则必死锁（idle 等 flight 排干，flight 等监听器返回）。现在监听器
不能再假设「我返回了状态机才继续」，要看落定后的状态请 `await plugins.idle()`；监听器的异步尾巴可能在 `plugins.idle()` /
`app.stop()` 返回之后才跑完。`packages/` 下没有 `plugin:loaded` 的监听点。

### 屏障事件统一 `app:` 前缀：`ready` → `app:ready`，`restarting` → `app:restarting`（@aalis/core）

五条屏障事件此前三条带 `app:` 前缀、两条不带，节的归属要靠一张手工名单；现在「屏障 ≡ `app:*`」是纯语法判据，
架构测试直接按前缀判节，并对账 `AalisEvents` 声明的 `app:*` 集合与 `App` 实际发出的集合。`app:ready` 与 `app:started`
仍是两个相位（`start()` 串行 await，前者的监听器全部完成后才发后者），只改名不合并。

**迁移**：`ctx.on('ready', …)` → `ctx.on('app:ready', …)`，`ctx.on('restarting', …)` → `ctx.on('app:restarting', …)`；
旧键已从 `AalisEvents` 删除，旧写法编译期报错，不会静默失效。第一方跟改的包（发布时抬 core 下限至 `>=0.14.0`）：
plugin-adapter-onebot / plugin-flow-control / plugin-persona / plugin-skills / plugin-tool-onebot / plugin-webui-server。
WebUI 的 WS 报文 `type: 'restarting'` 是前端协议，与 core 事件名无关，不跟改。

### PluginManager 的管理动作去掉 `Plugin` 后缀（@aalis/core）

`enablePlugin` → `enable`，`disablePlugin` → `disable`，`updatePluginConfig` → `updateConfig`，`bouncePlugin` → `bounce`；
`bounce` 同时加进 `PluginManagerService` 接口（此前只在类上，插件作者指南却教经服务调它）。持有它的对象已经叫 `plugins`，
`plugins.enablePlugin(id)` 的后缀是同一个词说两遍；与同一接口上的 `register` / `unload` 对齐（`getPlugin` / `getStatus`
里的名词是返回的对象，不是后缀，不动）。形参名同批统一为 `instanceId`（纯改名，不影响调用）。

**迁移**：按上表改方法名即可，签名与语义不变。第一方跟改的包（发布时抬 core 下限至 `>=0.14.0`）：
plugin-mcp-client / plugin-webui-server / runtime；WebUI 的 HTTP 路由路径（`/enable`、`/disable`）本就无后缀，不变。

### 管理动作一律返回 `Promise<boolean>`（@aalis/core）

`PluginManagerService.register` / `unload` 由 `Promise<void>` 改为 `Promise<boolean>`，与 `enable` / `disable` / `bounce` /
`updateConfig` 同一口径：**false = 主体不在注册表，或本次动作被状态 / 政策规则挡下**（重名、未声明 `reusable` 的多实例、
core 插件禁用、`disposed` 单向终态、`disabled` 态 bounce）；**true = 其余，含主体已在目标态的幂等情形**（unload 撞上在途卸载
即 join 它）。每个 false 分支都已记一笔日志（政策挡下 warn，主体不存在与 `disposed` 在途 debug）。`App.plugin()` 透传 `register` 的结果；`App.rescanPlugins()` 据此不再把
「描述符名与模块自报名不同、自报名已注册」的模块误报进热加载名单。

**迁移**：调用方可以继续忽略返回值。自行实现 `PluginManagerService` 的第三方需把这两个方法改为返回 `Promise<boolean>`
（旧实现的 `Promise<void>` 不满足接口的 `Promise<boolean>`，编译报错；仓内无此类实现）。

## 2026-09-17（core 0.13.0 minor；patch：runtime 0.12.4 / plugin-authority 0.11.5 / plugin-cli 0.10.3 / plugin-mcp-client 0.10.2 / plugin-media 0.13.3 / plugin-package-manager 0.5.3 / plugin-webui-server 0.11.9）

**升级**：core 走了次版本。脚手架生成的项目里 `@aalis/core` 是 caret 区间（`^0.12.x` 不含 0.13.0），而本批 runtime / plugin-cli / plugin-media / plugin-package-manager 用到了 `saveConfig()` / `config.save()` 的 Promise 返回值、peer 下限抬到 `>=0.13.0`——直接 `npm update` 会 ERESOLVE。请显式升级：`npm install @aalis/core@latest @aalis/runtime@latest`，再 `npm update`。不要用 `--legacy-peer-deps` 绕过：那会装出新 runtime 配旧 core 的组合，启动时即 TypeError。

### saveConfig 返回 Promise，兑现时保存已完成（@aalis/core）

`AppService.saveConfig()` 由 `void` 改为 `Promise<void>`：同步 provider 立即完成，异步 provider 等其落定；provider 失败以拒绝传出——此前异步 provider 的拒绝被 `ConfigManager.save` 静默吞掉、App 照记「配置已保存」，同步 provider 的抛错则同步冒给调用方，现在两者都以拒绝传出。core 会把失败记一条 error 并标记为已处理，所以不 await 的调用不会变成未处理拒绝。并发保存的先后与外部编辑的合并不在此契约内。
**迁移**：调用方 `await app.saveConfig()`；尽力而为的后台持久化路径用 `.catch()` 记录。第三方若实现 `AppService` 需改返回类型。不 await 的旧调用（0.13.0 之前发布的第一方插件如此）成功路径不变；失败路径上，旧调用者会继续后续逻辑——原本依赖同步抛错的错误处理失效，失败只出现在 core 的 error 日志里，部分调用方可能误报成功。与 core 同批升级 plugin-webui-server ≥0.11.9 / plugin-authority ≥0.11.5 / plugin-mcp-client ≥0.10.2 / plugin-cli ≥0.10.3 / plugin-media ≥0.13.3 即恢复正确的失败处理。

### provide 按 ServiceTypeMap 约束实现类型（@aalis/core）

`ctx.provide(name, instance)` 对已知服务名（`ServiceTypeMap` 中声明的）按契约类型检查 `instance`，错误实现在编译期被拒；未知名与动态字符串仍为 `unknown`。运行时不变。
**迁移**：编译报错的要么是真实缺口（修实现），要么是刻意的部分替身（测试里按仓内先例 `as never`）。

### useModule 返回可等待的模块句柄（@aalis/core）

`ctx.useModule()` 由返回 `() => void` 改为返回 `ModuleHandle { id; dispose(); disposeAsync(timeoutMs?) }`，与 Context 自身的生命周期面同形。`await handle.disposeAsync()` 返回时子上下文里全部异步清理已完成，此前 `await off()` 只是「开始执行」。`disposeAsync` 路径下模块名在子上下文彻底收尾（清理链排空、按 `ctx.id` 的枢纽清扫）之后才释放：排空期间同名新挂载拿到 `~n` 后缀，不再复用旧名。`dispose()` 保持原同步语义，不等异步清理，名字随同步段释放；需要名字隔离的用 `disposeAsync`。
**迁移**：`off()` → `handle.dispose()`；需要等清理落地的改 `await handle.disposeAsync()`。

### 注册表按清理归属清理（@aalis/core）

四个注册表（`ServiceContainer` / `HookRegistry` / `EventBus` / `ContributionRegistry`）的 `unregisterByContext(id)` 删除，换为 `unregisterByOwner(owner: symbol)`；`register` / `on` 新增可选 `owner` 参数，`EventBus.on` 第三参由 `string` 改为 `symbol`。`ctx.id` 仍是逻辑身份（贡献键与同键替换、服务偏好、模型引用、`hasByContext` 前缀查询）；清理按每次激活新鲜的内部 owner，同名 Context 在四原语层互不误清，拆卸在飞时同名新激活的注册也不会被迟到的清理误删。经 `tools` / `commands` / `webui-server` 等枢纽服务登记的条目仍按 `ctx.id` 走 `unregisterByPlugin` 清扫，不变。
`EventBus` 的登记改为按次计身份：同一函数被两个 Context（或同一 Context 两次）登记互不相干，各自退订、各自清理——此前按函数去重，后登记者会顶掉先登记者的归属，先登记者的退订会删掉后登记者。同一 handler 登记两次现在触发两次（与 Node `EventEmitter` 一致）。
**迁移**：经 `ctx.provide` / `on` / `middleware` / `contribute` 注册的无需改动。不经门面直接调注册表 `register` 的条目不再随 Context dispose 自动清理（原按 contextId 与 `id/` 前缀清），用返回值自管；直接调过 `unregisterByContext` 的改为逐条用返回值清、或经 Context dispose。

## 2026-09-13 修复批（二）（无 core 变更；minor：plugin-checkpoint 0.11.0 / plugin-file-reader 0.11.0；其余 patch：api-media 0.9.3 / api-session-manager 0.8.1 / api-storage 0.5.6 / plugin-adapter-onebot 0.12.1 / plugin-agent 0.13.2 / plugin-cli 0.10.2 / plugin-media 0.13.2 / plugin-scheduler 0.11.1 / plugin-storage-local 0.10.2 / plugin-tool-system 0.10.1 / plugin-workflow 0.12.1 / plugin-webui-server 0.11.5 / plugin-webui-client 0.12.4）

### checkpoint 不记共享根（@aalis/plugin-checkpoint）

回合期间的文件快照不再记 `kind` 为 `data` / `pluginData` / `logs` 的根（多会话、多平台共享的写入区：别处落盘的附件、插件状态，也包括本回合经 `skill_create` / `skill_update` 等写入 `data:/skills` 的内容）与 `tmp` 根（原先只排除 tmp）；`workspace` 与用户在 storage 配置里自建的 `custom` 等根照常记账。此前 storage 写入没有会话归属，其它会话乃至其它平台落到 `data:/images/…` 的文件、scheduler 等插件保存的状态文件都被记成本回合改动，WebUI 一回滚就删掉别人刚落盘的图片、把状态文件写回旧版。升级前写下的 manifest 里的这类条目读取时一并忽略，历史回合的回滚不再碰它们。`exec` 类工具的副作用本就不在保护范围内，不变。
**迁移**：无需操作。

### 上传文件的会话目录名（@aalis/plugin-file-reader）

新上传文件落到 `pluginData:/file-reader/<会话目录>/…`，会话目录名把 sessionId 里的 `:` `/` `\` 替换为 `_`（与附件落盘同一套规则；Windows 文件名不收冒号，此前 OneBot 会话的上传落盘直接失败）。启动恢复按 meta 文件实际所在目录定位数据文件、按会话清理时新旧目录名都清，WebUI「已上传的文件」路由读侧两种目录名都试（plugin-webui-server 0.11.5 同批升级），老版本按原样 sessionId 建的目录照常可读可删，不必迁移。降级到旧构建后，新目录里的文件同样能被扫到（旧代码也按扫到的 meta 恢复），但删除/清理会算错路径（0.x 不保证降级）。

### 其余行为对齐（patch）

- plugin-adapter-onebot：合并转发里字符串格式的节点先规范化成消息段再渲染，与段数组同一条路径——文本做 CQ 反转义，`[CQ:at,qq=all]` 渲染为 `<at>all</at>`，字符串里的 `[CQ:forward]` 也会递归展开（多一次 `get_forward_msg`）。描述缓存别名对 QQ 直链的 rkey 轮换免疫（登记与查询两侧都按剥掉 rkey 的键再走一次）。
- plugin-media：图片描述缓存按详略档分键——`auto`（默认）与到达识别共用一条，`casual` / `detailed` / `professional` 各自一条；快照文件里因此会出现 `<内容哈希>#<档位>` 形式的键，旧构建读到会原样当普通键载入，无害。
- api-storage：`resolveAgainstCwd` 把 `C:/…` 与 `C:\…` 一并判为宿主机绝对路径拒绝；storage 根名须至少两个字符（单字母根名与 Windows 盘符文法冲突，按盘符处理）。
- plugin-agent：会话级 `maxToolIterations` 生效——正整数覆盖全局配置，非正整数视为未设置。
- plugin-cli：非 chat 视图期间聊天区有新内容（含意图确认提示）时 header 的 CHAT 页签带计数高亮。
- plugin-scheduler / plugin-workflow：远期一次性 `runAt`（> 24.8 天）不再因 `setTimeout` 溢出即刻执行；工作流定义目录列举失败的那次启动不再清空 once 记账。
- plugin-storage-local：`watch` 文件 URI 改为监听父目录按文件名过滤，事件路径不再翻倍、原子覆盖写之后仍有事件。
- plugin-tool-system：`file_read` 整篇读取与行范围读取同一行数口径（结尾换行不算一行、CRLF 行内容不带 `\r`、空文件 0 行）。

## 2026-09-13（core 0.12.1 仅修复；minor：api-session-manager 0.8.0 / api-platform 0.6.0 / plugin-session-manager 0.11.0 / plugin-adapter-onebot 0.12.0 / plugin-trigger-policy 0.11.0 / plugin-workflow 0.12.0 / plugin-cli 0.10.0 / plugin-tool-session 0.11.0 / plugin-scheduler 0.11.0 / plugin-tool-system 0.10.0 / plugin-process-local 0.6.0 / plugin-checkpoint 0.10.0 / plugin-tool-browser 0.10.0 / plugin-cron-engine 0.6.0 / vectorstore-flat 与 lancedb 0.10.0；其余 patch，契约包的可选字段加法走 patch：api-tools 0.8.1 / api-authority 0.7.1 / api-media 0.9.2 / api-agent 0.7.1）

### 确认与回合中止（@aalis/api-tools / @aalis/api-authority / plugin-cli）

`ToolCallContext.signal` 与 `AccessRequest.signal`（均为可选）：agent 把回合的中止信号传给工具服务与权限守卫，等待人工确认期间回合被中止（新消息 latest-wins / 手动 abort）时，工具不再执行、未决确认被撤回——此前用户稍后按下的 y 会替一个已死的回合执行写操作。第三方 authority / 确认通道实现可忽略该字段（退化为等应答）。
plugin-cli 不再自建终端确认通道：确认提示（含参数摘要）作为消息进聊天区，在输入框回复 `y` / `ys` 后回车，与 WebUI / OneBot 同一份排队、超时、会话授予语义；此前按单键 `y` 的交互不再有。

### workflow 的 once 触发器一生只触发一次（@aalis/plugin-workflow）

此前 `runAt` 已过的一次性工作流在每次进程启动 / 插件 bounce 时都会再跑一遍（节点若是 send-message 就是每次重启重发）。现在触发后把 `firedAt` 记进运行历史文件，注册时已有记账即跳过；同 id 覆盖定义不会重新触发，要再跑一次先 `workflow_remove` 再定义或直接 `workflow_run`；定义文件被删除后记账随之清除。
**迁移**：运行历史文件从顶层数组升级为 `{ runs, onceFired }`，新代码能读旧文件；降级到旧构建会把运行历史读空并丢掉 once 记账（0.x 不保证降级）。

### @ 判定只认 `<at self>`，OneBot 字符串消息格式在入站统一成 segments（plugin-trigger-policy / plugin-adapter-onebot）

trigger-policy 删掉了 `[CQ:at,qq=…]` 字符串兜底（它不分辨被 @ 的是谁，字符串格式下群里 @ 任何人 bot 都会抢答）；adapter-onebot 在入站把字符串格式（含 `raw_message` 回退与 `get_msg` 引用反查）规范化成 segments，`<at self>` 只由适配器产出。**两包须同批升级**：只升 trigger-policy 而 OneBot 端配 `message_format=string` 时，@ 触发会静默失效。

### 移除（经全仓 grep 确认零消费面）

- `SessionManagerService.setPlatformProfile()`（@aalis/api-session-manager）与 WebUI 动作
  `updatePlatformProfile`（@aalis/plugin-session-manager）：删除从未落盘的运行时写平台档入口——
  参考实现只把它写进内存 Map，`persist()` 只落会话元数据，重启即丢。平台档统一走插件配置
  `platformProfiles`（WebUI 配置页 / `aalis.config.yaml`），读侧 `getPlatformProfiles()` 不变。
- `PlatformAdapter.isReady?()`（@aalis/api-platform）：删除从未有消费者的 isReady——
  适配器可用性一律看 `getConnections()` 里的 `status`；实现过它的 plugin-adapter-onebot 同批删。

## 2026-09-11（无 core 变更；runtime 0.12.0 / api-authority 0.7.0 / api-tools 0.8.0 / schema-message 0.8.0 / plugin-media 等）

### 子命令是默认行为（@aalis/runtime）

`startAalis({ subcommands })` 从 `boolean | string[]` 收成 `string[]`，默认 `process.argv.slice(2)`：
`node index.mjs status` 直接等价于聊天里的 `/status`，执行后退出；argv 非空但首项不是已注册命令时报错退出（exit 2），不会启动守护进程（此前会照常起守护，打错命令名即与运行中实例并存的第二个实例）。argv 为空才进守护进程。
子命令进程是与守护进程零通信的一次性实例：不写 `data/latest.log`（此前会截断守护进程正在写的日志）、不注入重启策略（此前 `restart` 子命令在 `app.stop` 超过 500ms 时会 spawn 出 argv 仍带 `restart` 的 detached 子进程无限连环）；`status` / `shutdown` 只作用于该临时实例；写数据的指令按落点分：写 `aalis.config.yaml` 的经守护进程热重载生效，只改插件内存态的不生效。日志走 stderr，stdout 只有命令结果。
`tryDispatchSubcommand` 返回值从 `number | null` 收成 `number`（未命中返回 2 并经新增的 `err` 回调报错）。
迁移：删掉 `subcommands: true`（现在是默认，仍传也按默认处理）；显式传 `subcommands: false` 的宿主要改传 `[]`——
非数组一律按默认处理，`false` 不再关闭分发；宿主自己解析 argv 的，把要分发的数组显式传入——靠位置参数给守护进程传东西的启动方式现在会 exit 2。

### 确认通道可注销（@aalis/api-authority）

`AuthorityService.setConfirmHandler()` 改为返回注销函数，注册方在 dispose 时调用（plugin-session-confirm / plugin-webui-server / plugin-cli 都经 `whenService` 注册并把它作为 cleanup 返回：跟着 authority 的胜者走，bounce 后自动重挂）。
此前禁用或卸载 session-confirm 后 authority 仍持有已死的 `'*'` 回调，每次需确认的工具调用都要等 60 秒超时才被拒。
第三方 authority 实现需同步返回注销函数；仍返回 `undefined` 的旧实现照常可用，只是注册方无法注销（行为同旧版）。

### 图片处理重定位：识别模型 + 两个正交开关（plugin-media）

`vision.mode` 四档（describe / passthrough / passthrough-raw / disabled）删除，由两个正交键取代：

| 旧值 | 等价的新配置 |
|---|---|
| `describe`（默认） | `recognizeOnArrival: true` + `delivery: 'describe'`（文本主模型下 `auto` 等价） |
| `passthrough` | `recognizeOnArrival: false` + `delivery: 'passthrough'` |
| `passthrough-raw` | 同上；动图不抽帧的实验档已删除，直通一律抽帧 |
| `disabled` | `recognizeOnArrival: false` + `delivery: 'describe'`（档案只留指针，模型可按需 `analyze_image`） |

旧键在启动时**一次性迁移**：plugin-media 按上表映射写入新键、删除 `vision.mode` 并写回配置文件（日志提示一次），
之后 WebUI 上该弃用字段显示为「未设置」。`delivery` 默认 `auto`：按本会话生效主模型的 vision 能力选直通或转文字。**迁移**：无需手动操作；旧键 `vision.mode`
在 schema 里保留一版（标为已弃用），只为让 WebUI 能显示它已被清空。注意主模型带 vision 的部署：新默认（识别 + 直通）会让当轮图片既被识别模型描述又直通主模型，
想保持旧 `describe` 的成本请显式设 `delivery: 'describe'`。同批删掉从未生效的配置：`video.maxTokens` /
`video.think` / `video.prompt`（只喂给从不被选中的 `video.passthrough` processor）与
`document.extractImages`（无消费者）；`document.image` processor 同理不再注册。

### 工具结果携图（api-tools 0.8.0）

`RegisteredTool.handler` 可返回 `string | ToolExecutionResult`（`{ content, images? }`），
`ToolService.execute` 一律返回 `ToolExecutionResult`。**实现或直接调用 `ToolService.execute`
的代码要改读 `.content`**（仓内调用方：plugin-agent / plugin-mcp-server / plugin-workflow 已随批改）。
返回形状的实现方是 plugin-tools：**plugin-tools 与这三个调用方必须同批升级**——旧调用方拿到对象会当字符串用。
反向（新调用方配旧 plugin-tools）已由 api-tools 0.8.0 的 `asToolExecutionResult()` 兜住：三个仓内调用方都经它读结果，
第三方直接调 `execute` 的代码也应如此。
只注册工具、handler 返回字符串的插件零改动。出口编码在 schema-message 0.8.0 的
`prepareLLMMessages`：tool 消息带 `images` 时拆成 tool 文本 + 一条注明来源的 user 图片消息。

## 2026-08-30（无 core 变更；单包 plugin-agent 0.12.1）

### agent：media 缺席时的图片基础体验（盖楼修复）

此前「出口 images 只交出 provider 可解码形态」这条不变量的唯一守卫住在 plugin-media
的 `agent:llm:before` 中间件里——media 缺席时，OneBot 图片附件的落盘相对路径会原样
进入请求，openai/ollama 系模型整轮被拒（400 illegal base64 data），表现为发图即不回话。

现在 agent 在 media 缺席时把这种（且仅这种）已知必炸形态经 storage 物化为 data URI，
保住「视觉主模型直通」的基础体验；物化失败则丢弃该图；其余一切形态（data:/http(s)/
file:// 等）原样透传，由各 provider 自行解析。media 在场时行为逐字节不变（原样透传，
出口规范化仍归 media）。

**注意**：media 缺席时图片一律直通主模型——无模式开关、无体积闸（单图上限即适配器
落盘上限）、动图不抽帧；主模型无视觉能力时图片是否被忽略取决于服务端。需要
describe/passthrough/disabled 分档、抽帧与体积控制，请安装 plugin-media。

## 2026-08-29（无 core 变更；各包独立版号）

本批 17 包：schema-message 0.7.0 / plugin-memory-vector 0.11.0 /
plugin-message-archive 0.10.0 / api-session-manager 0.7.0 / plugin-session-manager 0.10.0 /
plugin-agent 0.12.0 / plugin-user-profile 0.11.0 / plugin-commands 0.10.0 /
plugin-llm-openai 0.10.1 / plugin-adapter-onebot 0.11.1 / plugin-media 0.12.1 /
plugin-memory-summary 0.10.1 / plugin-webui-server 0.11.2 / api-memory 0.5.1 /
api-gateway 0.5.1 / create-aalis 0.5.3 / create-aalis-plugin 0.9.4

### memory-vector：AI 自身回复进入语义召回（recallRoles 双模式）

`schema-message` 新增 `assistant:message:archived` 事件（message-archive 在 assistant
回复落库后发出）；memory-vector 据此索引 AI 自身发言（metadata 带 `role`），新配置
`recallRoles`（默认 `all`）控制其是否参与召回。所有召回到的 assistant 条目强制带
「Assistant·你自己」角色标注（同批的防自我强化地基，不随开关关闭）。

**行为变化**：升级后 AI 的新回复（对外可见回复；工具回合内部前言不入）开始进入向量库
并默认可被召回。`recallRoles: others-only` 过滤的是**语义命中点**（候选池自动放大一倍补偿，
assistant 语料占比很高时命中数仍可能少于从前）；命中点的扩窗邻居不过滤、以角色标注呈现。
存量历史不自动回填。

### user-profile 0.11.0：aalisFeelings 特性整体移除

移除「Aalis 对用户的主观感受」层：配置键 `enableAalisFeelings` / `maxFeelingsPerUser` /
`injectFeelingsForOthers` / `maxFeelingsForOthers`、工具参数 `user_profile_lookup.include_feelings`、
档案字段 `aalisFeelings` 及其抽取/注入路径全部删除。该特性默认关闭且 schema 自述
「不建议开启」（无 sourceQuote 护栏的自我蒸馏回路）。

**迁移**：配置里遗留的四个键会被 config-sync 按 schema 白名单裁剪并告警，不影响启动。
**数据不可逆**：若曾开启过该开关，存量 `aalisFeelings` 字段会在升级后的首次档案写入时
被整体覆写丢弃（saveMetadata 为整条替换语义），无导出/迁移路径；需要保留请在升级前自行导出。

### commands 0.10.0：受信系统源收窄为 scheduler-only

`TRUSTED_SYSTEM_SOURCES` 删除 `workflow` 与 `system` 死项：workflow 派发进虚拟会话的
命令不再免确认，照常走 confirm 闸（虚拟会话无人应答即超时拒绝，fail-closed）。原因：
workflow_define/workflow_run 仅需 level-1，受信等于让 L1 用户绕过确认闸向任意会话投递
高危命令（提权面）。依赖 workflow 静默执行确认类命令的自动化会从「静默执行」变为
「超时拒绝」；如需恢复须自行抬高 workflow 工具档位（另行决策）。

### 会话级 thinking 开关（api-session-manager 0.7.0 / agent 0.12.0 / session-manager 0.10.0）

`SessionConfig` 新增 `think?: boolean`（`/session.set -t on|off` 设置、`/session.reset` 复位，
未设置继承 provider 全局配置）。**同批升级**：plugin-agent 0.12.0 与
plugin-session-manager 0.10.0 需一起升——平台级默认 think 由 session-manager 白名单式
逐字段解析，旧版会静默丢弃该配置字段。

---

## 2026-08-24（无 core 变更；各包独立版号）

本批 19 包：api-tools 0.7.0 / api-authority 0.6.0 / plugin-tools 0.6.0 /
plugin-authority 0.11.0 / plugin-agent 0.11.0 / plugin-scheduler 0.10.0 /
plugin-workflow 0.10.0 / plugin-tool-session 0.10.0 / plugin-subtask 0.11.0 /
plugin-llm-openai 0.10.0 / plugin-llm-deepseek 0.11.0 / plugin-embedding-openai 0.10.0 /
plugin-mcp-client 0.10.0 / plugin-user-relation 0.12.0 /
plugin-tool-system 0.9.5 / plugin-webui-client 0.12.1 / api-process 0.5.2 /
api-llm 0.10.1 / plugin-tool-code-runner 0.9.3。

### llm-openai / embedding-openai / llm-deepseek：baseUrl 语义改为「完整前缀」

插件不再向 baseUrl 硬拼 `/v1`，只拼端点名（`/chat/completions`、`/models`、`/embeddings`）。
与 plugin-asr-openai 的既有约定对齐；Gemini 等无 `/v1` 段的兼容端点
（`https://generativelanguage.googleapis.com/v1beta/openai`）从此可直接配置。

**迁移**（注意：config-sync 会在启动时把默认值物化进配置文件，所以不存在"未配置 baseUrl"的
存量部署——所有跑过旧版的配置文件里都已写着旧默认值）：
- llm-openai / embedding-openai：配置值恰为旧默认 `https://api.openai.com` 的，插件启动时
  **自动就地升级**为 `https://api.openai.com/v1` 并打 warn，无需手动迁移；
  自定义端点（聚合网关等）需自行在末尾补 `/v1`（如 `https://gateway.example` → `.../v1`）。
- llm-deepseek：官方端点 `https://api.deepseek.com` 无需改动（无版本段形态本就是官方文档写法，
  `/models` 此前也不带 `/v1`）；指向第三方 `/v1` 网关的需在 `baseUrl` 补 `/v1`。

### mcp-client：桥接工具默认档位不再是 public

外部 MCP 工具此前默认 `public`（等级 0 可达）。现默认改为按工具注解分档：
自称只读（`readOnlyHint`）→ `sensitive`（等级 1）；有破坏提示或未声明 → `restricted`（等级 2）。
server 配置的 `visibility` 字段新增 `auto`（新默认）与 `sensitive` 两值。

**迁移**：需要恢复旧行为（群成员直接可用）的部署，在对应 server 配置里显式设
`visibility: public`；已显式配置 `public`/`restricted` 的不受影响。

### 授权身份（actor）贯穿工具调用链：委派/子任务/工作流不再匿名执行

`ToolCallContext` 与 `ExecutionGuardContext` 新增可选 `actor` 字段（语义同
`IncomingMessage.actor`）：等级裁决与 owner 自动确认跳过按 actor 评估；`platform`/`userId`
恢复**会话/物理**语义（定时任务归属、平台档继承、记忆平台域、confirm 通道选路不再被
发起者平台覆盖）。`delegate_to_session` / `create_subtask` / `send_to_subtask` /
workflow 的 agent 与 send_message 节点现在都会透传发起者授权身份。

**行为变化**：此前这些路径的目标回合以匿名（等级 0）执行；现在以**发起者等级**执行——
依赖"子任务/委派天然低权"的部署需注意。actor 只从执行上下文 snapshot，LLM 无法经
工具入参指定（防提权）；匿名发起者的目标回合仍为匿名。

### user-relation：consolidate「落笔核实况」不变量

真合并删除的节点不再被同 pass 的派生回写（embedding hash / summary / PageRank）复活；
层级判定落边收进唯一入口（端点活性 + 实时查重 + 走门面）。无迁移动作——存量僵尸节点与
重复边会在后续 consolidate 轮次中被正常清理/去重。

## 0.10.0

契约包大改名 + 四个包的破坏性变更。这批**必须显式升级**，装到一半会同时装进新旧两份
同一契约（各带一份 `declare module`，类型一旦分叉就撞 TS2717，且被 `skipLibCheck` 静默吞掉）。

### 契约包改名（30 个旧名已 `npm deprecate`）

命名从「按插件命名契约」改成「按类型分层」：契约是 `api-*`，纯数据 schema 是 `schema-*`，
提供者实现是 `plugin-<类别>-<厂商>`。

| 旧名 | 新名 |
| --- | --- |
| `@aalis/plugin-<X>-api`（25 个） | `@aalis/api-<X>` |
| `@aalis/plugin-config-api` | `@aalis/schema-config` |
| `@aalis/plugin-message-api` | `@aalis/schema-message` |
| `@aalis/plugin-{deepseek,openai,ollama}` | `@aalis/plugin-llm-{deepseek,openai,ollama}` |

**迁移**：包名整体替换即可，导出符号未变。两个例外——

- `plugin-cron-engine-api` 是**拆包不是纯改名**：`CronEngine` / `useCronEngine` /
  `CronSubscribeOptions` 去了 `api-cron-engine`，但 6 个纯函数 + 2 个类型
  （`validateCronExpr` / `normalizeCronExpr` / `matchesCron` / `parseCronField` /
  `parseEverySeconds` / `dateFieldsInTimeZone` / `CronExprKind` / `ValidateResult`）
  去了新包 `@aalis/util-cron`。用到这些的要装两个包。
- **配置里的 LLM 模型引用要一起改**。`ref.provider` 存的是插件包名，`resolveLLMModel`
  拿它拼 `${provider}/${model}` 精确匹配，改名后旧 ref 一律落空。已持久化的会话级模型
  设置（WebUI 会话、`/session set -m`）也存着这个值，配置文件改完不代表会话跟着改。
  症状是「配置指向的模型不存在：<provider>/<model>」，服务其实注册得好好的。

### 破坏性变更

- **`@aalis/core` 0.10.0** —— `ServiceTypeMap` 现在字面为空，扩展点全部靠 `-api` 包的
  declaration merging 填。影响两处：① `ctx.getService('app')` 这类裸调用退化到
  `<T = unknown>` 兜底重载，要显式写类型参数；② 第三方插件的 `getService` 返回类型
  第一次真正受检——此前 core 内部一个相对说明符的 `declare module './services.js'`
  把接口绑到了第二个符号上，所有 `-api` 包的 augmentation 静默失效。修复后原本
  「能编过」的错误用法会开始报错。**只有裸说明符 `declare module '@aalis/core'` 是安全的。**
- **`@aalis/runtime` 0.10.0** —— 删除配置文件里的 `${VAR}` 环境变量插值与 `.env` 机制。
  密钥直接写进配置（配置文件本就不入库）。**这条是本批走 minor 而非 patch 的关键**：
  按 patch 发的话存量 `^0.9.0` 会自动吃到，配置里的 `${OPENAI_API_KEY}` 会变成
  字面量字符串直接发给上游。
- **`@aalis/plugin-authority` 0.10.0** —— ① `restrictedPolicy` 白名单不再救非 owner：
  它此前在「未授权救援」路径上跨身份生效，被封禁的负等级用户也能被捞回来；
  ② 降权即撤销该用户已有的会话级授予，不再等其自然过期。
- **`@aalis/plugin-webui-client` 0.10.0** —— `Operation` 要求 `minLevel`，必须与
  `plugin-authority` 同批升级。

### 其它

- `@aalis/plugin-package-manager` 的 core peer 下界抬到 `>=0.10.0`：它调用
  `restart({ rollback })`，而 0.9.x 的 `restart()` 不收参数、静默丢弃——市场更新失败后
  不会回滚，起来的是坏版本。

---

## 0.9.1

安全收紧与遗留清理。11 个包，其中 7 个有用户可见的行为变化——**权限收紧修的是非预期
的默认值，不是功能变更**，故走 patch。

### 安全（都是「默认 public」这个坑的实例）

- **`/clear` 的保护此前完全失效**：它原先挂在配置键 `visibilityOverrides` 上，该键在权限
  重构中失效（全仓零处读它），而指令注册时无任何 risk/visibility 声明 → 按默认落到等级 0。
  结果是任意 level-0 群成员可清空会话的消息/摘要/向量/图片。现按会话归属分场景：
  私聊 `confirm` 即可（会话归用户本人，清自己的记忆是自助行为），群/频道需等级 2 或 owner。
- **`/clear.all`** 从 `visibility:'restricted'` 改为 `risk:'dangerous'`——原写法拿到了等级 2
  但**漏了确认**，dangerous 一档同时推出两者。
- **`/authority`** 标 `risk:'sensitive'`（会披露他人权限等级）。
- **`plugin-subtask` 的 create/send_to/delete** 标 `sensitive`：每个子任务是一条独立的 LLM
  会话链，不受信任的调用方可连续调用放大 API 开销。只读的 check/wait 保持 public。
- **`plugin-tool-browser` 的 navigate/click/type/close_page** 标 `sensitive`：页面池是进程级
  共享 Map、取页时不校验会话归属，拿到 pageId 就能操作他人（含 owner）已登录的页面。
  只读的 get_text/get_links 保持 public。

新增 `test/plugins/tool-policy-guard.test.ts` 与 `clear-authorization.test.ts`：读**生效策略**
而非源码文本（防护机制异构，只有生效值可信），正反双向钉住——写类退回 public 会红、
只读被误伤也会红。

### 移除（均经对抗验证确认零消费面）

- session 配置的 legacy `model` / `llmProvider` 字段与其折叠逻辑（服务端 30 行 + 前端 13 行）
- `plugin-skills` 的 `skillsDir` → `skillsUri` 迁移分支
- `plugin-file-reader` 的 `fileRetentionMinutes` 配置项（schema 自身已标【已弃用】）
- `plugin-user-relation` 的 `MergeRejectRecord.aReinforcedAt` / `bReinforcedAt` 及孤儿方法
  `listMergeRejects`
- `plugin-webui-client` 中 `SessionConfigData` 的重复定义

### 文档

README 与脚手架模板里「core 在 0.x 内承诺向后兼容」的表述作废（0.7.0 / 0.9.0 均删过公开面）；
`core-contract.md` 增「1.0 之前的实况」一节列出删除清单与版本号语义。

## 0.9.0

本批 58 个包统一版号 `0.9.0`（未改动的包停在原版号）。**升级 core 必须同批升级
runtime 与所用插件**——兼容单位是整组。

### 破坏性变更

**`@aalis/core` 删除的公开面**

| 删除 | 替代 |
|---|---|
| `CORE_CONFIG_SCHEMA`、`ConfigSchema`、`SchemaField`、`SchemaFieldType`、`SchemaFieldTypes`、`SchemaGroup`、`SchemaArray` | 全部迁至新包 `@aalis/plugin-config-api`，import 改指该包 |
| `ctx.hasService(name)` | `ctx.getService(name) !== undefined` |
| `ctx.getServiceEntries(name)` | `ctx.getAllServices(name)`（返回项现含 `priority`） |
| `ctx.once(event, fn)` | `const off = ctx.on(e, (...a) => { off(); ... })` |
| `PluginManager.createInstance` / `removeInstance` | `register(module, config, instanceId)` + `unload(instanceId)` 组合；配置文件编排由调用方负责 |
| `ServiceContainer.has` | `get(name) !== undefined` |
| `EventBus.removeAll` | 无替代（绕过 dispose 链的所有权账本，刻意移除） |
| `ConfigManager.syncPluginDefaults`、`ConfigManager.trimUnknownFields`、`AppOptions.configSync` | 迁至 `@aalis/runtime` 的 `syncPluginDefaults` / `installConfigHotReload`；`startAalis({ configSync })` |

`PluginStatusEntry` 不再携带 `config` / `configSchema` / `defaultConfig`——它们是配置详情
不是内核状态，改由 `getPlugin(instanceId)` 从 `entry.config` / `entry.module` 读取。

**契约包删除的 helper**（均为 `ctx.getService` 的一行包装，无附加语义）：
`@aalis/plugin-asr-api` 的 `useASRService`、`@aalis/plugin-media-api` 的 `useMediaService`、
`@aalis/plugin-workflow-api` 的 `useWorkflowService`。直接用 `ctx.getService('asr' | 'media' | 'workflow')`。
（包名是当时的；这三个契约包后来分别改名为 `@aalis/api-asr` / `api-media` / `api-workflow`。）

**`declare module` 目标变更**：向 `SchemaField` / `SchemaFieldTypes` 做 declaration merging 的
包，目标从 `'@aalis/core'` 改为 `'@aalis/plugin-config-api'`。**merging 到旧目标不会报错，
只会静默失效**，务必检查。

### 新增

- **新包 `@aalis/plugin-config-api`**：配置表单词汇（`ConfigSchema` 全家 + `SchemaFieldTypes`
  扩展点 + `CORE_CONFIG_SCHEMA`）。零依赖纯类型包。依赖它请用宽区间
  `>=0.9.0 <1.0.0` 而非 caret——0.x 的 caret 锁死 minor，会在加词汇时强制全生态级联重发。
- **第四内核原语「贡献点」**：`ctx.contribute(point, spec)` / `ctx.collect(point)`。
  多方向同一产物各交一块，内核保证 id 幂等、`(槽, 全局键)` 确定性排布、单块错误隔离，
  且**从不执行插件代码**。首个贡献点 `agent:prompt`（提示词组装）。
- **`ctx.hooks` 摊平为 `ctx.runHook(hook, data, defaultAction?, opts?)`**：六动词对称
  （on/emit、provide/getService、middleware/runHook），不再发布可持有的对象句柄。
- **可等待的异步 dispose**：`ctx.disposeAsync(timeoutMs?)`，`onDispose` 返回的 promise
  真正被等待（逐项超时护栏防卡死停机）。已有拆卸在飞时 join 而非早退。
- **前缀缓存命中上报**：`ChatResponse.usage.cachedPromptTokens`（DeepSeek 的
  `prompt_cache_hit_tokens` / OpenAI 的 `prompt_tokens_details.cached_tokens`）。
  `undefined` = 不可知，`0` = 明确无命中，勿用 `?? 0` 抹平。

### 修复

- **自动摘要压缩静默失效**：历史探测条数曾写死 200 并兼作阈值判定样本，导致
  `threshold > 200` 的配置下压缩分支永不进入、零日志。改为由配置推导且保留原下限。
- **停机竞态**：`App.stop()` 撞上在飞的 bounce/unload 时，shutdown 请求被单飞排队后立即
  返回，拓扑逆序编排落空，下游插件的落盘可能写进已关闭的连接。现在先等状态机静置。
- **贡献点两条守卫**：已 dispose 的 Context 上 `contribute` 被拒（否则会顶掉同 id 活实例的
  条目并被连带删除）；退订时摘除登记表条目（否则动态 id 场景无界增长）。
- **流式 usage 丢失**：`if (!delta) continue` 排在 usage 提取之前，导致挂在 `choices: []`
  收尾帧上的 usage 整帧被跳过。两家适配器均已修正顺序。

### 升级须知

1. **只升 core 不升 runtime 会静默丢三项**：`aalis.config.yaml` 的 defaultConfig 回填、
   schema 外字段裁剪、配置文件热重载。不报错、不崩、插件功能正常，但配置文件不再被维护。
2. **旧插件 + 新 core 会炸**：以下已发布版本调用了被删 API，需同批升级到 0.9.0——
   `plugin-webui-server@0.5.2`（加载期失败）、`plugin-tool-system@0.5.2`、
   `plugin-session-manager@0.5.3`、`plugin-office@0.5.0`（三者激活期失败）、
   `plugin-commands@0.5.4`、`plugin-media@0.5.3`（运行期失败）。
3. **第三方插件**：core peerDep 建议写 `>=0.9.0 <1.0.0`（若用了 0.9 新 API）。
   本仓禁用 caret——`^0.x` 只匹配单个次版本，会把插件锁死。
4. **1.0 之前 core 的公开面可能在次版本被删**（0.7.0 与 0.9.0 均已发生）。宽 peerDep 区间
   只是「没用新 API 的插件不必随次版本重发」的便利，不是兼容性承诺。
