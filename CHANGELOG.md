# Changelog

本文件只记录**破坏性变更与迁移路径**。逐包的完整改动见 git 历史。

版本号语义：core 在 1.0 之前，次版本（`0.x.0`）可含破坏性变更并在此列出迁移路径；
补丁版本（`0.x.y`）只做修复与加法。1.0 之后按标准 semver，稳定性条款见
[`docs/design/core-contract.md`](docs/design/core-contract.md)。

---

## 未发布（core 0.17.0 → 0.18.0；101 个包：89 minor / 6 patch / 6 新包 api-plugin-source、api-host-config、api-hooks、api-contributions、plugin-hooks、plugin-contributions）

core 只做插件的注册、激活、关停与两种原语（事件、服务）。插件从哪里来、配置存在哪里由宿主负责；钩子与贡献点改为普通插件提供的服务。同批各包删除对旧数据、旧配置与弃用接口的兼容，删除无人使用的公开接口，并收紧若干安全默认值。升级前请先读末尾「版本与必须同批升级的包」一节。

### 插件发现外迁到 runtime（@aalis/core、@aalis/runtime、新包 @aalis/api-plugin-source）

- core 删除 `AppOptions.pluginLoader`、`App.autoLoadPlugins()`、`App.rescanPlugins()`、`AppService.rescanPlugins` 与 `PluginLoader` / `PluginDescriptor` 类型；这两个类型改由 `@aalis/runtime` 导出。`pluginDefinitionOf` 从 core 包根移到 `@aalis/api-plugin-source`。
- 新增 `app.pluginAll(items)`：整批同步落账后只重算一次，依赖方在同一次重算里排在它 required 服务的全部提供者之后激活，不会先挂到先登记的后备提供者上。条目为 `{ definition, config?, instanceId?, disabled? }`，返回值逐项对应。
- 拓扑排序里同时就绪的插件按登记序激活。这条规则对所有重算生效：冷启动与提供者重启后的重新激活走同一个确定次序。可见影响：memory-history、memory-summary、message-archive、session-manager、memory-vector 的激活次序后移；`agent:turn:after` 与 `memory:clear` 两条钩子链、`outbound:message` 与 `token:usage` 两个事件上的监听次序随之改变；工具表里 memory-history、memory-vector 的工具位置改变，升级后第一轮提示前缀缓存失效一次。
- runtime 新增 `createPluginDiscovery(app, loader, doc)`（冷启动 `loadAll`、热扫描 `rescan`）；`startAalis` 在根上独占提供 `plugin-source` 服务。`rescan()` 返回本次新登记的主实例名（定义名）。
- 市场与 WebUI 经 `optional(pluginSource)` 热扫描。宿主不提供插件来源时，市场视同本次没有新插件，WebUI 扫描接口返回 503。

**迁移**：自组装宿主改为 `createPluginDiscovery(app, loader, doc).loadAll()`，或直接 `app.pluginAll(...)`。自定义加载器的 `PluginLoader` / `PluginDescriptor` 类型改从 `@aalis/runtime` 导入。插件包入口判定改从 `@aalis/api-plugin-source` 导入 `pluginDefinitionOf`。需要热扫描的插件在 `uses` 里声明 `optional(pluginSource)` 后调 `rescan()`。runtime 包入口引入 node 模块，非 Node 宿主要自己实现这层发现驱动。

### 配置文档外迁到 runtime（@aalis/core、@aalis/runtime、新包 @aalis/api-host-config）

- core 不再持有配置文档，只持三样运行态：各实例的配置、禁用态、服务偏好。删除 `ConfigManager` / `ConfigProvider` / `AalisConfig`、`App.config`、`AppOptions.config` / `configProvider` / `pluginDefaults`、`AppService.saveConfig`、`hostConfig` 描述符与 `HostConfig` 类型。`AppOptions` 新增可选的 `name`（启动横幅）与 `logLevel`（默认 Logger 级别）。
- `app.plugin(definition, config?, instanceId?, { disabled })` 与 `plugins.register` 同形：传入的配置原样生效，core 不再合并「宿主 `pluginDefaults` ← 配置文件 ← 传入」，也不再读禁用名单，禁用态由调用方传入。
- 管理动作（`plugins.enable` / `disable` / `updateConfig` / `bounce`）只改运行态，不再写配置文档。要跨重启保留，调用方在动作成功后经 host-config 写文档再 `save()`；WebUI 的启停与改配置路由、mcp-client 的自服务开关已这样做。
- 新包 `@aalis/api-host-config`：`AalisConfig`（各域配置字段的 declaration merging 目标）、`HostConfig`（文档读写面加 `save()`）与 `hostConfig` 描述符，服务名仍是 `host-config`。`save()` 兑现即已落盘；失败时以拒绝传出，并已记一笔 error、标记为已处理。
- runtime 新增 `createConfigStore(initial, provider?)` 与 `installHostConfig(app, store)`（独占登记 host-config、应用文档里的服务偏好）；`ConfigProvider` 类型改由 `@aalis/runtime` 导出。`syncPluginDefaults` / `handleConfigChanged` / `installConfigHotReload` 改收 `store` 参数，`withPluginConfigSync(loader, app, store, opts)` 改为导出。`startAalis` 的装配序为：文档 → App → host-config → 加载政策 → 发现 → 热重载；热重载在 `app:stopping` 时停止监听。
- authority、cli、mcp-client 删去只为落盘而声明的 `app` 依赖，改用 host-config 的 `save()`；webui-server 与 package-manager 同样改用 `save()`。host-config 不再由 core 保证在场：plugin-authority 缺它时激活失败；cli、package-manager 降级；mcp-client 的 `mcp_set_server_enabled` 不改动运行态并返回失败；WebUI 读写文档的路由与服务偏好路由返回 503。市场依赖图与 WebUI 服务页把根上的提供者标为「宿主」。

