# Changelog

本文件只记录**破坏性变更与迁移路径**。逐包的完整改动见 git 历史。

版本号语义：core 在 1.0 之前，次版本（`0.x.0`）可含破坏性变更并在此列出迁移路径；
补丁版本（`0.x.y`）只做修复与加法。1.0 之后按标准 semver，稳定性条款见
[`docs/design/core-contract.md`](docs/design/core-contract.md)。

---

## 未发布

回复闸门职责重组、模型触发插件与随之的修复，删除跨会话委派工具，`recent_messages` 提档，在线白纸（第一批），以及 0.18 推迟的低危缺陷修复（从「core 的插件状态机与日志」一节起）。各包版本号尚未提升，`package.json` 里仍是 0.18 批次的版本；发布时按源码与 npm 实况确定各包版本，并把用到本节新增接口的包间依赖下限抬到新版本：`@aalis/schema-message`（`buildIncomingContent`）由 plugin-message-archive、plugin-trigger-laya 抬；`@aalis/api-gateway`（`extractTargetId`、`inferSessionScope`、`isScopeEnabled`、`resolveEffectiveConfig`）由 plugin-flow-control、plugin-persona、plugin-trigger-laya、plugin-trigger-policy 抬；`@aalis/api-persona`（按会话取名字）由 api-trigger 抬，实现方 plugin-persona 一并抬；`@aalis/api-memory`（`clearMetadataNamespaces`）由 plugin-memory-summary、plugin-user-profile、plugin-user-relation、plugin-todo-list、plugin-adapter-onebot 抬，它们在运行时导入这个函数，不抬会在装到旧版 api-memory 时加载失败；`@aalis/util-network-guard`（`assertPortAllowed`）由 plugin-tool-browser 抬；plugin-webui-server 与 runtime 的 `@aalis/core` peer 下限抬到本批 core 版本（禁用插件带配置的 `updateConfig` 只换配置、保持禁用，webui-server 的插件配置接口与 runtime 的配置热重载依赖这一语义）。用到 api-memory 结果行 `type` 或可选方法 `listMetadataKeys` 的 plugin-commands、plugin-memory-vector、plugin-checkpoint、plugin-persona 与三家记忆后端（plugin-memory-sqlite、plugin-memory-mongodb、plugin-memory-inmemory）虽只是类型上的加法，也一并抬到新版。其余新用到的接口在已发布版本里都有，也不必抬：plugin-llm-openai、plugin-llm-ollama 新依赖的 `@aalis/util-text-normalize`（`truncateChars`，0.5.2）；plugin-tool-browser 用到的 `pinnedLookup`、`assertAddressesSafe`（util-network-guard 0.6.2 已导出）；plugin-image-sender 用到的 `@aalis/api-storage` 的 `isStorageNotFound`、`isStorageUri` 与网关的 `readFileRange`（0.7.0）。在线白纸要抬的下限另列在那一节。

待发布的包：

