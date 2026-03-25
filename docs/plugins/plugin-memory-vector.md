# plugin-memory-vector — 语义记忆

**包名**: `@aalis/plugin-memory-vector`  
**源码**: `packages/plugin-memory-vector/src/index.ts`

## 概述

向量语义记忆插件。将消息嵌入向量空间，在 LLM 调用前自动检索相关历史片段注入上下文，赋予 AI 长期记忆能力。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-vector'
meta.provides = ['semantic-memory']
meta.inject = { required: ['vectorstore', 'embedding'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `search.topK` | number | 5 | 语义搜索最大返回条数 |
| `search.timeWeight` | number | 0.3 | 时间权重（0=纯语义，1=纯近因） |

## 工作原理

1. **消息入库**: 监听 `message:received` 和 `message:send` 事件，将消息 embed 后存入 vectorstore
2. **语义检索**: 通过 `llm-call:before` 中间件（优先级 50），在 LLM 调用前：
   - 将用户最新消息 embed 为查询向量
   - 从 vectorstore 检索 topK 条最相关历史片段
   - 使用时间衰减加权重排: `recencyScore = exp(-0.1 * days)`
   - 过滤与当前会话重复的内容
   - 注入为 system 消息供 LLM 参考

## 依赖

- **vectorstore**: 向量存储服务（如 plugin-vectorstore-flat 或 plugin-vectorstore-lancedb）
- **embedding**: 文本嵌入服务（如 plugin-embedding-ollama 或 plugin-embedding-openai）