**迁移**：
- `hostConfig` / `HostConfig` 改从 `@aalis/api-host-config` 导入；`appService.saveConfig()` 改为 `hostConfig.save()`。
- 向 `'@aalis/core'` 增广 `AalisConfig` 的，改为 `declare module '@aalis/api-host-config'`。
- 直接调管理动作又要持久化的插件，动作成功后自己写文档并 `save()`。
- 自组装宿主：`const store = createConfigStore(config, provider); const app = new App({ name: store.get('name'), logLevel: ... }); installHostConfig(app, store);`，登记插件时按文档传配置与 `{ disabled }`。默认值须深合并进配置（`withPluginConfigSync` 即此政策），不能顶层浅合并：只写了半块的嵌套组会把默认值整块顶掉。自定义配置来源的 `ConfigProvider` 类型改从 `@aalis/runtime` 导入。
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

### 契约包：删除与新增的公开面（@aalis/api-tools、@aalis/api-storage、@aalis/api-media、@aalis/api-commands、@aalis/api-webui、@aalis/api-doctor、@aalis/api-embedding、@aalis/api-agent、@aalis/api-persona、@aalis/schema-message、@aalis/schema-log）

- api-tools：删除 `asToolExecutionResult`。`ToolService.execute` 自 0.8.0 起一律返回 `ToolExecutionResult`。
- api-storage：`StorageService.move` / `mkdir` 从可选改为必填。新增 `isStorageNotFound(err)`：有 `code` 时只认 `'ENOENT'`，没有 `code` 才退回文案匹配；`readFile` 等按路径定位的方法约定目标不存在时抛 `code: 'ENOENT'`，其它失败不得用这个 code。`createStorageGateway` 的返回类型收窄，`resolveLocalPath` / `readFileRange` / `watch` 变为必有。网关路由失败时区分两种报错：根已注册、但没有提供者满足所需能力（如在只读根上写入）时报「存储根 X 不支持 write」，只列出缺少的能力；根名未注册时报「未知存储根: X（已注册根: …）」，不再附「需能力 […]」。
- api-media：`MediaService.rememberDescriptionAlias` 改为必填。删除 `TranscribeOptions.prefer`、`TranscribeOptions.withTimestamps` 与 `DescribeVideoOptions.maxTokens`，实现从未读取过它们。`describeImage` 的契约说明改正为识别出错时抛出（行为未变，此前文档写错）。
- api-commands：删除 `OptionSpec.takesValue`。
- api-webui：删除 `WebUIService.setClientDir` 与 `WebuiClientProvider.label`。
- api-doctor：删除 `CheckSpec.label`（从未被读取）。
- api-embedding：`EmbeddingService` 新增可选的 `readonly modelId`（向量空间标识：同值即向量可比，换模型必须换值）。
- api-agent：`agent:reply:before` 的数据新增可选字段 `visibleContent`。
- api-persona：`PersonaSessionOptions` 新增可选字段 `systemPromptExtra`。
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
- plugin-authority 读取 users.json 期间（storage 晚于本插件上线时的首次读取，以及 storage 重新上线触发的重读）发生的等级改动不再立即写盘，改为读完、与文件里的记录合并后再落盘，停机与卸载会等这次落盘完成。此前首次读取期间的一次改动会用只含这条改动的快照覆盖整个 users.json，重读期间的改动会覆盖读不懂的 users.json。读取期间改的若是文件里已有的用户，合并时以文件里的值为准，这次改动不会保留。读取过程出现意外异常（如存储抛出无法转成字符串的错误值）时按读不懂处理，本次运行拒写。
- plugin-flow-control：禁言表 `data:/flow-control-mutes.json` 读不出、坏 JSON 或顶层不是对象时不再整表覆盖；storage 换人后重读成功即恢复落盘。optional 的 storage 晚于本插件上线时，读回的禁言表与内存里已有状态按较晚到期合并。
- plugin-scheduler：动态任务文件读失败（含激活时 storage 不在场）、解析失败或合法 JSON 但不是数组时，本次运行不写该文件。
- plugin-workflow：运行历史文件读失败（含激活时 storage 不在场）、解析失败或结构不对时，本次运行拒写该文件，也不安排任何 once 触发（含 runAt 在未来的）。0.11.x 及更早写出的顶层数组格式同样按读不懂处理。列定义目录报错带非 `ENOENT` 的 code 时按扫描失败处理，不再据此清空 once 记账。
- plugin-vectorstore-flat：`vectors.json` 读不出、解析失败或不是数组时，本次运行按空库在内存中工作且不再写入，`clear` 也不写。此前文档写明的「坏文件不影响后续写入」不再成立。
- runtime：保存配置文件前比对盘上内容，手改尚未生效或另一个进程写过时拒绝本次保存，报「配置文件有尚未生效的外部修改，为免覆盖已拒绝本次保存（<路径>）」，不再静默覆盖手改；拒写只记一条告警。拒写之后调用方的文档已领先于文件，下一次文件变更即使内容与上次生效的那份逐字节相同（例如把改坏的文件原样改回）也照常热重载，按文件重新对账。监听武装后立即对账一次；平台不支持文件监听时告警，此后手改需重启才生效。
- 统一判据后，tool-system 的 `file_append`、checkpoint 回滚删除遇到带非 `ENOENT` code 的错误时如实报错。