- 有代码或契约改动（46 个）：core、runtime、schema-config、schema-message、util-network-guard、api-flow-control、api-gateway、api-media、api-memory、api-persona、api-platform、api-session-manager、api-tools、api-webui、plugin-adapter-onebot、plugin-agent、plugin-checkpoint、plugin-commands、plugin-doctor、plugin-file-reader、plugin-flow-control、plugin-image-sender、plugin-llm-deepseek、plugin-llm-ollama、plugin-llm-openai、plugin-media、plugin-memory-history、plugin-memory-inmemory、plugin-memory-mongodb、plugin-memory-sqlite、plugin-memory-summary、plugin-memory-vector、plugin-message-archive、plugin-package-manager、plugin-persona、plugin-session-manager、plugin-storage-local、plugin-subtask、plugin-todo-list、plugin-tool-browser、plugin-tool-session、plugin-trigger-policy、plugin-user-profile、plugin-user-relation、plugin-webui-client、plugin-webui-server
- 按次版本发布（14 个）：core（禁用插件带配置的 `updateConfig` / `bounce` 改为收下配置并返回 true，required 依赖反复缺失时转 `error`）、runtime（插件入口改按 `import()` 的条件解析，只写 `require` 条件的插件改为跳过；配置热重载须配本批 core）、plugin-commands（删除 `/clear list`，指令解析规则，`CLEAR_TYPES` 的类型）、plugin-doctor（`/doctor` 改为受限，等级 0 的用户不能再运行）、plugin-tool-browser（被拒连接的报错改为 `net::ERR_SOCKS_CONNECTION_FAILED`，`blockPrivate=true` 时不再使用系统代理）、plugin-memory-sqlite（公开导出的 `SQLiteMemoryService` 构造参数须带 `logger`）、plugin-user-relation（公开导出的 `RelationStore`、`RelationService` 的 `clearAll` 须传 `logger`）、plugin-image-sender（`send_attachment` 的拒收规则）、plugin-llm-openai、plugin-llm-ollama、plugin-llm-deepseek（读配置时拒绝带凭据或解析不了的 `baseUrl`，对话报错改写）、plugin-package-manager（`install` 的回执，`PackageManagerDeps.pluginStatus` 须返回 `instanceId`）、plugin-webui-server（管理接口的回执与状态码）、plugin-webui-client（读 webui-server 新增的 `appName`，须与它同批升级）
- 按 patch 发布（13 个）：schema-config（只改 `name` 的说明文字）、util-network-guard（只新增公开 API：`pinnedLookup` 转为公开、新增 `assertPortAllowed`，`assertSafeUrl` 行为不变）、api-memory（只新增可选的结果行字段 `type`、可选方法 `listMetadataKeys` 与函数 `clearMetadataNamespaces`）、plugin-agent、plugin-checkpoint、plugin-memory-inmemory、plugin-memory-mongodb（`MongoMemoryService` 标了 `@internal`，构造参数的变化不算公开 API）、plugin-memory-summary、plugin-memory-vector、plugin-session-manager、plugin-storage-local、plugin-todo-list、plugin-user-profile
- 回复闸门线的 14 个包（api-flow-control、api-gateway、api-media、api-persona、api-platform、schema-message、plugin-adapter-onebot、plugin-file-reader、plugin-flow-control、plugin-media、plugin-message-archive、plugin-persona、plugin-tool-session、plugin-trigger-policy）在发布时按源码与 npm 实况定档。其中 plugin-adapter-onebot、plugin-flow-control、plugin-persona 另有本批的低危修复，这部分只够 patch，不影响它们的档位。
- 上面按次版本、按 patch 两项的档位是按 0.18 推迟的低危修复定的；这些包在删除跨会话委派工具、`recent_messages` 提档、在线白纸各节里另有改动的，发布时把两部分合起来按源码与 npm 实况定档。
- 新包：api-trigger 0.1.0、api-remote-agent 0.1.0、plugin-remote-agent-cursor 0.1.0、plugin-paper 0.1.0
- plugin-trigger-laya 0.1.0 是 `private` 包，不发布到 npm。
- plugin-gateway 只改了说明文字，但 `package.json` 的 description 与 README 写的是入站相位次序，随 api-gateway 的次序变化一并修正，按 patch 发布。
- api-agent、plugin-scheduler、plugin-workflow 只改了注释，api-llm 只改了 `refresh` 的注释，api-authority 只改了 `network` 的注释，plugin-authority 只改了上报器失败来源的注释，本批不单独发布。

### 回复闸门职责重组（@aalis/plugin-flow-control、@aalis/plugin-trigger-policy、@aalis/api-flow-control、@aalis/api-gateway、@aalis/api-platform、@aalis/plugin-adapter-onebot、@aalis/schema-message、@aalis/plugin-message-archive、@aalis/api-media、@aalis/plugin-media、@aalis/plugin-file-reader、@aalis/plugin-persona、新包 @aalis/api-trigger）

trigger-policy 收拢一切"要不要开口"：禁言关键词识别、@ / 戳一戳 / 名字直通、计数与活跃指数判定、闲置主动开口。flow-control 只做节流硬闸：禁言（含落盘与平台禁言同步）、回复后冷却、限速。入站相位随之对调为 `confirm → command → trigger → flow → dispatch`（顺序常量 `INBOUND_PHASE_ORDER` 在 `@aalis/api-gateway`）。

要不要开口由**触发插件**判定，新服务 `trigger`（契约包 `@aalis/api-trigger`）选出生效的那一个：触发插件各自 `provide(trigger, 自己的实例)` 并在 `inbound:trigger` 相位挂中间件，服务胜者（偏好 > 优先级 > 注册顺序）即生效者，二选一，其余触发插件对每条消息直接放行、什么都不做；没有触发插件时这一相位不做判定，消息照常进入 flow 相位。trigger-policy 是规则触发插件（优先级 0），作用域、禁言、禁言关键词、计数与活跃指数、点名识别与闲置主动开口都在它内部，判定同步完成；只装它时的判定即下文所述。它的计数、活跃指数与闲置活动时间只统计它生效时经过的消息，闲置主动开口也只在它生效时注入。每条判定记一行 debug 日志（不含正文）。`@aalis/api-trigger` 另导出触发插件共用的函数：生效者判断 `isActiveTrigger`（每次入站取下的胜者记在进程内全部 api-trigger 副本共用的表里）、禁言关键词 `hitsMuteKeyword`、名字表 `createBotNames`（按会话取人设，因此新依赖 `@aalis/api-session-manager`）、点名识别 `isAddressed`、放行收尾 `markTriggered`、吞掉时的影子归档 `archiveSwallowed`；写日志的函数由调用方传入日志前缀。切换触发插件：WebUI 服务页把 `trigger` 的偏好切到另一个，即时生效；停用生效的触发插件，下一条消息由剩下的接手；手改配置文件的 `servicePreferences` 需重启。禁言关键词、点名的别名与开关、作用域由各触发插件在自己的配置里分别设置，只有生效者的起作用，切换后按新生效者的配置执行；要在切换后保持一致，两边须同样配置。

