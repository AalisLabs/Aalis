# plugin-agent-default — 默认对话编排器

**包名**: `@aalis/plugin-agent-default`  
**源码**: `packages/plugin-agent-default/src/index.ts`

## 概述

默认的 `AgentService` 实现，负责编排完整的对话流程：组装提示词 → 加载历史 → 收集工具 → 调用 LLM → 工具循环 → 发送回复。

## 插件声明

```typescript
meta.name = '@aalis/plugin-agent-default'
meta.provides = ['agent']
meta.inject = { optional: ['llm', 'memory', 'persona'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `systemPrompt` | string | 内置行为准则 | 附加到 persona 提示词之后的基础行为准则 |
| `memoryTokenBudget` | number | 4096 | 长期记忆（语义记忆）预留 token 额度 |

## 核心流程

1. **构建系统提示词**: persona 提示词 + 配置的 systemPrompt
2. **加载历史**: 从 memory 服务获取最近消息
3. **收集工具**: 从 ToolRegistry 获取所有已注册工具定义
4. **执行 Hook 管道**:
   - `agent:input:before` — 消息预处理/拦截
   - `agent:llm:before` — 注入记忆上下文、替换工具列表
   - `trimMessages()` — 按 token 预算裁剪上下文
   - `chatStream()` — 流式调用 LLM
   - `agent:llm:after` — 处理 LLM 响应
   - 工具调用循环（最多 `maxToolIterations` 次）:
     - `agent:tool:before` → 执行工具 → `agent:tool:after`
   - `agent:reply:before` — 后处理回复内容
   - `agent:turn:after` — 消息处理完成通知
5. **保存**: 用户消息和助手回复存入 memory
6. **发送**: 通过 `outbound:message` 事件分发到各平台

## 上下文裁剪算法

`trimMessages()` 在发给 LLM 前采用五阶段策略裁剪消息以适配上下文窗口：

### 保护规则

- 首条系统消息（主提示词）— 永不删除
- 最新用户消息（当前任务上下文）— 永不删除
- 最后一组工具调用（assistant + tool 成组）— 永不删除
- Hook 注入的系统消息有独立预留额度（`memoryTokenBudget`）

### 裁剪阶段

| 阶段 | 操作 | 说明 |
|---|---|---|
| 1 | 压缩超大系统消息 | 最少保留 200 字符 |
| 2 | 截断过长工具输出 | >1500 字符 → 保留前 500 字符 |
| 2.5 | 精简思考内容 | 删除旧迭代的 `reasoningContent`，截断最新一条 |
| 3 | 摘要旧工具调用组 | 压缩为 `[tool] → result` 摘要格式 |
| 4 | 删除最旧非系统消息 | 跳过受保护消息，assistant + tool 成组删除 |
| 5 | 删除 Hook 注入的系统消息 | 最后手段 |

### 压缩后延续提示

当第四阶段删除 ≥6 条消息时，自动注入系统提示：

> 由于上下文长度限制，部分历史消息已被压缩或移除。请基于当前可见的上下文继续完成任务。

该提示防止模型因丢失上下文而放弃正在进行的任务。

## 扩展点

其他插件可通过中间件钩子扩展 Agent 的每个阶段，无需修改 Agent 代码。详见 [events.md](../core/events.md)。