**迁移**：
- 出现上述告警时修复或移走对应文件后重启。workflow 的 once 也可以用 `workflow_run` 手动执行。
- `users.json` 仍是 v1–v4 格式的，删除或移走该文件后重启，即按全新开始。
- `/level` 回复或 WebUI 提示带「仅本次运行生效」附注时，按日志修复或移走 users.json 后重启，再重做这些等级改动。storage 晚于 authority 上线、且在启动窗口里改过等级的旧版本部署，核对 users.json 是否缺了原有记录。
- `workflow-runs.json` 顶层是数组的，改成 `{"runs": <原数组>}` 或删除。
- 遇到配置保存被拒时，等热重载吸收手改或修正配置语法后重做该操作；进程没有监听配置文件时（子命令进程、平台不支持监听）重启后再做。直接调用 `createFsYamlConfigProvider().provider.save()` 的自定义宿主须接住这一抛错；经 host-config 的保存会记 error 日志。

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
- plugin-mcp-server 的 `toolGroups` 改为分组名字符串数组（WebUI 用多选加自定义项编辑）。值不是数组或含非字符串元素时记 error 且不监听，不再兼容 `[{ name }]`。`['']` 现在按字面组名处理、什么都不暴露（此前等于全部暴露）。

**迁移**：
- mcp-client：字符串形态的 `args` 改写为数组。旧规则先按行、再按空白切分，所以 `"-y @scope/pkg"` 与 `"-y\n@scope/pkg"` 都改为 `["-y", "@scope/pkg"]`。`env: "KEY=VALUE"` 改为 `{ KEY: "VALUE" }`，`#` 注释行删掉。旧 WebUI 留下的 `args: ''` / `env: ''` 删掉该键，或改为 `[]` / `{}`，也可以在新版 WebUI 打开 mcp-client 的配置保存一次。配置顶层写了 schema 以外字段的，启动时会被裁掉并告警。
- mcp-server：`toolGroups: [{ name: search }]` 改为 `[search]`；全部暴露写 `[]` 或 `['*']`；裸 `'*'` 与 YAML 裸键 `toolGroups:` 改为 `[]` 或 `['*']`。
- 自行实现配置表单宿主的第三方需要支持 `list` / `map`；对字段类型做穷尽 switch 的代码会编译报错，补上分支。

### 未装 plugin-authority 时拒绝受限能力（@aalis/plugin-tools、@aalis/plugin-commands、@aalis/plugin-tool-onebot）

- 工具与指令的执行守卫缺席时改为 fail-closed：声明了 `confirm`，或按 `capabilityMinLevel` 定级高于默认等级的能力（一般即 restricted，或 risk 为 sensitive / dangerous）一律拒绝，提示「需要权限校验或确认，但未安装权限插件 @aalis/plugin-authority，已拒绝执行」；其余照常执行。指令按整条点路径取最严的声明：未装 authority 时 `/clear`、`/clear list`、`/clear all`、`/shutdown`、`/restart` 等不可用，`aalis <子命令>` 一次性模式同样适用。此前守卫缺席时一律放行。
- plugin-tool-onebot：`sessionHistory.enabled=false` 只关两个 OneBot 专属历史工具，`allow*` 会话历史访问规则始终生效。此前关掉该开关会连带撤掉访问规则。访问规则改为跟随 tool-session 提供者注册：此前 tool-session 重启或晚于 `app:ready` 上线后规则会静默丢失，群聊可读私聊历史。OneBot 平台晚于 `app:ready` 上线时也会补注册工具。

**迁移**：需要受限工具或指令的部署安装 `@aalis/plugin-authority`（create-aalis 的 minimal 及以上各档已包含）。嵌入式宿主或测试可自行 `setExecutionGuard`。想保留 tool-onebot 旧行为，把对应 `allow*` 设为 true。

### 市场装卸与 WebUI 接口（@aalis/plugin-package-manager、@aalis/plugin-webui-server、@aalis/plugin-webui-client）

