# Issues & Roadmap

> 四区：**待办**（还没做的事，按优先级）→ **已知限制**（接受的妥协，非 bug）→
> **已决议**（长期约束，避免反复讨论）→ **已完成**（单行归档，细节看 commit/docs）。
> 最近核对：2026-06-15。**当前无已知未修复 bug**（近期对抗审查发现的都已在 0.2.0 修掉）。

## 待办（还没做，按优先级）

1. **`code_runner` 进程级隔离 / 容器化**（唯一安全相关项）：图灵完备工具的代码参数需沙箱，
   否则可越出工作区任意执行。是已知最后一个真洞，但需进程/容器隔离设施，属功能级工程。
2. **第三方前端端到端实测**：装一个非默认 `aalis.client` 包，验证「发现 → 切换 → reload 加载」全链路
   （切换 UI 已做，见归档；目前只用默认前端验证过 UI 路径）。
3. **scoped/app 沙盒**：per-user 受限 WebUI 视图（资源默认私有 + 创建者授权）；需先解决
   scope 事件总线不隔离。
4. **onebot 主动撤回**（bot 撤回自己发的消息；撤回「感知」已做）。
5. **文档内图片识别**（file-reader / office 尚无）。
6. **GUI 修复缺失依赖**（暂缓）：读项目 deps + 检 node_modules 缺失 + 一键按名重装。

## 已知限制（接受的妥协，非 bug，记录在案）

- `'ready'` 与 `'app:started'` 语义重叠：合并属破坏性变更，暂保留双事件，新代码优先用 `'app:started'`。
- `ScopedConfigManager` 用「extends + 全量覆写 + 反射防漂移单测」而非纯组合：基类新增公开方法
  须同步覆写（test/core/config.test.ts 设防）。
- 插件 page-action 默认 `restricted`（仅 owner）：现有 actions 全是 WebUI 管理操作，owner-only 即正确；
  将来若出现面向普通用户的 action，再单标 `actionsMeta: { visibility: 'public' }`。

## 已决议（长期约束）

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

- ✅ 2026-06-15 **按时间区间取消息**：`session_get_history` 工具加 `within_minutes` / `since` / `until`
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