行为变化：

- 被 @、戳一戳、叫名字（`immediate`）穿透冷却与限速；禁言期除外。
- 名字检测取 `triggerNames` 与全部已登记人设（`persona` 服务的全部提供者）的名字、昵称的并集，人设按会话取：与 agent 同一取法，经 session-manager 解析本会话的配置，其中的 `persona`（会话用的角色卡）传给 `getPersonaName` / `getNickNames`。会话改用别的角色卡时，算点名的是那张卡的名字、昵称，主卡的不算，别的会话不受影响；session-manager 缺席时取全局默认的卡，解析抛错时同样取全局默认的卡并记一条 warn（同一原因只记一次）。此前只取当前生效人设的主卡，会话改用别的卡时那张卡的名字不算点名。同时装了多个人设插件时，叫其中任何一个的名字都算点名。某个人设读名字抛错时只跳过它的名字、照常判定，记一条 warn（同一提供者同一原因只记一次）；此前整条判定异常，记 warn 后放行、不写 `triggerType`。
- 禁言期内一律不说话：flow 相位先查禁言，不看作用域、不看来源，闲置触发、定时任务注入的消息同样被吞。禁言只在入站把关，挡的是禁言之后才开始的回合：命中禁言关键词时正在生成的回复照常发出。
- 内部注入（带 `source` 的消息：闲置触发、定时任务、workflow）不经触发策略，不计数，`triggerType` 不被改写（workflow agent 节点的 `proactive` 原样保留）；flow 相位对它不查回复后冷却，禁言与限速照常生效（限速仅在会话落入 flow-control 作用域时）。这些消息不带会话类型，flow 判作用域时与回复记账同一口径：先用会话已记下的平台与类型，没有再按会话 ID 约定推断（见下文回复记账一条）；此前只看消息自带的类型，默认 `*:group` 下算作用域外（作用域配成 `*`，或配成 `onebot:*` 且消息平台为 `onebot` 时本来就在作用域内）。因此默认作用域 `*:group` 下配置了限速时（`rateLimitWindow` 默认 0，即关闭），bot 在某个群的限速窗口已满，发往该群的定时提醒、workflow 输出会被吞掉并做影子归档，定时任务不重试；session 档闲置提示同样被吞（闲置提示不归档）。此前 flow-control 的 `scopes` 配成 `*` 时，定时提醒会被回复后冷却静默吞掉；trigger-policy 的配成 `*` 时，还会被计数判定吞掉。真人消息由平台适配器投递，不设 `source`；第三方适配器投递真人消息**不得**设置 `source`（`schema-message` 的字段说明已据此更新），否则会被当作内部注入跳过触发策略与冷却。
- adapter-onebot 把好友申请、入群邀请与加群申请合成的 `[系统通知]` 消息标上 `source: 'onebot-request'`，按内部注入处理：不经触发判定，不受回复后冷却约束，禁言与限速照常。此前它们不带 `source`，群里的加群申请被当作真人消息计数，计数未满时归档后吞掉，不作为当前消息送达 agent，只在该群下次触发时以历史出现。
- 第一方 plugin-subtask 派发给子会话的任务消息仍不带 `source`，入站相位按真人消息处理：触发插件的作用域里会话类型段为通配（`*`、`onebot:*` 等）时会被计数判定吞掉、子任务不启动，flow-control 的作用域为通配时子会话冷却期内的追问也会被吞；默认作用域 `*:group` 不受影响。
- 冷却期内的禁言关键词照常生效；平台禁言期内的关键词不再识别，不会缩短平台禁言。戳一戳通知不做禁言关键词匹配。
- 禁言期内的消息不累计计数。关键词禁言在命中时即清零本会话的计数与活跃指数；平台禁言在禁言期内有消息到来时清零——平台禁言期内若一条消息都没有，禁言前攒下的计数保留到解禁后。禁言期内的消息与命中禁言关键词的那条算闲置触发的会话活动：session 档闲置从这条消息起重排、退避复位为 1；此前 session 档不因禁言期的消息重排，解禁后闲置提示可能在群里刚有人说过话不久就发出。
- session 档闲置触发的退避只由真人消息复位，agent 回复（包括回复闲置提示）不再复位。
- platform 档闲置触发把注入本身记为 bot 开口，agent 沉默时不会反复挑中同一会话；禁言期内 session 档到点跳过。
- 冷却与限速只按 agent 的真实回复计，且只对 flow-control 作用域内的会话记账：按会话已记下的类型判；没有流控状态或状态缺类型的会话（重启后没人说话的群、消息都被 trigger 吞掉的群、只有禁言记录的群）按会话 ID 的 `<platform>:<self>:<type>:<target>` 约定推断类型与目标，推断结果只写进 flow-control 自己的会话状态，不回写消息；会话 ID 不符合约定的（如 WebUI）类型未知，只有会话类型段为通配的作用域（`onebot:*`、`*`）命中。默认 `*:group` 下定时任务、workflow 发往群的回复照常计入，前提是会话已有记下类型的流控状态，或状态里记下的平台（没有则用出站平台）与会话 ID 前缀一致（WebUI 与配置文件里建的定时任务平台默认是 `internal`，发往没有流控状态的群时不推断、不计）；发往私聊或 WebUI 的不计入；需要限制的在 `scopes` 里纳入。
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
- **`@aalis/api-platform` 删除 `PlatformAdapter.checkAndRecordProactiveSend`**：它只服务跨会话委派的限速，委派工具已随本批删除（见下文「删除跨会话委派工具」），适配器无需实现任何方法；自研适配器删掉该方法即可。自己调用过该方法做委派限速的第三方代码，改用 `flowControl.current?.isMuted(sessionId)` / `isRateLimited(sessionId)`（只检不记，限速按目标会话的真实回复计）。
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