- 市场安装前经 `npm view <spec> keywords --json` 检查类型关键词，只放行带 `aalis-plugin` 或 `aalis-interface` 的包；内核、宿主、契约、schema、工具库类包被拒，并提示改用「更新所选」。
- 市场安装压掉 `legacy-peer-deps`（与更新预检同口径）：用户或项目 `.npmrc` 里的 `legacy-peer-deps=true` 不再作用于市场安装，peer 冲突时安装失败并列出冲突。
- 服务依赖者卸载闸从 WebUI 路由移入 package-manager 服务层；`PackageManagerService` 新增必需方法 `serviceDependents(name)`，市场卸载前预警改调它。被服务依赖阻断的卸载由 HTTP 409 改为 200 加 `{ ok: false, message }`。卸载成功消息与两个卸载确认弹窗提示：插件写入 data/ 等存储根的数据不会删除。
- 删除 `GET /api/logs`，改调 `GET /api/logs/tail`（默认 200 条，结果相同）。
- `GET /api/status` 的响应不再包含 `services` 布尔表。webui-server 不再以可选依赖声明 memory 服务，WebUI 依赖展示里不再列出 memory。
- persist 模式的访问令牌改为经 storage 跟随读回：storage 晚于 WebUI 上线时不再生成新令牌。
- 启停插件、修改插件配置、新建或删除实例、设置或清除服务偏好的接口，在改动已生效、但保存配置文件失败（如文件里有尚未生效的外部修改而被拒写）时返回 409 与 JSON `{ error, applied: true }`，此前是 Express 默认的 HTML 500。`applied: true` 表示改动已在运行态生效、没有写进文件：修好配置文件后，插件配置随热重载回到文件里的值，没写进文件的新建实例随热重载卸载；启停、删除实例与服务偏好在重启时以文件为准。全局配置（`PUT /api/config`）保存失败时撤回文档里的改动并返回 409 `{ error }`（不带 `applied`），此前返回 500 且改动留在文档里，会被下一次任意保存写进文件。
- 权限管理页的操作提示改为显示服务端返回的回执，回执缺 `message` 时才用本地文案；提示停留时长按字数计算，至少 2.2 秒。例如撤销已不存在的临时委托时显示「不存在或已过期」，不再误报「已撤销」。
- 会话历史里的附件引用改为按文件名之后的固定格式定界剥离：文件名含半角括号或方括号（如 `report (1).txt`、`data [v2].csv`）时，内联文件正文、大文件引用（含早期的单行格式）、超限、处理失败与降级引用都整块隐藏，用户气泡里不再露出文件正文、文件 ID 或「说明：…」残片；大文件引用之后的图片描述不再被一并隐藏。

**迁移**：
- 依赖 `legacy-peer-deps` 才能从市场装上的插件，先升级冲突的包解决 peer 冲突；不要用 `--legacy-peer-deps` 绕过。
- 自己实现 `PackageManagerService` 的第三方补上 `serviceDependents`。按状态码判断卸载被拒的脚本改为读响应的 `ok` 字段。
- 自写客户端收到带 `applied: true` 的 409 时按「已生效、未落盘」处理，不要重试；服务偏好接口原有的 409（提供者拒绝该偏好）不带 `applied`。
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

**迁移**：
- 要 community_overview 旧结果，调用时显式传 `algorithm: 'louvain'`。
- 经 `POST /api/page-action/:plugin/:method` 按名调用被删页面动作的脚本，改用 Agent 工具（`user_relation_expand_node` / `user_relation_find_path` / `user_relation_search_events` / `user_relation_delete_edge` 等）或 `/relation` 指令。
- 被删服务方法的替代：`getPerson(platform, userId)` → `(await service.getNeighborhood('<platform>:<userId>')).person`，或在 `loadAll().persons` 里查找；`findEntityByName(name)` → 已知 kind 时用 `findEntityByKindAndName(kind, name)`（只比对 name、不看 aliases），跨 kind 或按别名查找时在 `loadAll().entities` 上自行比对；`findPersonEntityEdge` / `findPersonEventEdge` → 在 `loadAll().edges` 上按 kind、端点与 role 筛选；`deleteEdge(edgeId)` → `deleteEdgeWithGuard({ edgeId, reason })` 或 `correctEdge({ edgeId, action: 'remove', reason })`，两者都带保护（alias 边禁删；前者拒删 weight ≥ 0.8 或 evidence ≥ 5 的边，后者要求 weight < 0.5），已没有无保护的公开删边方法；`triggerExtraction` / `setTriggerExtractionHandler` 无替代。
- 读 `crossCommunityDegree` 的改用 `communityWeights.length`。
- 旧版留下的悬空 is-alias-of 边：`evictionEnabled` 开启（默认）时随提取后的自动清理移除，关闭的运行一次 `/relation cleanup orphans` 或 `/relation maintain`。
- 向量重算无需手动操作；使用计费 embedding API 的实例会看到一次性的调用量上升。

