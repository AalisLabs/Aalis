# plugin-memory-summary — 对话摘要压缩

**包名**: `@aalis/plugin-memory-summary`  
**源码**: `packages/plugin-memory-summary/src/index.ts`

## 概述

LLM 驱动的对话摘要服务，当消息积累到阈值时自动触发摘要压缩，将旧消息替换为精简摘要以节省上下文空间。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-summary'
meta.inject = { required: ['llm', 'memory'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `triggerCount` | number | `30` | 触发摘要的消息条数阈值 |
| `keepRecent` | number | `20` | 保留最近 N 条不参与摘要 |
| `maxOutputTokens` | number | `1024` | 摘要最大 token 数 |

## 工作方式

1. 通过 `agent:turn:after` 钩子监控消息数量
2. 当消息数 ≥ `triggerCount` 时触发摘要
3. 取最旧的 `count - keepRecent` 条消息交给 LLM 生成摘要
4. 摘要以 system 消息形式在 `agent:llm:before` 钩子中注入到上下文
5. 摘要结果持久化到 SQLite（独立表），与原始消息分开存储