要发布的包与档位（0.x 次版本可删公开 API）：plugin-tool-session、schema-message、api-persona、plugin-persona 按 minor 发布；plugin-agent 按 patch 发布。plugin-flow-control 的 `scopes` 配置说明去掉了「委派闸门」，随本批发布，档位不因此改变。本节不需要抬任何包间依赖下限：删掉的字段与方法在第一方已没有使用方，plugin-tool-session 去掉了对 api-flow-control、api-hooks、api-persona、api-platform 的依赖。暂不升级 plugin-tool-session 的，委派工具仍在，并且在新版 plugin-adapter-onebot 下失去限速闸（见「必须同批升级的包」）。要在旧版里关掉委派，把 plugin-tool-session 的 `crossSessionEnabled` 设为 `false`（旧版默认 `true`），或从多人平台的 `enabledToolGroups` 里去掉 `session-delegate`。

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

- `@aalis/api-remote-agent` 0.1.0：`remote-agent` 服务描述符与提供者接口 `RemoteAgentProvider`；`resolveRemoteAgent` 按提供者实例 id 精确取，取不到返回 `undefined`，不回落到偏好胜者或别的提供者；`egressWithin`（出网判定，`unknown` 按 `open` 算）、`artifactRelProblem`（成品相对路径的净化规则，提供者与写入口共用）、`isTerminalRun`、`RemoteAgentError` 与 `isRemoteAgentError`（按 `name` 认，装有两份契约包时也认得）。
- `@aalis/plugin-remote-agent-cursor` 0.1.0：Cursor Cloud Agents API v1 提供者，可多实例。激活时不连网；首次 `ready()` 校验鉴权与模型参数（参数须写全并等于 `/v1/models` 的某个变体，默认 `grok-4.7`、`reasoning_effort: high`、`context: 256k`、`fast: 'false'`）；账号标识取 `/v1/me` 的 `userId` 的哈希；出网方式取自配置 `egressMode`（默认 `unknown`），标「未核实」。key 只在宿主进程里用，错误与日志去掉 key 片段与查询串；成品经 `safeFetch` 下载、边读边计字节，单个成品取不到下载链接时只拒收这一件。列代理、列轮次的响应带下一页标记时抛 `unavailable`（翻页方式未实测，不把第一页当完整列表）。
- `@aalis/plugin-paper` 0.1.0：白纸枢纽。工具 `paper_task`、`paper_status`、`paper_cancel`、`paper_send`（`paper` 分组，不声明 risk）；运行驱动（每块白纸一条队列、出队时重跑受理的核对、先落盘再调远端、开轮认领、单轮时长计时器、对账与自唤醒处置、删代理前结清费用（取不到的按估计入账）、换新、闲置归档、定期清空、重启接回）；完成通知（失败原因只写宿主撰写的类别）与待交付提示；WebUI 白纸页（白纸、任务、成品、账本、告警；任务表可取消、放弃跟踪、核销预留）与诊断项 `paper.config`。账本在 `pluginData:/paper/ledger.json`，读不出时远端任务一律不开、原文件不覆盖。

契约新增：