### agent、persona 与记忆（@aalis/plugin-agent、@aalis/plugin-persona、@aalis/plugin-memory-vector、@aalis/plugin-memory-summary、@aalis/plugin-user-profile）

- 并行工具批次里单个工具的钩子、守卫或结果处理抛错，只让该工具失败并转成它自己的错误结果，同批其它工具照常落定；执行前与执行后的失败分别给出结果，执行后的失败明说「已执行」。`agent:tool:after` 钩子失败时不回退到原始结果（fail-closed），原始输出不交给模型。
- 在提交点之前被 latest-wins、手动停止或拆卸中止的回合，不再落库、不再外发。
- 上游返回空流时也按 persona 的要求重试。
- 会话配置的额外系统提示（`SessionConfig.systemPromptExtra`，WebUI 的「额外提示」）开始生效：agent 透传给 persona，追加在人设提示之后、结构化输出格式说明之前；未装 persona 时不生效。
- persona 不再搜索 `configDir:/personas`，只在 `personasDir`（默认 `data/personas`）查找人设卡。`personasDir` 的配置说明改正为 storage URI 口径（解析方式未变）：不含 `:/` 时首段视为存储根名，单段裸名归 `data` 根。scheduler 等合成回合按 sessionId 约定推断会话类型，只用于提示词、不回写消息；子任务会话（`<父会话 id>::<后缀>`）不推断。
- persona 的非主卡 `outputFormat` 改为按卡缓存：显示名相同的两张卡不再共用格式，热改非主卡的 `outputFormat` 后无需重启即生效。
- 结构化输出（persona `outputFormat`）落库时，assistant 消息的 metadata 带解码后的可见正文（`visibleContent`），只在它与落库内容不同时写入。memory-vector 建索引、扩窗与召回的渲染优先读它，memory-summary 的摘要输入同样优先读它，JSON 信封与状态字段不再进入摘要；升级前落库的消息没有这个键，仍按原文呈现。
- memory_recall 在 `crossSessionMode=user` 下与被动注入一致，对当前用户本人发言或被 @ 的命中乘 `search.userPriorityBoost`（此前工具路径不加权）；回合中止信号传给查询 embedding 与扩窗取数。
- memory-summary：`keepRecent` 大于 `threshold`、历史条数介于两者之间时，自动摘要不再每轮重复摘要同一批消息；与 `session:compress` 一致，历史不多于 `keepRecent` 时不摘要。`session:compress` 路径的日志文案改为「会话已压缩 / 会话已裁切（无摘要）」。
- user-profile：记忆后端读取档案或指令出错时，关系分更新、事实提取、自反思、指令提取以及 `/profile forget`、`/instruct add`、`/instruct remove` 放弃本次写入，这三条指令回复「添加失败」或「删除失败」及原因。此前读错按「无档案」处理，随后以空档案覆盖写回，一次瞬时读错即可清空整份档案或指令表。只读展示（提示注入、`user_profile_lookup`、`/profile`、`/instruct` 等）读失败仍按暂无档案处理。

**迁移**：
- 自写 `agent:tool:before` / `agent:tool:after` 钩子的第三方：抛错现在只让当前工具失败（`agent:tool:before` 抛错等于拦截该工具），同批其它工具照常落定。
- 放在 `configDir:/personas` 的人设卡移到 `personasDir`。按旧说明把 `personasDir` 写成相对项目根路径的，改写为 storage URI（如 `data:/personas`），或把人设卡移到该值实际指向的存储根下。
- 要恢复 memory_recall 旧排序，把 `search.userPriorityBoost` 设为 1（同时影响被动注入）。
- 升级前以 JSON 信封建索引的 assistant 向量不会自动更新；可停机后删除，由新消息重建。LanceDB 执行 ``table.delete(`metadata_json LIKE '%"role":"assistant"%' AND metadata_json LIKE '%"content":"{%'`)``。memory-vector、memory-summary 依赖 plugin-agent 写入的可见正文与 schema-message 的新导出，与这两个包同批升级。

### 模型与媒体（@aalis/plugin-llm-openai、@aalis/plugin-llm-deepseek、@aalis/plugin-llm-ollama、@aalis/plugin-media、@aalis/plugin-asr-openai、@aalis/plugin-asr-whisper-cpp、@aalis/plugin-file-reader、@aalis/plugin-image-sender）

