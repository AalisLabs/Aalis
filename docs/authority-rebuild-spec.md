# Authority 完整重构 · 详细规格（待审）

> 目标读者：Ace（决策）。本文是**实现前的契约**，过目确认后才开 `feat/authority-rebuild` 编码。
> 状态：草案 v1，待审。文末「开放问题」是需要你拍板的真分叉。

## 0. 为什么重构（病因定位）
当前 authority 对**单 owner** 场景过度设计且前端不可用：
- 前端 6 个面板（指令可见性／工具可见性／受限禁用清单／用户与委托／委托关系图／临时放行策略），互相概念重叠，按钮难懂。
- 委托编辑器把**全部**指令+工具平铺（几百条）逐条勾选 —— 反人类。
- 委托树（子委托 + subset 约束）、跨平台绑定 —— 单 owner 没有"下层管理员"也没有"多账户"，纯负担。
- 残留多用户观感（顶栏把 console 当用户名 + 登出、`/api/auth/me` 与 `/api/auth/status` 重复）。

**结论**：核心模型是干净的（你最近设计的、测试齐全），债在**委托粒度 + 前端 UX + 残留**。本次重构 = 留核心、重写前端、简化委托层、清残留。**不回退老版本**（已证接不上：10 个消费方绑死新两轴契约、旧 core 能力 DI 已删）。

---

## 1. 保留不动（动它就会连累 10 个消费方，禁止改）
这些是 commands / tools / mcp / webui-server / cli / session-confirm 依赖的**跨切面契约**，保持签名不变：
- **能力模型核心** `capability-model.ts`：`capMatches` / `matchAnyCap` / `hasCapability`（`deny>owner>public>grant`）。`rejectedDelegations` 可删（见 §3）。
- **两轴概念**：可见性 `public|restricted`（轴 A）+ 确认 `session|always`（轴 B），正交、owner 也吃 confirm。
- **执行守卫契约** `ExecutionGuard` / `ExecutionGuardContext` / `setExecutionGuard` 注入；`resolveCapabilityPolicy` / `riskDefaults`（risk→默认展开）。
- **AuthorityService 关键方法**（消费方在调）：`isOwner`、`authorize`、`requestAccess`、`setConfirmHandler`、`listTemporaryGrants`/`revokeTemporaryGrant`、`save`、`listUsers`。
- **owners 配置** + `console`/`cli:console` 恒 owner。
- **能力串命名**：`command:<name>` / `tool:<name>` / `action:<plugin>:<method>` / `storage:...`。

> 净效果：守卫、REST gate、会话确认这些**不动**，重构只触及 authority 内部委托层 + WebUI 整页 + 配置 + actions surface。

---

## 2. 数据模型（users.json v3 → 仍 v3，记录瘦身）
```ts
// 单用户记录（瘦身后）
interface UserRecord {
  caps?: { grant?: string[]; deny?: string[] };  // 保留
  // grantedBy?  —— 删（委托树砍掉，见 §3）
}
```
- `grantedBy` 字段移除（无子委托树）。
- load 时只取 `caps`，顺带剔除旧残留（已在多账户剥离里实现的 scrub 逻辑扩展为也剔 `grantedBy`）。
- 版本仍 3，无破坏性迁移；旧 `grantedBy` 静默丢弃。

---

## 3. 委托层简化（后端）
- **砍委托树**：删 `grantedBy`、`listDelegatees`、`setUserCapabilities` 里的非-owner 子集约束（owner/子树/deny 三道校验整段）。理由：单 owner 下只有 owner 一个授权者，subset 防越权无对象。
- `setUserCapabilities(granter, target, caps)` → 简化为 **`setUserCapabilities(target, caps)`**（granter 永远是 owner 上下文；CLI `/grant`、WebUI action 都以 owner 身份调）。`rejectedDelegations` 随之删。
- **保留临时能力委托**（`requestAccess` + 会话内 YS 授予 + `restrictedPolicy` 自动放行）：这是**确认轴**和**自动化逃生阀**，与委托树无关，留。
- `resolve()` 已是"读自身记录"（多账户剥离后），不变。

---

