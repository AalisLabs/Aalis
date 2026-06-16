# Issues & Roadmap

> 四区：**待办**（还没做的事，按优先级）→ **已知限制**（接受的妥协，非 bug）→
> **已决议**（长期约束，避免反复讨论）→ **已完成**（单行归档，细节看 commit/docs）。

## 待办（还没做，按优先级）

### 可能的缺陷
1. webui 的市场展示的星级到底是在展示什么，总星吗？并且质量人气维护怎么都是100%
2. 高权限用户分法低权限用户时，采取手写glob的方式是不是有点麻烦，能升级为某种可视化的选择方式吗？另外那个绑定平台用户的功能到底是在做什么，对于用户并不是很明确

### 新功能
1. **第三方前端端到端实测**：装一个非默认 `aalis.client` 包，验证「发现 → 切换 → reload 加载」全链路
   （切换 UI 已做，见归档；目前只用默认前端验证过 UI 路径）。
2. **scoped/app 沙盒**：per-user 受限 WebUI 视图（资源默认私有 + 创建者授权）；需先解决
   scope 事件总线不隔离。
3. **PDF 内嵌图片识别**（DOCX 已做，见归档）：PDF 抽内嵌图片较复杂（需 pdf.js operator/XObject 级解析），
   暂仅提取文本。（office 插件是纯创作工具、不读文档，无此需求。）
4. **任务树深层能力**（task-orchestrator 设计的剩余 ~30%，确定性编排已由 workflow `agent` 节点落地）：
   运行时**递归**任务分解（subtask 现禁止嵌套）+ 一等公民 `task:*` 事件 + 专用任务树 WebUI 页 +
   per-subtask context-scope 隔离。见 docs/design/task-tree-system.md 缺口分析。
5. **更强代码沙箱 tier（可选）**：v1 OS 沙箱（bwrap/seatbelt）已闭合「最后一个真洞」（见归档），但**不防读本机文件、
   网络只能整体开关**。如需更强隔离，可加 `code-sandbox` 的新实现：`-docker`（容器化）/ `-wasm`（Pyodide/Deno，
   deny-by-default 但丢 C 扩展）/ `-e2b`（远程 microVM）。经同一 `code-sandbox` 服务按优先级/偏好替换，非阻塞项。
6. **GUI 修复缺失依赖**（暂缓；经分析属**功能**非 bug）：读项目 deps + 检 node_modules 缺失 + 一键按名重装。
   可由 `doctor.registerCheck`（检声明依赖是否缺失）+ `package-manager.install(npmPkg)` 组合实现，属中等工程。

## 已知限制（接受的妥协，非 bug，记录在案）

- `'ready'` 与 `'app:started'` 语义重叠：合并属破坏性变更，暂保留双事件，新代码优先用 `'app:started'`。
- **OneBot 撤回对「严格 v12」服务端不保证**：`onebot_recall_self` / `onebot_delete_msg` 硬编码 v11 动作名
  `delete_msg` 且 message_id 走数字优先（`Number(id)||id`）。主流 QQ 实现（NapCat/Lagrange/go-cqhttp）均说 v11，
  故实际可用；但严格 v12 服务端的 `delete_message` 动作名与字符串 message_id 未适配（撤回会失败、不崩溃，
  结果落在工具的 failed 列表）。彻底修需适配器按协商版本翻译动作名/参数类型——留作 OneBot v12 专项。
- `ScopedConfigManager` 用「extends + 全量覆写 + 反射防漂移单测」而非纯组合：基类新增公开方法
  须同步覆写（test/core/config.test.ts 设防）。
- 插件 page-action 默认 `restricted`（仅 owner）：现有 actions 全是 WebUI 管理操作，owner-only 即正确；
  将来若出现面向普通用户的 action，再单标 `actionsMeta: { visibility: 'public' }`。

## 已决议（长期约束）

- **版本与兼容策略（2026-06-16 起）**：① 插件对 `@aalis/core` 用 **`>=0.2.0 <1.0.0`** peerDep
  （**禁用 caret**——`^0.x` 在 0.x 只匹配单个次版本，会把插件锁死、core 升次版本即全生态显示不兼容）；
  ② **core 承诺 0.x 内向后兼容**——次版本只做加法/温和改，**破坏性变更才升 1.0.0**（那是唯一要求插件
  适配的线，`>=` 区间正建立在此承诺上）；③ 全仓唯一的 `@aalis/*` peerDep 就是 core，包间互依走
  `workspace:^`（同批共版、发布转 caret，受我们控制无第三方问题）。脚手架/文档已落地此约定。