- `@aalis/schema-message`：`IncomingMessage.hostNotice?: { kind; id?; untrusted? }` 标记宿主撰写的事件通知；`WellKnownKinds.HostNotice`（`'host-notice'`），出口前缀 `[宿主通知]`；常量 `DIRECTIVE_KINDS`（`CrossSessionDelegation` 与 `HostNotice`），表示宿主或系统撰写、不是任何人发言的指令类 kind。
- `@aalis/api-tools`：`ToolCallContext.inbound?: { source?: string }`，只由 plugin-agent 的工具循环填写，`source` 取本回合入站消息的 `source`。workflow 节点、mcp-server 等自造上下文的调用方不填。需要「真人当面发起」判据的工具应把缺省当作不满足。
- `@aalis/api-session-manager`：`SessionConfig` 新增 `paperEnabled`、`paperName`、`remoteAgentTypes`、`remoteAgentUserDailyCents`、`remoteAgentUserDailyTasks`、`remoteAgentRoomDailyCents` 与 `memoryRecallScope`（类型 `MemoryRecallScope`：`'session' | 'platform' | 'all'`）；导出 `ROOM_ONLY_CONFIG_KEYS`（前六个键）与 `omitRoomOnlyKeys()`。复制生效配置建新会话的路径都要经 `omitRoomOnlyKeys`；`memoryRecallScope` 随子会话复制。
- `@aalis/api-webui`：表格列新增 `method`，`render` 可取 `'file'`；导出 `WebuiFilePayload { name; mime; base64 }`。

行为变化：

- plugin-agent：带 `hostNotice` 的消息以一条 system 消息呈现（`[宿主通知]`、正文，再接 `untrusted`），不推当前 user 消息；`turn-context` 与 `turn-hint` 两个锚位先找本轮指令块（`metadata.injector` 属于 `DIRECTIVE_KINDS`）、落在它之前。顺带修正：proactive 回合里 `turn-hint` 此前落在最后一条 user 之前，即历史内部，现在落在任务块之前。工具调用上下文填写 `inbound`。
- plugin-message-archive：宿主通知归档为 `role: 'notice'`、`kind: 'host-notice'`，不带 `name`，`metadata.hostNoticeKind` 记子类；只归档 `content`，`untrusted` 不写进消息与 metadata。flow-control 禁言期的影子归档走同一条路径。
- plugin-memory-vector：宿主通知不入向量库；被动召回与 `memory_recall` 的上下文扩窗不再把指令类消息作为邻居带出，因此 workflow agent 节点代发的任务指令也不再随扩窗出现。按会话配置 `memoryRecallScope` 收窄召回：取插件配置与房间范围中较窄的一个，`memory_recall` 的 `scope` 参数放不宽。新增可选依赖 `session-manager`。
- plugin-memory-history：房间 `memoryRecallScope` 为 `session` 时不做跨会话注入，`recent_messages` 返回「本房间的召回范围限于本会话…」；为 `platform` 时插件配置或工具参数写 `cross-platform` 也按 `same-platform` 查。新增可选依赖 `session-manager`。
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
  - 图片、语音、视频内联前按文件头核对格式，不符就拒发并记 warn（见下文破坏性变更）；超过 10 MiB 的 storage 媒体改交宿主路径之前同样核对（按字节区间读出开头）。
  - 投递失败记录（`outbound-delivery-failed`，只对 `source: 'agent'`）覆盖文字发送、文件物化与上传三处失败，每条出站消息至多一条；正文由「经多次重试仍未能送达」改为「(可能包含图片、媒体或文件)未能送达对方」。媒体附件物化失败或文件头不符只记 warn，不写这条记录。
- plugin-webui-client：会话页新增「白纸与远端」一组，每项显示继承值与来源（默认、平台档或父会话），`remoteAgentTypes` 来自平台档时显示告警；取继承值改调 `getInheritance`。声明式表格支持文件单元格：只有 PNG、JPEG、GIF、WebP 能在页面里查看，其余只能下载，下载一律按 `application/octet-stream` 保存。

**破坏性变更与迁移**：

- **plugin-session-manager 删除页面动作 `getInheritedDefaults`**：改用 `getInheritance({ sessionId })`，返回 `{ platform, values, sources }`。会话所属平台由服务端推出（会话 metadata 记下的平台 → 接管这个会话 id 的平台适配器 → `webui`），动作不再收平台参数；`sources` 给出每个键来自全局默认、平台档还是父会话。自己调用过 `getInheritedDefaults` 的 WebUI 客户端改调新动作。服务接口上的 `resolveInheritedDefaults` 不变。
- **plugin-adapter-onebot 出站媒体按文件头核对**：图片只发 PNG、JPEG、GIF、WebP，语音只发 WAV、MP3、OGG、FLAC、AMR、SILK、M4A，视频只发 MP4 / MOV 与 WebM。其他格式（如 BMP、AVIF、HEIC、SVG 图片）此前照发，现在拒发并记 warn，`send_attachment` 发出的同样受约束。要发这些格式，先转成上面的格式。视频与文件改走 `base64://` 依赖实现端接受这种形态；未确认过的实现端，升级后先在测试会话里发一次视频与文件核对。
- **plugin-storage-local 保留根名 `paper`**：`roots` 里名为 `paper` 的用户根会被跳过并记 warn，内部根优先。自建了同名根的，改名后同步修改引用它的 URI。
- plugin-memory-vector 的扩窗不再带出 workflow 代发的任务指令，proactive 回合的 `turn-hint` 落点前移，都是行为变化，无需迁移。

