# 指令系统 — 已知缺陷与待办

指令的**注册、层级解析、参数/选项解析、执行守卫（授权 + 确认两轴）与帮助渲染**均已可用；
**同名冲突处理与帮助的权限过滤尚不完整**。

以下每条均经实测确认，记录根因与修法方向，避免后续重新调查。

## 注册

### 同名指令静默覆盖

两个插件注册同名指令时，**后者直接顶掉前者**，且只在日志里留一行 warn —— 用户在聊天界面零感知。

根因在 `packages/plugin-commands/src/commands.ts:102-110`：`command()` 发现 `node.declared`
已为真时，不拒绝、不换节点，而是**复用旧节点并清空可变字段**（`aliases` / `positionalArgs` /
`options` / `examples` / `handler` 全部置空），随后照常写入新描述与新 `pluginName`。唯一的外部信号是
`commands.ts:103` 的 `logger.warn('指令 /xxx 已存在，将被覆盖')`。

连带后果：`unregisterByPlugin` 按 `node.pluginName` 匹配（`commands.ts:190-193`），而节点的
`pluginName` 在覆盖时已改写成后者。于是**先注册的插件卸载时删不掉自己的节点（正确），但覆盖者卸载时会把
整个节点连根删掉** —— 被覆盖者的指令一并消失，且它不会被重新注册。

修法未定，两条路线互斥：

- **拒绝注册 + 显式报错**：`command()` 命中已 declared 节点时抛错，冲突在插件激活期暴露，由
  `activatePlugin` 的回滚兜住。语义干净，但会让「后装的插件装不上」。
- **保留覆盖，但把冲突提到用户可见层**：维持现行行为，在 WebUI 插件页/安装反馈里列出被顶掉的指令。
  不阻断安装，代价是覆盖仍是既成事实。

放大风险：Koishi 兼容层落地后，`help` / `status` / `echo` 这类常见名两边都会有。正因如此，
兼容层已定为把 Koishi 指令挂 `/koishi` 命名空间隔离（见同目录 `koishi-compat.md`），
但那只隔离了这一个来源，一方插件之间的同名冲突不受其保护。

## 可见性

### `/help` 与用法详情列出无权使用的指令

`CommandRegistry.getAll()`（`commands.ts:238-240`）无条件返回全部节点，`/help` 直接消费它
（`packages/plugin-commands/src/index.ts:254`）。`visibility: 'restricted'` 的 `shutdown` /
`restart`（`index.ts:297` / `index.ts:309`）因此对任何等级的用户可见。

更直接的一条是**裸敲分组指令**（如 `/relation`）：`execute()` 在权限守卫之前就返回完整子指令清单 ——
`commands.ts:292-294` 的 `if (!cmd.handler) return this.formatUsage(cmd)` 位于守卫调用
（`commands.ts:300-312`）之前。未知选项报错路径同理：`parseArgs` 在 `commands.ts:297` 被调用，其内部
`commands.ts:424` 与 `commands.ts:445` 的 `未知选项: --x\n\n${this.formatUsage(cmd)}` 同样先于守卫返回。

`/relation` 是最直观的样本：`relation` 本身从未被显式注册（`packages/plugin-user-relation/src/commands.ts`
只注册 `relation.*`），是 `ensureGroups` 自动建的无 handler 分组节点，于是裸敲它会把
`relation.cleanup.*` 这一串 `visibility: 'restricted'` 的子指令一并列给任何人。

定位：**这是降噪而非防泄漏**。开源项目里指令存在性本就公开（源码、文档、npm 包都写着），
过滤的价值是让低权限用户的帮助页只剩他真能用的东西。故优先级低。

修法：注入与执行侧**同源**的 authorize 判定，只取轴 A（可见性/等级），**明确排除**轴 B（confirm）
与临时授予。理由是后两者一个是 `async` 且会真弹确认框、一个随会话漂移：

- `authorize(identity, request)` 是**同步**的、纯等级裁决，返回 `string | null`
  （`packages/api-authority/src/index.ts:237`，实现见
  `packages/plugin-authority/src/authority-manager.ts:61-77`）—— 逐条跑无副作用、可用于列表渲染。
- `requestAccess` 是 `Promise<boolean>`（`api-authority/src/index.ts:255`），会调用
  confirmHandler 弹确认；`isPreApproved`（`:253`）虽同步但读的是会话级临时授予，
  同一条指令在列表里的可见性会随会话状态前后不一致。

接线点已经现成，**无需新增依赖**：

- `plugin-commands` 已在 `package.json:31` 依赖 `@aalis/api-authority`，
  且 `index.ts:380` 已有 `ctx.getService<AuthorityService>('authority')` 的先例（`/clear` 的共享会话设防）。
  `/help` 走这条路即可。
- `formatUsage` 在 `CommandRegistry` 内部、拿不到 `ctx`，且 `parseArgs(cmd, rawArgs)`
  （`commands.ts:404-407`）签名里根本没有调用者身份。要过滤这两条路径，需把身份从 `execute()` 的
  `input` 往下透传，或在 `setExecutionGuard`（`commands.ts:84-86`，由
  `packages/plugin-authority/src/index.ts:116-124` 注入）旁边加一个同源的同步可见性钩子。

### 直敲受限指令的拒绝文案暴露其存在

上一条的另一半。低权限用户直敲受限指令，守卫会返回
`权限不足: "command:xxx" 需等级 N（当前 M）`（`packages/plugin-authority/src/authority-manager.ts:75`），
**存在性照样暴露**。只堵 `/help` 而不动这条，等于只堵一半。

这条触及 authority 的通用拒绝文案 —— 它同时服务 tools 与 commands 两个注入点
（`plugin-authority/src/index.ts:116-124`），改成「未知指令」式的模糊回应会牵动所有能力的拒绝语义，
**改动面大于收益**，暂不动。但需与上一条**一并决策**：要么两条都做（含文案），要么两条都不做，
只做 `/help` 过滤是自欺。

## 遗留：`/help` 详情仍靠代码块围栏规避 autolink

`/help` 两段式与统一渲染器已落地（`db487bad`，见 `plugin-commands/src/help.ts`），
`remark-breaks` 也已补上（裸换行不再被合并成一段）。剩下的只有一条：详情正文整体包进代码块
（`help.ts:152`）是**规避**而非解决。

规避的对象**不是**「缺 `rehype-raw`」——那条记载已被实测证伪，两个理由各自都足够：

1. **它修不了症状，反而更糟。** 实测 `--type <type>` 现状渲染为 `&lt;type&gt;`（正确显示）；
   加上 `rehype-raw` 后变成空的自定义元素 `<type></type>`，肉眼不可见。
2. **它是确凿的 XSS 面。** 该渲染器用于 ChatPanel / SessionsPage，喂进来的是 LLM 输出与
   用户消息。实测 `<img src=x onerror="alert(1)">` 现状被安全转义，加上 `rehype-raw` 后成为
   真实 `<img>` 并触发预加载。真要开放 raw HTML 必须同时上 `rehype-sanitize`，那是一个
   独立议题，不是「补个插件」。

真正的症状是 **autolink**：`<name:string>` 被 CommonMark 解析成链接，渲染出
`<a href="">name:string</a>`。要拆掉围栏，得在**产出侧**处理（转义尖括号，或把占位符写进
行内代码），而不是在渲染侧加插件。

复现方式：`renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{'用法: /persona set <name:string> --type <type>'}</ReactMarkdown>)`。