- **共享契约污染审查结论（2026-06-16）**：一次 86-agent 审查扫了 core + 全部 -api，标记 21 项「单/零消费者」。
  复核后**只有少数是真问题**（已修，见归档）；**多数是有意保留、勿再标记**：① 挂 `AalisEvents` 的
  `workflow:run:*` 等事件（事件就是给别人订阅的，0 订阅者≠污染）；② session-tree 面（getTree/createChildSession
  /completeSession，task-tree #5 的设计扩展点）；③ Memory 的 `updateMessageContent`/`deleteMessagesByTimestamps`
  + capability + probe（这是「声明可选能力让消费者安全探测」的**既定模式**）；④ `getPersonaSkills`、`Scoped*.raw`、
  `PlatformCapabilityRegistry` 等扩展点/一致访问器。**判定原则**：「当前单一消费者」不等于污染——若该成员是
  其所属服务合理的通用能力、或是面向第三方/未来的扩展点，则保留（最多泛化文档），不删。详见 [[avoid-polluting-shared-contracts]]。
- **core 设计理念**：环境无关（不碰 I/O / process.env，一切经 provider 注入）、抽象化（IoC + 事件
  + 钩子 + 能力声明）、最简化（不引第三方运行时依赖，API 面最小）、忒修斯之船（任何插件/子系统
  可热替换或经 AppOptions 注入替换，前端亦然）。
- **AalisEvents 类型封闭**：动态事件名走命名空间模板字面量签名（`` [k: `myns:${string}`]: [T] ``，
  见 docs/core/events.md）。
- **core 不拆 kernel 包**：declaration merging 锚定 `@aalis/core` 包名。重评触发条件：①core 单独
  1.0 承诺；②出现 kernel-only 消费者；③多人协作需 Conway 边界。架构测试设防「基底层不得 import 编排层」。
- **runtime 命名**：`@aalis/runtime` 暂保持（= 默认 Node 宿主；Node 专用但 npm/pnpm/yarn 通用——区分轴
  是 JS 运行时非包管理器）。**改名触发条件**：出现第二个环境宿主（如 Deno/浏览器）时，再改为
  `@aalis/runtime-node` 与 `@aalis/runtime-deno` 并列（届时保留旧名 alias 或迁移 create-aalis，避免
  断存量项目）。说明见 docs/core/runtime.md。

## 已完成（单行归档，新→旧）

- ✅ 2026-06-16 **全仓用户可见输入面加固（batch 2，commands/cron/onebot 0.4.1）**：先用 9-agent
  workflow 研究 Koishi/create-* 做法 + 审计全仓输入面，核实后**只修确凿真问题、排除被夸大项**
  （webui page-action 实为 owner 鉴权+authorize 闸非洞；http 已有读后截断；commands tokenize 不丢内容）。
  修：① commands number 选项/参数 `Number("abc")→NaN` 静默传 handler → 校验报错；且 parseArgs 未包
  取值解析（choices 越界抛错也冒泡）→ 包一层返回可读错误串。② cron parseCronField 范围段不夹边界
  （分钟 "1-100" 塞入 60-99）+ 非法范围 "5-" 静默 → 夹到 [min,max]+跳 NaN/越界。③ onebot 成员 limit
  无上界 → 封顶 200。加 commands/cron 回归单测。ci 绿 765 测试。
- ✅ 2026-06-16 **create-aalis 交互严格校验 + 撤终端插件大列表（0.4.2 / plugin 0.4.1）**：用户报
  「输 1,2sa / sidhu / 1, 2 都过闸不报错」+ 拥挤担忧。研究确认 Koishi/create-* 做法=终端只建最小项目+
  少量预设、插件发现交 WebUI 市场。修：抽纯函数 parseIndexSelection（逗号或空格分隔、坏 token/越界/重复/
  单选多填一律报错**重问**，不再 parseInt 宽容+filter 静默吞）+ validateNpmName（项目名/包名按 npm 规则
  校验重问，旧放行 MyBot 等生成坏 name）；**撤掉终端 live 全列表多选**→交 WebUI 市场（对齐 Koishi）；
  create-aalis-plugin 修 askYesNo 真 bug（默认 No 的问题打 y 被判成 No、无法启用命令/WebUI）+ 名校验+
  非 TTY/realpath 入口守卫。14 例纯函数单测 + PTY 集成验证（坏输入→报错→重问→成功生成）。**npx 缓存提醒**
  仍适用：用户须 `npm create aalis@latest` 或清 `~/.npm/_npx`。