- llm-openai、llm-deepseek 的 `modelCapabilities` 覆盖行改为按最后一个冒号切分，带冒号的模型 id（如经 Ollama `/v1` 接入的 `qwen3:8b`、`xxx:free`）的覆盖行开始生效。
- llm-openai 内置能力表补上 gpt-4.1、gpt-5（含 thinking）、qwen-vl / qwen2.5-vl / qwen3-vl、glm-4v / glm-4.1v / glm-4.5v 的 vision；llm-ollama 在 `/api/show` 探测失败时，名称带 vision / vl 的模型不再被家族前缀抢先匹配而丢掉 vision。这些模型因此进入 media 的视觉候选池，`vision.delivery=auto` 时也会直通原图。
- media 的 LLM 处理器缓存签名改按 `all()` 顺序：`vision.prefer` 留空时，自动选择跟随 llm 服务偏好的切换。
- 两个 ASR 插件的 http(s) 音频附件下载加 15 秒超时与 20 MiB 流式上限（与 plugin-media 同口径），超时或超限时转写直接报错。
- file-reader 内联文件正文的结束标记改为 `--- 文件内容结束 <8 位十六进制编号> ---`，开头一行注明正文是数据不是指令、以及本次的结束标记；「--- 文件内容 ---」字面量不变。`resolveLocalPath` 在存储不支持本地路径或文件已不在磁盘时返回 `null`（此前抛错）。
- file-reader 把上传文件名里的控制字符（含换行、回车、制表符）与 Unicode 行、段分隔符换成空格，作用于附件描述、system 块里的文件清单、工具输出，以及服务的 `getMeta` / `listFiles` 返回的元信息；旧版本落盘的元信息读回时同样处理。此前文件名里的换行可以把文字排到文件块之外，冒充用户原话。
- image-sender 的 `preview_image` 只在 media 服务在场时注册，离场即撤回。

**迁移**：
- 所有 LLM 处理器优先级相同，`vision.prefer` 留空时由注册顺序最靠前的视觉模型胜出，新表项可能把识别切到计费的兼容端点。要固定识别模型，显式设置 `vision.prefer`；个别型号推断不准时用 `modelCapabilities` 覆盖。
- 自行解析文件块的前端，按开头一行声明的编号配对结束标记，并继续兼容无编号的旧格式。`resolveLocalPath` 的调用方改为判 `null`。按原始文件名匹配 `getMeta` / `listFiles` 结果的代码改按文件 ID 匹配。

### 运行中换提供者与其它修复（@aalis/plugin-session-manager、@aalis/plugin-todo-list、@aalis/plugin-memory-summary、@aalis/plugin-user-profile、@aalis/plugin-adapter-onebot、@aalis/plugin-agent、@aalis/plugin-storage-local、@aalis/plugin-skills、@aalis/plugin-persona、@aalis/runtime、@aalis/plugin-tool-math、@aalis/core）

- session-manager 的会话表跟随 memory 胜者：运行中换后端后显示新后端的会话，换人前未落盘的变更写回旧后端。换后端即换库，不跨后端合并。
- todo-list、memory-summary、user-profile 一次操作只绑定开头取到的 memory 实例：WebUI 切换 memory 偏好时，不再出现 A 被裁剪、摘要写进 B，或把 A 的整张事实表写进 B 的情况。todo-list 有 memory 时每次读当前胜者。
- adapter-onebot 合并转发的媒体落盘与 agent 在没有 media 时读回落盘图片，改走 storage 网关按根路由：此前多根部署下写 `data:/` 会被胜者根（通常是 workspace）拒绝，转发里的图片退回会过期的原始 URL。
- adapter-onebot 展开合并转发时，嵌套转发段的 id、系统提示行里的转发 id 与节点发送者 id 也剥除 NUL：外部消息无法再经转发 id 伪造或搬运其它媒体的识别描述，发送者 id 里的 NUL 也不再带进行前缀与参与者名单。
- storage-local 关闭时关掉 `storage.watch` 建的监听器；skills 与 persona 的目录监听改为跟随 storage 提供者，提供者重启、改配置换目录或晚于 `app:ready` 上线时重挂监听并重新扫描。
- skills 与 persona 的目录重扫改为串行：同一时刻只跑一次，进行中再触发只排一次尾随重扫。persona 扫描期间新增的卡不再被并发的旧扫描剔除。skills 扫完后整体替换技能缓存，扫描期间读到的是上一版完整列表，扫描失败时保留上一版，不再出现并发扫描造成的虚假「重复 skill 名称」告警；任何一次重扫（含 `load_skill`、`list_skills` 的按需重扫）都会作废已编译的 triggers，改过的触发正则随之生效；扫描进行中经服务创建、更新、删除的技能与附属文件，不再被扫描收尾的整体替换盖掉（写入时排一次尾随重扫）。`SkillsService.rescan()` 在扫描进行中被调用时，等尾随那次重扫完成后返回。
- runtime 冷启动时对 `plugins` 下找不到插件的单实例配置段逐段告警一次：「配置段 "<键>" 对应的插件未找到，已忽略；若已卸载可删除该段（其中可能含密钥）」。
- runtime 配置热重载以文件为准处理后缀实例：`name:suffix` 实例在配置文件里没有配置段时（手动删掉了，或拒写期间经 WebUI 新建、没写进文件），热重载时卸载该实例，与冷启动只登记文件里有配置段的后缀实例一致。此前热重载会把它的运行态配置换成 schema 默认值（没有默认值时为 `{}`），并把默认值作为新配置段写回文件。主实例不受影响。
- tool-math 的 `math_calculus` 单次调用的求值总时长上限为 2 秒，超时返回「计算超时（超过 2 秒），请简化表达式」（integral 为「…请简化表达式或减小 n」）；integral 的分段数 `n` 最大 1000000，超出直接返回错误。此前昂贵的表达式配上大 `n` 或迭代求根会同步占住事件循环，长时间卡住整个进程。
- core 的 `DefaultLogger` 渲染附加参数时不再抛错：JSON 序列化与转字符串都失败的对象（如带循环引用或 BigInt 字段的 null 原型对象）输出 `[object Object]`；渲染过程本身抛错（已撤销的 Proxy、`stack` getter 或 Proxy 陷阱抛错）或结果转不成字符串（如 `Error.stack` 被赋成 null 原型对象）的参数输出 `[无法渲染的参数]`，其余参数照常输出。此前这些参数会让日志调用本身抛错，在 catch 与拆卸路径里盖掉原本要记的错误。`toJSON` 返回 `undefined` 的对象，由输出空串改为输出 `undefined`。

