# plugin-agent — 默认对话编排器

**包名**: `@aalis/plugin-agent`  
**源码**: `packages/plugin-agent/src/index.ts`

## 概述

默认的 `AgentService` 实现，负责编排完整的对话流程：组装提示词 → 加载历史 → 收集工具 → 调用 LLM → 工具循环 → 发送回复。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-agent',
  provides: [agent],
  uses: {
    logger,
    config,
    events,
    hooks,
    contributions,
    lifecycle,
    provide,
    services,
    commands: optional(commands),
    tools: optional(tools),
    llm: optional(llm),
    memory: optional(memory),
    persona: optional(persona),
    messageArchive: optional(messageArchive),
    sessionManager: optional(sessionManager),
    platform: optional(platform),
    media: optional(media),
    storage: optional(storage),
    gateway: optional(gateway),
    plugins: optional(pluginsService),
  },
  apply: run,
})
```

`hooks` 与 `contributions` 是 required 服务，分别由 [`@aalis/plugin-hooks`](./plugin-hooks.md) 与 [`@aalis/plugin-contributions`](./plugin-contributions.md) 提供；缺少任一时本插件停在 pending。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultLLM` | llm-ref | — | 默认对话模型：全局默认 LLM。apply 时经 `services.prefer(llm, \`${provider}/${model}\`)` 锁定偏好。会话 / 平台 profile 未覆盖时生效。 |
| `systemPrompt` | textarea | `''` | 行为准则提示词：定义 Agent 的行为准则。当人设插件存在时，身份描述由人设提供，此处仅作为行为指令追加。 |
| `memoryTokenBudget` | number | `4096` | 长期记忆预留 Token：为注入的 system 消息预留的 token 额度，超出时先按比例缩减，极端情况下（阶段 5）仍会删除 |
| `historyLimit` | number | `50` | 历史消息条数：从记忆中加载的最近对话历史条数 |
| `maxToolIterations` | number | `30` | 最大工具迭代：工具调用循环的最大迭代次数 |
| `promptBuildTimeoutMs` | number | `10000` | 提示词贡献构建超时 (ms)：单个 agent:prompt 贡献 build 的等待上限。挂死的构建（如网络检索卡住）超时后本轮缺席、其余照常，避免拖住每次 LLM 调用。0 表示不设限。 |
| `toolResultMaxRatio` | number | `0.15` | 工具结果最大比例：单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断。例如 0.15 表示 15% |
| `trimThresholdRatio` | number | `1` | 裁剪触发比例：裁剪预算 = 上下文长度 × 该比例 − 最大输出 token − 512 安全余量（下限 1024）。本次调用估算输入 token 超过该预算才会对消息列表做内存裁剪（不影响 DB）。默认 1.0 表示用满扣除输出预留后的可用窗口；调低可提前裁剪。压缩触发请在“@aalis/plugin-memory-summary”中配置。 |

## 指令

本插件注册以下斜杠指令（由 `commands` 服务统一解析）：

| 指令 | 说明 |
|---|---|
| `/model [关键词]` | 列出 / 搜索可用对话模型（分页，`-p <n>` 翻页） |
| `/persona [关键词]` | 列出 / 搜索可用人设（分页，`-p <n>` 翻页） |
| `/session` | 查看当前对话生效的模型 / 人设 / thinking / 名称，及各自来源与解析链 |
| `/session.set` | 设定**会话级**覆盖（持久化，重启不丢） |
| `/session.reset` | 复位会话级覆盖：默认清模型 + 人设 + thinking，`-m`/`-p`/`-t` 单独清对应项（显示名不在此列） |

`/session.set` 的选项：

| 选项 | 值 | 说明 |
|---|---|---|
| `-m` | `provider/model` | 模型引用，即 LLM entry 的 contextId；用 `/model` 列出可选值 |
| `-p` | 人设卡名 | 不含后缀 |
| `-t` | `on` / `off` | thinking 开关 |
| `-n` | 显示名 | 会话显示名称 |

```
/session.set -m @aalis/plugin-llm-openai:main/gpt-4o -p catgirl
/session.set -p strict-reviewer
/session.set -t off
/session.set -n 深夜助手
```

> 全局默认模型由本插件的 `defaultLLM` 配置项决定；会话级设置优先于它。

## 核心流程

1. **`agent:input:before`**: 消息预处理 / 拦截；中间件不调用 `next()` 则以下步骤（含 LLM 调用）均不执行
2. **构建系统提示词**: persona 提示词 + 配置的 `systemPrompt`（无人设时仅 `systemPrompt`），末尾固定追加输入约定块
3. **加载历史**: 从 memory 服务获取最近 `historyLimit` 条消息，跳过不完整的工具调用组与控制类消息
4. **收集工具**: 从 `tools` 服务获取工具定义：无分组的通用工具恒在，带分组的只取会话生效配置 `enabledToolGroups` 列出的分组（`'*'` 为全部，未配置则一个都不取）
5. **执行 Hook 管道**:
   - 组装 `agent:prompt` 贡献 — 记忆 / 摘要 / 技能 / 档案等提示词块按锚位物化进消息列表，单个贡献 build 超过 `promptBuildTimeoutMs` 时本轮缺席
   - `agent:llm:before` — 拦截、修改消息列表或工具列表（如工具搜索过滤、媒体规范化）
   - `trimMessages()` — 按 token 预算裁剪上下文
   - `chatStream()` — 流式调用 LLM
   - `agent:llm:after` — 处理 LLM 响应
   - 工具调用循环（最多 `maxToolIterations` 次）:
     - `agent:tool:before` → 执行工具 → `agent:tool:after`
   - `agent:reply:before` — 后处理回复内容
   - `agent:turn:after` — 消息处理完成通知