- ✅ 2026-06-16 **create-aalis 0.4.1（测发布版交互流程时抓到 2 个真 bug）**：① `code-sandbox-os`
  错误出现在「其他插件」可选列表——`toPluginCatalog` 过滤用锚定 `/^code-sandbox/`，但去 scope 后短名仍带
  `plugin-` 前缀（`plugin-code-sandbox-os`）→ 锚点永不匹配漏过；改非锚定 `/code-sandbox/`（沙箱基建选
  code-runner 自动带、不该单选），加回归测试。② stdin 非 TTY（管道/某些 IDE 终端/CI）进交互模式 readline① `code-sandbox-os`
  错误出现在「其他插件」可选列表——`toPluginCatalog` 过滤用锚定 `/^code-sandbox/`，但去 scope 后短名仍带
  `plugin-` 前缀（`plugin-code-sandbox-os`）→ 锚点永不匹配漏过；改非锚定 `/code-sandbox/`（沙箱基建选
  code-runner 自动带、不该单选），加回归测试。② stdin 非 TTY（管道/某些 IDE 终端/CI）进交互模式 readline
  遇 EOF **静默空退**（exit 0、无项目、无报错）；现 `!stdin.isTTY && !skip` 提前清晰报错 + 指引 `--yes/--tier`
  并 exit(1)。**运营提醒**：今天前 npm 上是 0.2.0（含 realpath 入口 Bug A，交互界面不出现），修复随 0.4.0 已发；
  **npx 缓存无版本号解析结果**，用户须 `npm create aalis@latest` 或清 `~/.npm/_npx` 才拿到新版。单包发布 0.4.1。
- ✅ 2026-06-16 **全生态统一 0.4.0 + core peerDep 松绑（根治版本策略缺陷）**：92 包统一 bump 0.4.0
  （终结 0.2/0.3 不统一）；85 个 core peerDep `^0.2.0`→**`>=0.2.0 <1.0.0`**——旧 caret 在 0.x 把插件
  锁死单个次版本，core 一升次版本全生态显示不兼容、逼重发、慢更新第三方插件掉队；新区间接受任何 0.x
  宿主 core。配套**硬承诺：core 0.x 内只向后兼容、破坏才升 1.0.0**（写入 已决议）。脚手架
  create-aalis-plugin + 两篇插件文档同步新约定。趁市场未铺开一次性根治。**已 npm 全量发布 0.4.0、
  注册表实查通过**（core/runtime/2 沙箱包/code-runner/create-aalis* 均 0.4.0，peerDep 元数据已生效）。
- ✅ 2026-06-16 **code_runner 进程隔离（OS 沙箱，闭合最后一个真洞）**：新增 `code-sandbox` 服务契约
  （`@aalis/plugin-code-sandbox-api`）+ OS 实现（`@aalis/plugin-code-sandbox-os`：Linux bubblewrap /
  macOS sandbox-exec），把不可信代码限制在「工作区+临时目录」可写、默认断网、env 仅白名单。**经现有
  `process` 网关 spawn、零改 process-api/local/core**（不污染通用子进程契约；不直接 import node:*，
  后端用功能性试跑探测）。code_runner 加 `sandbox.{mode,network}` 配置：auto=有后端强制隔离/无则
  **fail-closed**、none=裸跑告警；create-aalis 选 code-runner 自动带 code-sandbox-os。纯 sandbox.ts
  +10 例单测；docs/plugins/plugin-code-sandbox-os.md。**边界**：防写出/外泄/篡改系统，不防读本机文件
  （读放开，需 WASM/microVM 更强 tier，见待办#5）。**已合 dev，随后续发布上 main**。