**迁移**：
- 直接 `npm uninstall` 过插件的部署，按告警删除残留配置段。
- `startAalis`（或自行接了 `installConfigHotReload` 的宿主）下，插件或宿主代码里以 `name:suffix` 登记、配置文件里没有配置段的实例，会在任何一次配置热重载时被卸载；要保留的，先经 host-config 写入配置段并 `save()`，再登记。文件里新加的后缀实例仍需重启，或调用 WebUI 服务端的 `POST /api/plugins/scan`，才会登记。
- 依赖 `math_calculus` 更大积分分段数的，改用 1000000 以内的偶数，或简化表达式。

### 包清单元数据（41 个包）

各包 `package.json` 里的 `aalis.types`、`aalis.util`、`aalis.core`、`aalis.tooling` 已移除，当前框架不读取它们（加载器与市场早已只看 keywords）。`aalis.service` 与 `aalis.client` 不变。

**迁移**：外部脚本若靠这些字段识别包类型，改看 `keywords`：契约包 `aalis-api`，schema 包 `aalis-schema`，工具库 `aalis-util`，内核 `aalis-core`，宿主 `@aalis/runtime` 为 `aalis-runtime`。脚手架 `create-aalis` 与 `create-aalis-plugin` 没有对应的类型关键词，按包名识别。

### 版本与必须同批升级的包

本批共 101 个包：89 个 minor、6 个 patch、6 个新包。所有随本批发布、带 core peer 的包，peer 下限统一为 `>=0.18.0 <1.0.0`（schema-message 的 core peer 只为类型声明，仍为 `>=0.2.0`）；包间依赖的下限抬到本批的新版本。api-code-sandbox、plugin-code-sandbox-os、plugin-maimai、plugin-process-local、plugin-tool-code-runner 本批无改动，沿用已发布版本。

- 基础（minor）：core 0.18.0、runtime 0.14.0、schema-config 0.13.0、schema-log 0.2.0、schema-message 0.9.0
- 契约包（minor）：api-agent 0.9.0、api-asr 0.11.0、api-authority 0.10.0、api-commands 0.7.0、api-cron-engine 0.7.0、api-doctor 0.7.0、api-embedding 0.7.0、api-flow-control 0.7.0、api-gateway 0.7.0、api-llm 0.12.0、api-media 0.11.0、api-memory 0.7.0、api-message-archive 0.7.0、api-persona 0.8.0、api-platform 0.8.0、api-process 0.8.0、api-session-confirm 0.7.0、api-session-manager 0.10.0、api-storage 0.7.0、api-tool-session 0.7.0、api-tools 0.10.0、api-vectorstore 0.7.0、api-webui 0.11.0、api-workflow 0.11.0
- 插件（minor）：plugin-adapter-onebot 0.14.0、plugin-agent 0.15.0、plugin-asr-openai 0.11.0、plugin-asr-whisper-cpp 0.11.0、plugin-authority 0.13.0、plugin-checkpoint 0.13.0、plugin-cli 0.12.0、plugin-commands 0.12.0、plugin-cron-engine 0.8.0、plugin-doctor 0.7.0、plugin-draw 0.3.0、plugin-embedding-ollama 0.11.0、plugin-embedding-openai 0.12.0、plugin-file-reader 0.13.0、plugin-flow-control 0.11.0、plugin-gateway 0.7.0、plugin-image-sender 0.7.0、plugin-llm-deepseek 0.13.0、plugin-llm-ollama 0.11.0、plugin-llm-openai 0.13.0、plugin-mcp-client 0.12.0、plugin-mcp-server 0.12.0、plugin-media 0.15.0、plugin-memory-history 0.12.0、plugin-memory-inmemory 0.11.0、plugin-memory-mongodb 0.11.0、plugin-memory-sqlite 0.11.0、plugin-memory-summary 0.12.0、plugin-memory-vector 0.13.0、plugin-message-archive 0.12.0、plugin-office 0.11.0、plugin-okx-trading 0.11.0、plugin-package-manager 0.7.0、plugin-persona 0.11.0、plugin-prompt-budget 0.7.0、plugin-scheduler 0.13.0、plugin-session-confirm 0.7.0、plugin-session-manager 0.13.0、plugin-skills 0.12.0、plugin-storage-local 0.12.0、plugin-subtask 0.13.0、plugin-todo-list 0.11.0、plugin-tool-browser 0.12.0、plugin-tool-math 0.11.0、plugin-tool-onebot 0.11.0、plugin-tool-search 0.11.0、plugin-tool-session 0.13.0、plugin-tool-system 0.12.0、plugin-tools 0.9.0、plugin-trigger-policy 0.13.0、plugin-user-profile 0.13.0、plugin-user-relation 0.14.0、plugin-vectorstore-flat 0.12.0、plugin-vectorstore-lancedb 0.12.0、plugin-websearch-serper 0.11.0、plugin-webui-server 0.13.0、plugin-workflow 0.14.0
- 脚手架与前端（minor）：create-aalis 0.6.0、create-aalis-plugin 0.11.0、plugin-webui-client 0.13.0
- 工具库（patch）：util-bounded-map 0.6.1、util-cron 0.1.3、util-dep-spec 0.1.1、util-json-repair 0.5.4、util-network-guard 0.6.2、util-text-normalize 0.5.2
- 新包（0.1.0）：api-contributions、api-hooks、api-host-config、api-plugin-source、plugin-contributions、plugin-hooks