6. **保存**: 用户消息在回合开始时经 message-archive 归档；每轮工具调用组（assistant + tool）与最终助手回复经 message-archive 的 `saveMessage` 写入；空回复不保存
7. **发送**: 经 gateway 服务的 `dispatchOutbound` 分发（经过出站中间件链）；gateway 缺失时回退为直接发出 `outbound:message` 事件

`message-archive` 是可选服务。缺席时对话仍可运行、已有历史仍可读取，但新消息不会写入记忆；Agent 在首次实际需要写入时告警，每次激活最多一次。归档服务恢复后，后续消息自动恢复归档，缺席期间的消息不补写。`create-aalis` 的 minimal 及更完整的模板均包含归档插件。

## 上下文裁剪算法

估算 token 超过预算（上下文长度 × `trimThresholdRatio` − 最大输出 token − 512，下限 1024）时，`trimMessages()` 按下表各阶段依次裁剪，任一阶段后回到预算内即停止。

### 保护规则

- 首条系统消息（主提示词）— 永不删除
- 最新用户消息（当前任务上下文）— 永不删除
- 最后一组工具调用（assistant + tool 成组）— 永不删除
- 首条之后的注入系统消息（贡献块、易变上下文等）合计按 `memoryTokenBudget` 预留；超出时先在阶段 1 按比例缩减，阶段 5 作为最后手段删除

### 裁剪阶段

| 阶段 | 操作 | 说明 |
|---|---|---|
| 1 | 缩减注入的系统消息 | 首条与末条之间的 system 消息合计超过 `memoryTokenBudget` 时按比例截短，每条最少保留 200 字符 |
| 2 | 截断过长工具输出 | >1500 字符 → 保留前 500 字符 |
| 2.5 | 精简思考内容 | 超过 200 字符的 `reasoningContent` 从旧到新截断：旧条保留 200 字符，最新一条保留 400 字符（只截断不删除） |
| 3 | 摘要旧工具调用组 | 除最后一组外，压缩为 `[历史工具调用] 工具名 → 结果前 100 字符` 形式的单条 assistant 消息（仅在确实节省 token 时） |
| 4 | 删除最旧非系统消息 | 跳过受保护消息，assistant + tool 成组删除 |
| 5 | 删除注入的系统消息 | 最后手段 |

### 压缩后延续提示

阶段 4 之后仍超预算时进入阶段 5；此路径结束时若消息总数比裁剪前少 6 条及以上，在最后一条用户消息之后注入一条系统提示：

> [系统提示] 由于上下文长度限制，部分历史消息已被压缩或移除。请基于当前可见的上下文和最新用户请求继续完成任务，不要因为看不到之前的细节而停止工作。如果你之前有正在执行的多步骤任务或计划，请查看对话摘要和 todo-list 工具确认当前进度，然后继续未完成的步骤。

该提示防止模型因丢失上下文而放弃正在进行的任务。

## 扩展点

其他插件可通过 `agent:*` 中间件钩子拦截或修改各阶段，通过 `agent:prompt` 贡献点向提示词注入内容，也可以用 `registerPreprocessor` 注册输入预处理器，都无需修改 Agent 代码。钩子键与预处理器见 [api-agent](../api/api-agent.md)，钩子机制见 [api-hooks](../api/api-hooks.md)，贡献点见 [api-contributions](../api/api-contributions.md)。

## Token 预算追踪与日志

首轮与每次工具迭代的 LLM 调用前（裁剪之后），Agent 估算 prompt 消耗并发出 `token:usage` 事件；收到 `token:request`（plugin-webui-server 在客户端订阅会话而无缓存用量、或手动压缩完成后发出）时，也会按当前会话生成一次快照。快照与真实回合用同一个预算公式，系统提示也按同一份会话配置（人设覆盖、结构化输出开关、额外提示）构建：

```ts
'token:usage': [{
  sessionId, platform, contextWindow, maxTokens, tokenBudget,
  used, usageRatio,
  breakdown: {
    system, persona, memorySummary, memoryVector, skills, platform,
    subtask, systemOther, history, toolResults, toolDefs, reservedForReply,
    injectors, // Record<string, number>：systemOther 按注入者标签细分的明细
  }
}]
```

消费者：

- [plugin-webui-server](./plugin-webui-server.md) → WebSocket `'token_usage'` 推给前端面板
- [plugin-memory-summary](./plugin-memory-summary.md) → 超阈值触发自动压缩
- [plugin-prompt-budget](./plugin-prompt-budget.md) → AI 自查工具 `prompt_budget_info`

Agent 自身额外维护一个**节流日志记录器**：

- 状态：`sessionId → { count, lastRatioBucket }`
- 触发条件（满足任一即打印）：
  - `usageRatio` 所处区间（< 0.5 / 0.5–0.7 / 0.7–0.85 / ≥ 0.85）与上次不同时（含回落与会话首次）
  - 每 10 轮强制打印一次
- 标签：`OK / INFO / WARN / CRITICAL`，与 `prompt_budget_info` 工具阈值对齐

日志样例：

```
[token-usage:WARN] <sessionId> 23104/32000 (72.2%) sys=6100(persona=2300 mem=1800 skills=900 subtask=0 other=1100) hist=8901 tools=5400+2703def reserve=4096
```

CLI 与文件日志中也能看到预算消耗，无需打开 WebUI。