要抬的依赖下限：

- `@aalis/schema-message`（`hostNotice`、`WellKnownKinds.HostNotice`、`DIRECTIVE_KINDS`）：plugin-agent、plugin-message-archive、plugin-memory-vector、plugin-user-relation、plugin-user-profile、plugin-llm-deepseek、plugin-paper 抬。`DIRECTIVE_KINDS` 是运行时导入，装到旧版 schema-message 时这些包加载失败。
- `@aalis/api-tools`（`ToolCallContext.inbound`）：plugin-agent、plugin-paper 抬。
- `@aalis/api-session-manager`：plugin-session-manager、plugin-subtask 抬（运行时导入 `omitRoomOnlyKeys`，装到旧版时加载失败）；plugin-memory-vector、plugin-memory-history、plugin-tool-session、plugin-user-relation、plugin-paper 抬（新键与 `MemoryRecallScope` 类型）。
- `@aalis/api-webui`（`render: 'file'`、`method`、`WebuiFilePayload`）：plugin-paper 抬。
- 三个新包之间与新包对既有包的下限，现写的是开发时的当前版本号（如 plugin-paper 对 api-session-manager 写 `>=0.10.0`），发布时按上面各条一并抬到本批的新版本。

发布档位：三个新包按 0.1.0 首发。plugin-session-manager（删页面动作）、plugin-adapter-onebot（媒体格式收窄）、plugin-storage-local（保留根名）按 minor 发布，附上面的迁移；schema-message、plugin-memory-history、plugin-tool-session 在本节之前已定为 minor。api-tools、api-session-manager、api-webui 只做加法，plugin-agent、plugin-message-archive、plugin-memory-vector、plugin-user-relation、plugin-user-profile、plugin-llm-deepseek、plugin-subtask、plugin-checkpoint、plugin-webui-client 是修复与加法，按 patch 发布。

### 必须同批升级的包

- plugin-flow-control 与 plugin-trigger-policy 同批升级：新版 flow-control 提供的服务已删除旧版 trigger-policy 调用的 `getStateSnapshot` / `recordTriggered` 等方法；相位顺序常量在 `@aalis/api-gateway`，它升到本节的新版本后，已发布的旧版二者会按新顺序运行而失常。plugin-adapter-onebot 与 plugin-tool-session 同批升级：旧版 tool-session 经适配器的 `checkAndRecordProactiveSend` 做委派限速，新版适配器已删除该方法，委派限速闸会静默失效。走插件市场的，这四个包须同一批勾选更新。
- plugin-session-manager 与 plugin-webui-client 同批升级：新版会话页调 `getInheritance`，旧版 session-manager 没有这个动作；新版 session-manager 删了 `getInheritedDefaults`，旧版会话页取不到继承值。
- 启用 plugin-paper 时，plugin-agent、plugin-message-archive、plugin-memory-vector、plugin-user-relation、plugin-user-profile、plugin-storage-local、plugin-checkpoint 须同批升级，用 DeepSeek 的另加 plugin-llm-deepseek，要发回网页与 MP4 的另加 plugin-adapter-onebot。旧版 plugin-agent 不填 `ToolCallContext.inbound`，白纸工具一律拒绝；旧版的 agent、归档、向量记忆与抽取插件不认识 `hostNotice`，完成通知会按普通消息呈现、归档为 user、进向量库与抽取窗口；旧版 storage-local 没有 `paper` 根，成品取不回；旧版 checkpoint 会给 `paper` 根记账，别的会话回滚时删掉成品；旧版 onebot 适配器跳过文件附件，网页发不出去。
- 暂不升级本节各包的项目注意反方向：`npm update` 或无锁文件重装可能把传递依赖 `@aalis/api-gateway` 升到本节的新版本（多个依赖方写的是 `>=0.7.0 <1.0.0`），已发布的旧版 flow-control 与 trigger-policy 随即按新顺序失常，请用 `package.json` 的 `overrides` 把 `@aalis/api-gateway` 固定在已发布的 0.7.0。

### core 的插件状态机与日志（@aalis/core）