- ✅ 2026-06-16 **共享契约清理（仅真问题）**：① **core 去 WebUI 泄漏**——`PluginStatusEntry.subsystem/extends`
  移出 core（env-agnostic 不该命名 WebUI 概念）；webui-server 改从 `getPlugin(instanceId).module` 读 subsystem，
  **并顺手接通一直没接的「扩展 Core」UI**（/api/plugins 现转发 `module.extends` → 前端 chips 真正渲染）。
  真正的扩展机制（declare module 声明合并 / 服务 / 事件）完全不动。② **删确凿死代码**（0 消费者，删前逐个 grep）：
  `SessionManagerService.getDefaults`、`AgentService.getPluginGroups/getPreprocessors`（+ PluginGroupInfo/
  PreprocessorInfo）。其余审计项判定为有意扩展点/既定模式予以保留（见已决议）。ci 绿、零行为回归。
- ✅ 2026-06-16 **create-aalis 入口与版本修复**（见 fix/create-aalis-entry）：realpath 修 .bin 软链入口；
  版本去硬编码 `^0.1.0`，改脚手架时逐包从 npm 解析当前最新写 `^<最新>`、失败回退 `latest`。create-aalis 0.2.1。
- ✅ 2026-06-15 **合 main 前对抗审查 + 修复**（6 reviewer × 3 验证者；12/21 确认）：
  ①file-reader DOCX 识别去 `hint`（恢复 24h 描述缓存）+ `detailLevel:'detailed'`（每图 2→1 次视觉调用）+
  并发 3 + 30s 整体预算（修「上传同步阻塞」）；②workflow agent 节点 `source` 含 nodeId 隔离并发 lane
  （修同会话回合互相 abort）+ 显式同 sessionId 串扰风险入文档；③`session_get_history` 区间检索改按时间**正序**
  返回最早 limit 条 + `truncated` 标记（修 >500 静默丢最新）+ fallback 扩到 5000 条且诚实回显 includeArchived；
  ④Dashboard 切换前端改校验 `res.ok`（修非 owner 假成功并 reload）；⑤workflow `validateGraph` 增按类型必填
  字段校验（agent 缺 instruction 等定义期即报错，免运行期 cryptic）；⑥图片识别失败日志升 warn。OneBot v12
  严格服务端撤回不适配 → 记已知限制。无 `packages/core` 改动。新增/更新单测，ci 绿。file-reader 读 DOCX 时第二遍 `mammoth.convertToHtml`
  收集内嵌图片 data URI → `media.describeImage` 识别 → 以「`--- 文档内图片 (N) ---`」小节附正文末，
  让 LLM 看见文档里的图。配置 `recognizeDocImages`（默认开）+ `maxDocImages`（默认 8，超出跳过）；
  单张失败不影响其余、无 media 静默跳过、结果随文本缓存。纯编排 doc-images.ts（recognizeImages/
  formatImageSection）+ 7 例单测。澄清 office 是纯创作插件不读文档（无此需求）；PDF 抽图较复杂留待办#4。
- ✅ 2026-06-15 **onebot 主动撤回**（bot 撤回自己发的消息）：适配器 `sendMessage` 原先丢弃发送响应、
  bot 无从得知自己消息的 message_id。现 `SentMessageTracker` 按会话记录发出消息的 id（环形缓冲、30min
  时窗、撤回后 forget 可重复往前撤）；适配器暴露 `getSentMessages`/`forgetSentMessage`（仿 getSelfMutes
  扩展）；新增工具 `onebot_recall_self`（无需 message_id，默认撤回最近 1 条、`count` 撤最近 N 条、
  可指定 group_id/user_id）。纯逻辑抽 sent-messages.ts + 9 例单测。撤回他人消息仍用既有 onebot_delete_msg。
- ✅ 2026-06-15 **workflow `agent` 节点（task-orchestrator 确定性编排落地）**：给 plugin-workflow 加
  `agent` 节点类型——派发指令给 agent 并 join 本轮回复（复用 delegate `agent:turn:after` 机制），
  回复经 `out` 入 outputs 供 `{{outputs.X}}` 插值；配合 deps 即「分解→依赖→串/并行→管道→聚合」。
  省略 sessionId 自动隔离子会话；超时/error 节点失败。`AgentNodeSpec` 入 workflow-api；engine
  `execAgent` + 5 例单测；新增 docs/plugins/plugin-workflow.md；task-tree-system.md 重标为设计提案
  （不另造 plugin-task-orchestrator，~70% 已由现有插件组合覆盖，余项见待办#6）。