## 4. 配置 schema 变化（AalisConfig）
| 字段 | 处置 |
|---|---|
| `owners` | 保留 |
| `deniedCapabilities` | 保留（全局硬禁 glob，连 owner 压过，少用但有用） |
| `restrictedCapabilities` | **折叠**进「操作」视图的逐条/整组「设为受限」开关（语义等价：标记某 op 为 restricted）。底层仍可存为该字段，UI 不再要求手写。 |
| `visibilityOverrides` | 保留，但**键从裸 `name` 改为 `type:name`**（修 command↔tool 同名互相覆盖 bug） |
| `confirmOverrides`（**新增**） | `Record<'type:name', 'session'\|'always'\|'off'>`，owner 逐操作开关确认。守卫：`confirm = confirmOverrides[key] ?? pluginDeclared`；`'off'` 强制关。 |
| `restrictedPolicy` | 保留（自动化逃生阀） |

守卫 visibility/confirm 解析（authority/index.ts guard，键统一 `type:name`）：
```
const key = `${g.type}:${g.name}`;
visibility = visibilityOverrides[key] ?? g.visibility;
confirm    = confirmOverrides[key] === 'off' ? undefined
           : (confirmOverrides[key] ?? g.confirm);
```

---

## 5. AuthorityService 契约变化
- **删**：`listDelegatees`。
- **改**：`setUserCapabilities(target, caps)`（去 granter 参 + 去 subset 抛错）。
- **AuthorityUserEntry** 去 `grantedBy`（已无 hasPassword/links/linkedTo）。
- 其余（isOwner/authorize/requestAccess/temp grants/setConfirmHandler/save/listUsers）**不变**。
- 新增（供「最近活跃身份」用，可选，见开放问题）：authority 在 `authorize` 时把非-owner 身份记入一个**有界 LRU（如 50 条，仅内存，不持久化）**；`listRecentIdentities()` 返回，供前端"添加用户"时下拉建议。

---

## 6. 前端「操作」视图（替代 指令可见性+工具可见性+受限禁用清单）
一个统一列表，**按插件分组**，每条/每组可调默认可见性与确认。
```
┌ 操作（指令 + 工具的默认权限）──────────────────────────────┐
│ 搜索: [____________]            [展开全部] [折叠全部]         │
│                                                              │
│ ▾ @aalis/plugin-weather                  [整组▾: 公开]       │
│    /weather   指令   可见性[公开｜受限]  确认[关｜会话｜每次] │
│    weather_now 工具  可见性[公开｜受限]  确认[关｜会话｜每次] │
│ ▾ @aalis/plugin-shell                    [整组▾: 受限]       │
│    shell.exec 工具   可见性[公开｜●受限] 确认[关｜会话｜●每次]│  ← 改过的高亮
│ ▸ @aalis/plugin-okx-trading              [整组▾: 受限]  ⚠️   │
└──────────────────────────────────────────────────────────┘
```
行为：
- 「整组▾」一键把该插件所有操作设 公开/受限（粗粒度，解决"几百条逐条"）。
- 每条仍可单独覆盖。被 owner 覆盖（≠插件默认）的高亮 + 「恢复默认」。
- 写入 `visibilityOverrides[type:name]` / `confirmOverrides[type:name]`。
- 危险插件（声明 `risk:'dangerous'`）行带 ⚠️。

---

## 7. 前端「用户」视图（替代 用户与委托+委托关系图+临时放行策略）
管理**非 owner 外部身份**的权限。owner 不在此管（owner=全部，在「Owner」小区块单列）。
```
┌ 用户（外部身份的权限例外）────────────────────────────────┐
│ [+ 添加身份]  最近活跃: [onebot:12345 ＋][onebot:67890 ＋]  │
│                                                            │
│ onebot:12345        预设[封禁｜受限｜●普通｜信任｜自定义]   │
│    自定义时展开 ↓（按插件组，非逐条）                        │
│    ▾ weather   [默认｜●允许｜拒绝]                          │
│    ▾ shell     [默认｜允许｜●拒绝]                          │
│    高级 glob（可选）: grant[______] deny[______]            │
│    [保存] [删除身份]                                        │
└──────────────────────────────────────────────────────────┘
```
**预设语义**（一键，底层翻译成 grant/deny）：
| 预设 | 含义 | 底层 |
|---|---|---|
| 封禁 | 啥都不能用 | `deny: ['*']` |
| 受限 | 比普通更紧（连部分 public 也收）| `deny: [<owner 选的组>]`（默认空=同普通，可加） |
| 普通 | 默认（public 可用，restricted 不可） | 无记录 / `caps` 空 |
| 信任 | 可用受限项（≈ 半 owner） | `grant: ['*']`（deny 仍压过；不等于 owner，不能改权限/动 owner） |
| 自定义 | 按插件组允许/拒绝 + 高级 glob | 见上 |