已有项目在项目目录执行下面这条命令，一次把 package.json 里的全部 `@aalis` 包升到最新，并装上两个新插件：

```sh
npm i $(node -p "Object.keys(require('./package.json').dependencies).filter(n => n.startsWith('@aalis/')).map(n => n + '@latest').join(' ')") @aalis/plugin-hooks@latest @aalis/plugin-contributions@latest
```

下列约束无法完全用依赖范围表达，混装会出错：

- `@aalis/core` 与 `@aalis/runtime` 同批升级。旧 runtime 以具名 ESM 导入 core 已删除的 `pluginDefinitionOf`，进程启动时即在模块链接阶段失败；新 runtime 配旧 core 时调用不存在的 `app.pluginAll`，以 TypeError 失败。
- 所有以具名 ESM 从 core 导入 `hooks` / `contributions` / `hostConfig` 的插件须同批升级，并装上 `@aalis/plugin-hooks` 与 `@aalis/plugin-contributions`（见上文钩子一节）。
- `@aalis/api-tools` 删除了 `asToolExecutionResult`，而已发布的 plugin-agent 0.14.0、plugin-mcp-server 0.11.0、plugin-workflow 0.13.0 在运行时导入它，且依赖范围接受新版 api-tools：只升级 api-tools（包括被其它包的依赖带上来）会让这三个插件在模块链接阶段加载失败。三者须与 api-tools 同批升级。第三方直接导入 `asToolExecutionResult` 的改为读 `.content`。
- plugin-webui-server 与 plugin-package-manager 同批升级：新版 webui-server 调用 `serviceDependents`，配旧 package-manager 时市场依赖图接口返回 500，卸载时也没有服务依赖者闸。市场的「更新所选」允许只更新其中一个包，请同时勾选两者。
- plugin-webui-client 与 plugin-mcp-client、plugin-file-reader 同批升级：旧前端把 `list` 字段退回字符串输入框，一编辑就把数组写坏；也剥不掉新格式的文件块。
- plugin-adapter-onebot 无条件调用 `rememberDescriptionAlias`：装有 plugin-media 时须为 0.13.1 及以上，否则调用失败被附件缓存吞掉（只有 debug 日志「OneBot 附件缓存异常」），入站附件丢掉落盘 ref。
- plugin-memory-vector、plugin-memory-summary 与 plugin-agent、schema-message 同批升级（见 agent 一节）；plugin-user-relation 与 embedding 提供者同批升级后触发一次向量重算（见关系图一节）。
- plugin-mcp-client 旧版在 `mcp_set_server_enabled` 里调用已删除的 `appService.saveConfig()`，配新 core 时该工具以 TypeError 失败。

混装的三类报错：

- 模块链接失败：`does not provide an export named ...`。旧插件导入 core 已删除的导出、旧版 agent / mcp-server / workflow 导入 `asToolExecutionResult` 时，日志为「加载插件 "X" 失败」，该插件不加载；旧 runtime 导入 `pluginDefinitionOf` 时进程启动即退出。
- 运行时 TypeError：新 runtime 配旧 core 调 `pluginAll`、旧 mcp-client 调 `saveConfig`、新 webui-server 调旧 package-manager 的 `serviceDependents`。
- 类型层增广落空：仍向 `'@aalis/core'` 增广 `HookContextMap` / `ContributionPointMap` / `AalisConfig` 的包，增广本身不报错（在源码或发布的 .d.ts 里都一样），但对新契约包不生效。以这些键调用 `hooks.middleware` / `hooks.run` / `contributions.contribute` / `contributions.collect` 时类型检查报错（TS2345，键不在可选范围内）；`hostConfig.get` 取这些配置字段得到 `unknown`，按原类型使用时才报错。

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