- ✅ 2026-06-15 **文档口吻去 owner-gated + 名称勘误**：extensions/index.md 改「请先在本表登记」为
  「这不是注册门禁——第三方直接 `declare module` 即可，无需登记；本表只收录一方包」；node-usage-policy
  「社区收录评审」澄清为「仅合入主仓库时才 review，发 npm 即用」；`plugin-agent-default`→`plugin-agent`
  （无此包名，7 处）。审计确认家族简写（plugin-llm 等）本就规范、其余文档口吻无问题。
- ✅ 2026-06-15 **按时间区间取消息**：`session_get_history` 工具加 `within_minutes` / `since` / `until``session_get_history` 工具加 `within_minutes` / `since` / `until`
  入参（ISO 或毫秒），给定时间窗即路由到 `memory.getMessagesBySessionRange`（区间含归档完整记录、
  区间内取较新 limit 条），否则维持原条数检索；纯函数 `resolveTimeRange`/`parseTimestamp` 抽出单测
  （test/plugins/session-history-range.test.ts，15 例）。补齐单会话/任意区间的通用查询缺口。
- ✅ 2026-06-15 **市场 v2 切换前端 UI**：webui-server `GET /api/clients`（列已发现前端）+
  `POST /api/clients/active`（owner 设活跃：实时重挂静态目录 + 持久化 `webui.client`）；Dashboard
  在装了 >1 前端时显示切换卡片（设为活跃 → reload 即加载新前端）。收尾「前端忒修斯之船可换」。
- ✅ 2026-06-15 **runtime 文档 + keyword 伞形**：新增 docs/core/runtime.md（@aalis/runtime = Node 宿主层、
  与包管理器无关、设施清单、如何为别的环境写 host）；全包加 `aalis` 伞形关键词（core 加 `aalis-core`），
  `npm search aalis` 即可找全生态（**本地已改，随下次发布上线**；不影响市场的 `aalis-plugin` 过滤）。
- ✅ 2026-06-15 **0.2.0 协调全量发布**：feat 全并入 dev + 清理分支（只剩 dev/main，ff main→dev）；
  90 包统一 bump 0.2.0 + 83 处 peerDep `^0.1.0→^0.2.0`；npm 已发、CI 绿；市场 api/前端 类目实际
  可见（`keywords:aalis-plugin` 检索 83 包 = 59 插件 + 23 api + 1 前端）。
- ✅ 2026-06-15 **市场 v2 + 前端可换**：api 契约 + 前端入市（沿用 `aalis-plugin` 关键词、按包名
  分类 plugin/api/client，mcp-client 仍属插件）+ 类型筛选；前端忒修斯之船（`WebuiClientProvider`
  契约 + 扫 `aalis.client` 通用发现 + `webui.client` 选活跃）；修 3 个 *-api 缺 marker 的潜伏 bug。
- ✅ 2026-06-15 **委托关系图**：authority `getDelegationGraph/Node` + 声明式 cytoscape 页（焦点子图
  对齐 getRelationGraph，owner→`*` 富化）；webui-client 去 private 可发布 + create-aalis 自动带前端；
  webui-server 前端发现改项目根 `createRequire`（修 pnpm 隔离 404）。
- ✅ 2026-06-14 **#3 权限重写为纯能力委托图**：owner=`*` / public-restricted 可见性 / 委托树
  （grantedBy + 子集约束）/ 裁决 deny>owner>public>granted / 临时 restricted 委托（按 sessionId 隔离）；
  users.json v3 净化无迁移；commands/tools/mcp/webui 全量切 visibility；AuthorityPage 重写。详见
  docs/core/authority.md。
- ✅ 2026-06 **npm 全生态 + 独立部署**：@aalis scope 发布；`@aalis/runtime`（Node host 层）+
  `create-aalis` 脚手架 + 市场 v1（keyword 检索 / 装卸 / 装前披露 / 卸载护栏）+ MIT 核心 / AGPL-webui 分层授权。
- ✅ 2026-06-13 **跨平台身份绑定**：运行时零合并 + 绑时一次性并集（denies 并集堵"绑定洗白封禁"）；
  token=console=owner；多用户用 `tokenMode: disabled` 收口（调研存档 multiuser-identity-survey.md）。
- ✅ 2026-06-12 **core 加固**：全文评审六组缺陷（EventBus 隔离 / sticky 补发 / hooks 快照 / dispose
  守卫等）+ 词汇审计五项 + 基底层依赖方向架构测试 + 命名空间事件模式入册。
- ✅ onebot 撤回**感知**（group_recall / friend_recall / group_message_delete 通知）。
