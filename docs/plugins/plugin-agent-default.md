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
   - `message:before` — 消息预处理/拦截
   - `llm-call:before` — 注入记忆上下文、替换工具列表
   - `trimMessages()` — 按 token 预算裁剪上下文
   - `chatStream()` — 流式调用 LLM
   - `llm-call:after` — 处理 LLM 响应
   - 工具调用循环（最多 `maxToolIterations` 次）:
     - `tool-call:before` → 执行工具 → `tool-call:after`
   - `response:before` — 后处理回复内容
   - `message:after` — 消息处理完成通知
5. **保存**: 用户消息和助手回复存入 memory
6. **发送**: 通过 `message:send` 事件分发到各平台

## 上下文裁剪算法

`trimMessages()` 在发给 LLM 前裁剪消息以适配上下文窗口：

- 保护首条系统消息（主提示词）和末条消息（当前用户输入）
- Hook 注入的系统消息有独立预留额度（`memoryTokenBudget`）
- 第一轮：从最旧的非系统消息开始删除（assistant + tool 成组删除）
- 第二轮：如仍超出，删除 hook 注入的系统消息
- 长期记忆超出预留额度时按比例缩减（最少保留 200 字符）

## 扩展点

其他插件可通过中间件钩子扩展 Agent 的每个阶段，无需修改 Agent 代码。详见 [events.md](../core/events.md)。
