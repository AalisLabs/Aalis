# Changelog

本文件只记录**破坏性变更与迁移路径**。逐包的完整改动见 git 历史。

版本号语义：core 在 1.0 之前，次版本（`0.x.0`）可含破坏性变更并在此列出迁移路径；
补丁版本（`0.x.y`）只做修复与加法。1.0 之后按标准 semver，稳定性条款见
[`docs/design/core-contract.md`](docs/design/core-contract.md)。

---

## 未发布（core 0.12.1 → 0.13.0；插件版本随发布时补全）

### saveConfig 返回时持久化已完成（@aalis/core）

`AppService.saveConfig()` 由 `void` 改为 `Promise<void>`：同步 provider 立即完成，异步 provider 等其落定；provider 失败以拒绝传出，此前被 `ConfigManager.save` 静默吞掉、App 无条件记「配置已保存」。并发保存的先后与外部编辑的合并不在此契约内。
**迁移**：调用方 `await app.saveConfig()`；尽力而为的后台持久化路径用 `.catch()` 记录。第三方若实现 `AppService` 需改返回类型。第一方 fs-yaml provider 为同步实现，不 await 的旧调用在该 provider 下行为不变。

### provide 按 ServiceTypeMap 约束实现类型（@aalis/core）

`ctx.provide(name, instance)` 对已知服务名（`ServiceTypeMap` 中声明的）按契约类型检查 `instance`，错误实现在编译期被拒；未知名与动态字符串仍为 `unknown`。运行时不变。
**迁移**：编译报错的要么是真实缺口（修实现），要么是刻意的部分替身（测试里按仓内先例 `as never`）。

### 注册表按清理归属清理（@aalis/core）

四个注册表（`ServiceContainer` / `HookRegistry` / `EventBus` / `ContributionRegistry`）的 `unregisterByContext(id)` 删除，换为 `unregisterByOwner(owner: symbol)`；`register` / `on` 新增可选 `owner` 参数，`EventBus.on` 第三参由 `string` 改为 `symbol`。`ctx.id` 仍是逻辑身份（贡献键与同键替换、服务偏好、模型引用、`hasByContext` 前缀查询）；清理按每次激活新鲜的内部 owner，同名 Context 在四原语层互不误清，拆卸在飞时同名新激活的注册也不会被迟到的清理误删。经 `tools` / `commands` / `webui-server` 等枢纽服务登记的条目仍按 `ctx.id` 走 `unregisterByPlugin` 清扫，不变。
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
