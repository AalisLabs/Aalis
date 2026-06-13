# Issues & Roadmap

> 分区约定：**待办问题**（需要修/设计的缺陷与风险）→ **新功能计划**（roadmap）→
> **已决议事项**（方向性结论，避免反复讨论）→ **已完成归档**（单行索引，细节看
> commit 与 docs）。编号沿用历史（#3、#9 等），新条目顺延编号。

## 待办问题

### #3 权限体系收尾（主体已完成并实测，见归档与决议）

- ⏭️ `code_runner` 图灵完备参数需进程级隔离（容器化，新功能 #6）——最后一个已知真洞。
- ⏭️ 为各插件 action 标注低于 owner 的 `actionsMeta` 等级（authority 的
  createBindCode/unlinkIdentity 已开先例 authority:1；渐进式松绑，非阻塞）。

### #9 core 设计层面的已知妥协（低优先级，记录在案）

- `'ready'` 与 `'app:started'` 语义重叠（均为 sticky 启动里程碑，仅触发时点略异：
  ready=服务就绪后、started=watch 建立后）。合并属破坏性变更，暂保留双事件并以
  文档区分；新代码优先用 `'app:started'`。
- `ScopedConfigManager` 采用「extends + 全量显式覆写 + 反射防漂移单测」而非纯组合
  （纯组合需抽接口，波及 `Context.config` 全链类型）。基类新增公开方法时**必须**
  同步覆写，否则 test/core/config.test.ts 的防漂移用例会拦下。

## 新功能计划

1. scoped/app 沙盒（第二期）：per-user 受限 WebUI 视图——按身份裁剪页面/数据可见性，
   应补「资源默认私有 + 创建者授权」粒度（Open WebUI/LibreChat 共同底线，见调研决议）；
   createScope 级别的运行时视图隔离需先解决 scope 事件总线不隔离的问题。
2. 插件市场 / 商店（启动条件已满足：#3 契约定型；上架审查为强制关卡，见决议）。
3. 文档内图片识别。
4. onebot 消息撤回 / 感知对方消息是否被撤回。
5. 按会话/时间/区间取最近消息（当前只有会话维度，没有时间限制）。
6. 指令执行容器化——为 `code_runner` 等图灵完备入口提供进程级隔离（#3 的依赖项）。

## 已决议事项

- 📌 2026-06-12 市场/重写/仓库形态：**先落地 #3 capability 权限重设计（插件契约定型），
  再启动插件市场**；上架流程作为逐插件安全审查的强制关卡。仓库保持 monorepo，
  **暂不发布 npm**，市场先只索引 monorepo 内插件（本地安装，package-manager 已支持）。
  整体重写（原 #0）**不做**：问题集中在权限横切面，借上架审查逐插件修缮性价比更高。
- 📌 core 设计理念（评审/修复时的不变约束）：**环境无关**（不读 process.env / 不碰 I/O，
  一切经 provider 注入）、**抽象化**（IoC + 事件 + 钩子 + 能力声明，不感知业务）、
  **最简化**（不引第三方运行时依赖，API 面最小）、**忒修斯之船**（任何插件可被热替换，
  core 自身各子系统也可经 AppOptions 注入替换）。
- 📌 2026-06-12 AalisEvents **保持类型封闭**（对扩展开放、对拼写错误封闭）：契约可枚举、
  依赖边在包图中可见；动态事件名的官方出路是命名空间模板字面量签名
  （`` [k: `myns:${string}`]: [payload: T] ``，已写入 docs/core/events.md 与
  plugin-author-guide §10）。
- 📌 2026-06-12 core **不拆 kernel 包**：包是发布/版本化单位而非模块化单位；declaration
  merging 锚定在 `'@aalis/core'` 包名上。重新评估触发条件：①core 发 npm 且要给基底层
  单独 1.0 承诺；②出现 kernel-only 真实消费者；③多人协作需要 Conway 边界。
  「基底层不得 import 编排层」由 test/core/architecture.test.ts 设防。
- 📌 2026-06-13 权限模型定型：**capability 图为唯一裁决机制，数字等级 = 内置角色链
  的命名**（level-1 ⊂ … ⊂ owner）。否决"等级 + 节点图双轨并行"（Koishi 双轨为反面
  教材）；插件 `authority: number` 声明照写，语义为"capability 归入 level-N 角色包"。
  裁决优先级：permissionPolicy > 用户 deny > 用户 grant > 角色链门槛（per-capability）。
- 📌 2026-06-13 多用户设计调研决议（22 源、25 论断对抗验证，存档
  docs/architecture/multiuser-identity-survey.md）：**当前体系不重构**；绑定语义定型为
  **运行时零合并 + 绑时一次性合并**（吸收 Koishi 指针模型，denies 并集堵"绑定洗白
  封禁"，绑时 max 合并避免降级惊喜）；参数级提权保留（被调研系统无对应物是因为无
  "agent 配任意文件写工具"的威胁形态）；token=console=owner 语义保留（持有 token ≈
  控制服务器），多用户部署用 `tokenMode: disabled` 收口（无账户时 token 兜底防锁死）。

## 已完成归档（单行索引）

> 2026-06-13 全量核验：以下记载的修复均经 18 个核验代理在当前代码中逐条实证后才压缩为单行。

- ✅ 2026-06-13 tokenMode=disabled 多用户收口 + capability 全面展示（5edfe1b）。
- ✅ 2026-06-13 跨平台身份绑定：绑码/消费/解绑、/bind 仅私聊、WebUI 配套（1581b2e）。
- ✅ 2026-06-13 #3/#1 第三版：authorize 统一闸 + users.json v2（per-user grant/deny）+
  多用户账密登录（PBKDF2+session）+ REST 全路由三档过闸 + 同车项（actions 迁
  webui-api、ActionCaller 并入 UserIdentity）+ 平台候选/CLI 身份修复
  （27dfc1b/a9d5c2d/c2c11d6/68e3697/296d153/d371283/0584bfd）；登录闭环实测 22/22。
- ✅ 2026-06-12 #3 第二版三件套：参数级动态提权（storage:path 路径级，单调只升）+
  WebUI page-action 闸 + 拆除 bypassGuard（首版 surface 中心方案回退于 54d4b18）。
- ✅ 2026-06-12 #8 core 全文评审六组缺陷（254c2c0）：EventBus per-handler 隔离与
  onHandlerError、sticky 补发捕获、whenService 对齐当前胜者、hooks run 快照查活、
  ScopedConfigManager 覆写+防漂移单测、recompute 排队/dispose 守卫/AalisEvents
  封闭等杂项（顺手修 tool-onebot 监听不存在事件的真 bug）。
- ✅ 2026-06-12 core 词汇审计五项：SchemaFieldTypes 注册表（4f2af20）、Logger 接口化
  （AppOptions.logger 注入）、trimUnknownFields/autoEnableDisabled 政策注入、
  SafetyLevel/PermissionId 迁 authority-api（3a4317b）、actions 槽位同车迁移。
- ✅ 2026-06-13 基底层依赖方向架构测试 + 命名空间事件模式入册（78e162d）。
- ✅ 包根漏导出 ServiceTypeMap/ServiceOf（d222483）：15+ api 包 merging 静默失效修复。
