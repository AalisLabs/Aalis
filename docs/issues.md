# Issues & Roadmap

> 分区约定：**待办问题**（需要修/设计的缺陷与风险）→ **新功能计划**（roadmap）→
> **已决议事项**（仅保留**长期约束** + **尚未落地**的方向性结论；已实现的决议下沉归档，
> 减少心智负担）→ **已完成归档**（单行索引，细节看 commit 与 docs）。
>
> 最近一次全面核对：2026-06-15。

## 待办问题

### #9 core 设计层面的已知妥协（低优先级，记录在案）

- `'ready'` 与 `'app:started'` 语义重叠（均为 sticky 启动里程碑，仅触发时点略异：
  ready=服务就绪后、started=watch 建立后）。合并属破坏性变更，暂保留双事件并以
  文档区分；新代码优先用 `'app:started'`。
- `ScopedConfigManager` 采用「extends + 全量显式覆写 + 反射防漂移单测」而非纯组合
  （纯组合需抽接口，波及 `Context.config` 全链类型）。基类新增公开方法时**必须**
  同步覆写，否则 test/core/config.test.ts 的防漂移用例会拦下。

### #10 权限模型残留（#3 主体已完成归档，仅剩两条非阻塞项）

- ⏭️ `code_runner` 图灵完备参数需进程级隔离（容器化，= 新功能 #5）——最后一个已知真洞。
- ⏭️ 为各插件 action 渐进标注 `actionsMeta: { visibility: 'public' }`（默认 restricted；
  authority 的 createBindCode/unlinkIdentity 已开先例；非阻塞）。

## 新功能计划

1. **市场 v2 剩余**：前端「切换活跃前端」图形开关（现可经 `webui.client` 配置切换，缺 UI）+
   第三方前端端到端实测。市场主体（含 api/前端 入市 + 0.2.0 协调发布）已完成，见归档。
2. scoped/app 沙盒（第二期）：per-user 受限 WebUI 视图——按身份裁剪页面/数据可见性，
   应补「资源默认私有 + 创建者授权」粒度（见多用户调研归档）；createScope 级别的运行时
   视图隔离需先解决 scope 事件总线不隔离的问题。
3. 文档内图片识别（file-reader/office 尚无）。
4. onebot **主动撤回**（bot 撤回自己发出的消息）——撤回**感知**已实现（见归档）。
5. 指令执行容器化——为 `code_runner` 图灵完备入口提供进程级隔离（#10 依赖项）。
6. 通用「按时间区间取消息」——memory-history 跨会话检索已有时间窗 `maxAgeMinutes`（见归档），
   单会话/任意区间通用查询仍可补。
7. **GUI 修复缺失依赖**（用户 2026-06-15 暂缓）：读项目 deps + 检 node_modules 缺失 +
   一键按名重装（doctor 风格，覆盖 api/core，不污染发现流）。

## 已决议事项（长期约束）

- 📌 core 设计理念（评审/修复时的不变约束）：**环境无关**（不读 process.env / 不碰 I/O，
  一切经 provider 注入）、**抽象化**（IoC + 事件 + 钩子 + 能力声明，不感知业务）、
  **最简化**（不引第三方运行时依赖，API 面最小）、**忒修斯之船**（任何插件可被热替换，
  core 自身各子系统也可经 AppOptions 注入替换；前端亦然——见市场 v2 归档）。
- 📌 AalisEvents **保持类型封闭**（对扩展开放、对拼写错误封闭）：契约可枚举、依赖边在
  包图中可见；动态事件名的官方出路是命名空间模板字面量签名
  （`` [k: `myns:${string}`]: [payload: T] ``，见 docs/core/events.md 与 plugin-author-guide §10）。
- 📌 core **不拆 kernel 包**：包是发布/版本化单位而非模块化单位；declaration merging 锚定
  在 `'@aalis/core'` 包名上。重新评估触发条件：①core 发 npm 且要给基底层单独 1.0 承诺；
  ②出现 kernel-only 真实消费者；③多人协作需要 Conway 边界。「基底层不得 import 编排层」
  由 test/core/architecture.test.ts 设防。

## 已完成归档（单行索引）

> 含设计决策落地：早期决议（权限模型、多用户绑定、市场形态）实现后从「已决议」下沉至此；
> 完整 rationale 见对应 docs（authority.md / multiuser-identity-survey.md）。