- `disable` 清掉上一次激活失败留下的 `error`。此前从 `error` 态停用后，`getStatus()`、`getPlugin()` 与 WebUI 的 `/api/plugins` 仍带着旧的错误说明。停用本身超过宽限、转为 `error` 的，照旧写「未在宽限内停止」。
- 插件处于禁用态时，带配置的 `bounce(id, { config })` 与 `updateConfig(id, config)` 收下新配置、保持禁用、返回 true、不记 warn，启用时按新配置激活；不带配置的 `bounce` 照旧记 warn 并返回 false。此前两者对禁用插件一律记一条 WARN「处于 disabled 态，跳过」、返回 false、不换配置：配置文件热重载时每次都再记一次，之后启用插件仍按旧配置运行，要等下次热重载或重启才与文件一致。
- 初始化期间 required 依赖缺失的自动重试改为按插件计、跨重算累计：`apply` 里 required 绑定抛出不可用错误，与后台激活因 required 依赖下线被拆，两条路径记入同一份额度（首次取额时的 2×插件数+8）。用尽转 `error`，错误说明为「初始化期间 required 依赖反复缺失（最后一次缺 "<服务名>"），自动重试未收敛，已停止；enable 或 bounce 后重试」，点名用尽那一次缺的 required 服务，记一条 error，不再自动重试；激活成功、`enable`、`bounce` / `updateConfig` 时额度清零。此前额度只在单次重算任务内有效，用尽后停在 `pending`，下一次重算从头再计；后台激活被拆这条路径完全不计，慢 `apply` 里让自己的 required 依赖下线又恢复的插件每个阈值周期重试一次，没有上限。
- 慢激活转入后台时只记一条 warn，删去此后每隔 `slowThresholdMs` 一次的「仍在激活（已超过 N ms）」提醒。后台状态照旧经 `getStatus()` 的 `slow`、WebUI 的「激活中（超过阈值）」与 doctor 的 `plugins.slow` 查看。此前提醒定时器一直重排，嵌入 core、不调 `stop()` 就等进程自然退出的宿主会被永不落定的激活拖住，进程不退出；现在至多拖到阈值到点。
- `LogHub` 逐个隔离监听器：单个监听器抛错（含返回被拒的 Promise）不影响其余监听器，也不让日志调用抛出；监听器本身就是日志的去处，它的错误不再上报。此前一个抛错的 sink 会让日志调用本身抛出、排在后面的 sink 收不到这条日志，core 里直接调用日志的步骤（如插件登记）随之中断。
- 文档写明现状：重算逐个激活，每个慢激活单独等满一个阈值；排在前面的慢插件有 N 个时，后面插件的激活与 `register` / `pluginAll` / `idle()` 的返回约晚 N×阈值。

**行为变化与迁移**：
- 初始化期间 required 依赖持续失稳、自动重试用尽的插件停在 `error`，依赖恢复后不再自动激活，需 `enable` 或 `bounce`（WebUI 里用插件卡片的开关先禁用再启用，或点「编辑配置」原样保存）；此前停在 `pending`，下一次重算自动重试。doctor 的 `plugins.errored` 会把这类插件列为出错。
- 靠禁用插件的 `updateConfig` / `bounce` 返回 false 判断「插件已禁用」的调用方，改为先读 `getStatus()` 或 `getPlugin()` 的 `state`。依赖新语义的包（plugin-webui-server 的插件配置接口、runtime 的配置热重载）须把 `@aalis/core` 的 peer 下限抬到本版。
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
- util-network-guard：`pinnedLookup` 转为公开 API（此前标 `@internal`），供自管连接作为 `net.connect` 的 `lookup` 传入；新增 `assertPortAllowed(port)`，按 `allowedPorts` 判定端口，`assertSafeUrl` 与浏览器网络闸共用这一判定；文档补上 `pinnedLookup` 与 `assertAddressesSafe`（写明传入的 IP 字面量须是规范形式），并更正 `assertSafeHost` 的说明：它只预检、不连接，单用它封不住 DNS 重绑定。

**行为变化与迁移**：

- 按 `net::ERR_BLOCKED_BY_CLIENT` 判断「被拦截」的调用方，改为匹配 `net::ERR_SOCKS_CONNECTION_FAILED`（它同时覆盖目标无法解析或连不上的情况）。
- `blockPrivate=true` 时浏览器不再使用系统代理设置：此前 Chrome 按系统代理（macOS 的网络设置、Linux 上的 `*_proxy` 环境变量等）出网，现在出站连接一律由插件所在进程直连目标。要经上游代理才能出网的部署，需让插件所在进程的直连可达（如透明代理），或把 `blockPrivate` 设为 `false`（同时失去私网拦截）。
- 配了 `network.allowedPorts` 的部署，`blockPrivate=true` 时浏览器也只能连到列表里的端口：页面或它的子资源用了其它端口（如 `:8080`、`:8443`）时以 `net::ERR_SOCKS_CONNECTION_FAILED` 失败，需要时把端口加进 `allowedPorts`。
- `headless=false` 的使用者会看到每个页面各开一个窗口。
- 锁定了 24.40 以前的 puppeteer 的部署，升级本插件后 puppeteer 随之升级，绑定的 Chrome 版本通常也会变，需要重新下载一份 Chrome：npm 安装（含插件市场的安装与更新）会跑 puppeteer 的安装脚本，在安装时下载；跳过安装脚本时（pnpm 10 起默认、`--ignore-scripts`）在首次调用浏览器工具时下载，最长等 300 秒。可预先执行 `npx puppeteer browsers install chrome`，或用 `executablePath` 指向已装的 Chrome。

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