**粗粒度核心**：自定义编辑器按**插件分组**给 默认/允许/拒绝（写该组 glob 如 `tool:weather*`/具体成员并集），**不再平铺几百条**。高级 glob 框给少数高手。

---

## 8. 删除清单
- 前端：`AuthorityPage.tsx` 整页重写；删委托关系图页（`authority-graph` webuiPage + `getDelegationGraph`/`getDelegationNode` actions）或降级为只读（见开放问题）；删 `.authority-unlink-btn` 等死样式（已删）。
- 后端 actions：删 `getDelegationGraph`/`getDelegationNode`（若图砍）；`createBindCode`/`unlinkIdentity`/`setPassword`（已删）；`setUserCapabilities` 简化；新增 `listRecentIdentities`、`setConfirmOverride`。
- authority-manager：删 `listDelegatees` + subset 校验段 + `grantedBy`。
- capability-model：删 `rejectedDelegations`。
- 顶栏（App.tsx）：去伪用户名展示，登出按钮保留但克制呈现（token 模式下文案"退出 WebUI"）。
- 合并 `/api/auth/me` 与 `/api/auth/status`（留一个，前端统一）。

---

## 9. 迁移与兼容
- users.json：v3 不变；旧 `grantedBy`/`links`/`secret` load 时静默剔除（向后兼容，不破坏既有 grant/deny）。
- config：旧 `visibilityOverrides`（裸 name 键）→ 启动时一次性迁移为 `type:name`（按当前注册的 op 推断 type；冲突/不可推断的保留原样并告警）。`restrictedCapabilities` 继续支持读取。
- 旧 `restrictedPolicy` 不变。

---

## 10. 测试计划
- 保留并适配：`authority-manager.test`（去 subset/delegatee 用例）、`authority-actions.test`、`authority-dynamic.test`、`webui-auth.test`、`capability-model` 隐含覆盖。
- 新增：`confirmOverrides` 守卫解析、`visibilityOverrides` type:name 键不再 command↔tool 串、预设→grant/deny 翻译、整组开关写入。
- 前端：组件渲染 + 关键交互（整组切换、预设、保存）至少 smoke。
- 闸门：每阶段 `pnpm run ci:local` + `knip` 绿。

---

## 11. 分阶段实施（每阶段独立绿、可中途暂停）
1. **后端简化**：砍委托树（grantedBy/listDelegatees/subset/rejectedDelegations）+ 简化 setUserCapabilities + 适配测试。
2. **配置 + 守卫**：visibilityOverrides 键迁移 + confirmOverrides 新增 + 守卫解析 + 测试。
3. **actions surface**：getOverview 重塑（按插件分组）+ listRecentIdentities + setConfirmOverride + 预设翻译。
4. **前端「操作」视图**重写。
5. **前端「用户」视图**重写 + 顶栏/auth 端点清理。
6. 收尾：删委托图（或降级）、文档、ci:local + knip。

---

## 12. 开放问题（需你拍板）
1. **委托关系图**（authority-graph 页 + cytoscape）：单 owner 下委托树砍了，图基本只剩"owner→能力"。**砍掉整页** / 还是**降级为只读小图**？（建议：砍）
2. **「受限」预设**：默认等同"普通"（空），还是要预置一组常见 deny？（建议：默认空，owner 自定义）
3. **restrictedCapabilities 全局清单**：折叠进「操作」视图后，是否还保留一个"高级全局 glob"入口给高手？（建议：保留只读展示 + 高级编辑折叠）
4. **最近活跃身份**：要不要 authority 自记 LRU 50 条做下拉建议？（建议：要，轻量、解决"记不住 QQ 号"）
5. **分支**：`feat/authority-rebuild` off dev（建议），还是直接 dev？