- ✅ 2026-06-15 **0.2.0 协调全量发布**：feat 分支全并入 dev 并清理（只剩 dev/main，ff main→dev）；
  90 包统一 bump 0.2.0（重写 = breaking，0.x minor；高于 npm 所有版本零冲突一次性发）+ 83 处
  peerDep `@aalis/* ^0.1.0→^0.2.0`（包间 deps 是 workspace 自动解析）。npm 已发布、CI 绿；
  npm search `keywords:aalis-plugin` 现返回 83 包（59 插件 + 23 api + 1 前端）→ 市场 api/前端
  类目实际可见，新前端 webui-client 与新后端 0.2.0 配套（也补上 npm-WebUI 缺口）。
- ✅ 2026-06-15 **市场 v2 + 前端可换（忒修斯之船）**：api 契约 + 前端纳入市场（统一沿用
  `aalis-plugin` 关键词、给 21 api+3 补 marker 的 api + webui-client 加词；按包名分类
  plugin/api/client，`mcp-client` 仍归功能插件）；MarketplacePackage.category + 前端类型
  筛选（默认仅功能插件）；create-aalis 目录剔除 api/前端。前端可换：webui-api 形式化
  `WebuiClientProvider` 契约、webui-server 通用发现（扫项目 deps 的 `aalis.client` marker，
  保留 monorepo 兜底）+ `webui.client` 配置选活跃。顺手修 3 个 *-api 缺 `aalis.types` marker
  的潜伏 bug。**剩余**：图形切换 UI（见新功能 #1）。
- ✅ 2026-06-15 委托关系图 + WebUI 前端 npm 分发修复（da1812b）：authority getDelegationGraph/
  Node + 声明式「委托关系图」页（复用 cytoscape，焦点子图协议对齐 getRelationGraph）；
  webui-client 去 private 可发布 + create-aalis 选 WebUI 自动带前端；webui-server 前端发现改
  按项目根 createRequire 解析（修 pnpm 隔离 404）。对抗审查修两处（图交互协议、pnpm 路径）。
- ✅ 2026-06-14 **#3 权限重写为纯能力委托图**（feat/auth-capability）：废除数字等级/safety/
  per-command override；owner=`*` + public/restricted 可见性 + 委托树（grantedBy + 子集约束）+
  裁决 deny>owner>public>granted + 临时 restricted 委托（按 sessionId 隔离）；users.json v3
  净化无迁移；commands/tools/mcp/webui 全量切 visibility；前端 AuthorityPage 重写为委托树 +
  能力集编辑 + 可见性覆盖。模型详见 docs/core/authority.md。
- ✅ 2026-06 npm 全生态 + 独立部署 + 市场 v1：@aalis scope 发布；`@aalis/runtime`（host 层）+
  `create-aalis` 脚手架（`npm create aalis`，live 选插件）；插件市场 v1（npm `keywords:aalis-plugin`
  检索 + 装/卸 + 富展示 + 装前能力披露 + 卸载护栏）；MIT 核心 + AGPL webui 分层授权。
- ✅ 2026-06-13 多用户绑定语义定型（调研存档 multiuser-identity-survey.md）：运行时零合并 +
  绑时一次性并集（denies 并集堵"绑定洗白封禁"）；token=console=owner；多用户用
  `tokenMode: disabled` 收口（无账户时 token 兜底防锁死）。
- ✅ 2026-06-13 跨平台身份绑定：绑码/消费/解绑、/bind 仅私聊、WebUI 配套（1581b2e）。
- ✅ 2026-06-12 #8 core 全文评审六组缺陷（254c2c0）：EventBus per-handler 隔离与
  onHandlerError、sticky 补发捕获、whenService 对齐当前胜者、hooks run 快照查活、
  ScopedConfigManager 覆写+防漂移单测、recompute 排队/dispose 守卫等（顺手修 tool-onebot
  监听不存在事件的真 bug）。
- ✅ 2026-06-12 core 词汇审计五项：SchemaFieldTypes 注册表、Logger 接口化、政策注入、
  SafetyLevel/PermissionId 迁 authority-api、actions 槽位同车迁移。
- ✅ 2026-06-13 基底层依赖方向架构测试 + 命名空间事件模式入册（78e162d）。
- ✅ 包根漏导出 ServiceTypeMap/ServiceOf（d222483）：15+ api 包 merging 静默失效修复。
- ✅ onebot 撤回**感知**：适配器处理 group_recall/friend_recall(v11)/group_message_delete(v12) 通知。