- 靠 `PUT /api/plugins/:name/config` 回 409 判断插件已禁用的调用方，改读 `/api/plugins` 的 `state`。这条依赖本批 core 的新语义（禁用态 `updateConfig` 收下配置、返回 true）：配合旧版 core 时，对禁用插件的 PUT 会回 404「插件不存在」。发布时 plugin-webui-server 的 `@aalis/core` peer 下限抬到本批 core 的版本。
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

### 零散修复（@aalis/plugin-flow-control、@aalis/plugin-storage-local、@aalis/runtime）

storage-local 按 patch 发布；runtime 因下面所列入口解析的反方向变化，并须配本批 core（见开头的下限说明），按次版本发布；flow-control 本节这一项是修复，它的档位随回复闸门职责重组一节定。

- flow-control 的禁言表写盘在飞时 storage 换人（或同一 storage 重载）触发重读，读到的文件可能不含这次写。此前写一成功就清掉「未落盘改动」记录，随后读回的旧禁言按较晚的到期时刻合并回内存，解禁被撤回，新 storage 上的文件也不再补写，群里按旧禁言沉默到原到期时刻。现在写盘期间开始了重读的，这次写成功也不清记录：重读时这些会话以内存为准，读完补写到当前 storage。写链在等上一次读回时又开始了重读的，现在接着等新的一次读回再写；此前这一步直接写整表，会冲掉新 storage 文件里其它会话的禁言，解禁同样可能被撤回。
- storage-local 的 `storage.delete` 审计日志由 warn 改为 info，与写入、重命名、移动同级；`/clear`、市场更新预检、checkpoint 清理等正常删除不再输出一串 WARN。
- runtime 的 `createNodeModulesPluginLoader` 改按 `import()` 的规则定位插件：包目录按 `node_modules` 逐级上溯定位，直接读其中的 `package.json`；入口有 `exports` 时取 `"."` 的 import 条件目标（`node` / `import` / `default`，Node 启用 require(esm) 时另有 `module-sync`，与 `import()` 一致），没有 `exports` 时按 `main`，依次试 `main`、`main.js`、`main/index.js`，最后 `index.js`。此前用 CommonJS 的 `require.resolve`：`exports` 没开放 `./package.json` 的包读不到元数据，报「exports 映射未导出 "./package.json"」并跳过；开放了的，`exports` 只写 `import` 条件时报「入口无法解析」并跳过，同时写了 `import` 与 `require` 的双入口包加载的是 `require` 条件的产物。入口解析失败的告警改为写明可能的原因。
- runtime 在配置热重载时登记新出现的 `name:suffix` 段，模块定义改取该模块在册实例的（主实例优先）。此前只按主实例取：主实例被 `unload`、同模块的后缀实例还在册时，新加的后缀段被报「对应的模块未找到」并跳过，而冷启动会照常登记。第一方路径（WebUI 不允许删主实例，市场卸载连同全部实例一起卸掉）不会走到这里，影响的是经 plugins 服务直接卸载主实例的第三方插件或嵌入宿主。

**行为变化与迁移**：

- 此前因上述原因被跳过的插件（`keywords` 含 `aalis-plugin`，且 `exports` 只写 `import` 条件或没开放 `./package.json`），升级 runtime 后会被发现，并像其它插件一样默认启用。不想启用的，在配置里禁用，或从项目依赖中移除。双入口插件改为加载 `import` 条件的产物，两份产物行为不一致的，以 ESM 产物为准修正。
- 反方向：`exports` 的 `"."` 只写 `require` 条件（没有 `node`、`import`、`default` 可用的目标，且开放了 `./package.json`）的插件，此前能加载，升级 runtime 后报「入口无法解析」并跳过，与 `import()` 包名的行为一致。插件作者给 `"."` 加 `default` 或 `import` 条件，或把目标直接写成字符串（如 `"exports": "./index.cjs"`）；CommonJS 产物照样能被 `import()` 加载。
- 按 WARN 级筛查删除记录的，改看 info 级的 `storage.delete` 行；默认 `logLevel: info` 下照常输出。

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
