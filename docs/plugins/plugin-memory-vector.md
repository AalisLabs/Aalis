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

1. **消息入库**: 监听 `inbound:message:archived`（入站 user 消息）与 `assistant:message:archived`
   （AI 自身落库回复）两个事件，均带发送者前缀 embed、metadata 带 `role`；
   AI/系统撰写的伪 incoming 不入库（`source: idle-trigger` / `triggerType: proactive` /
   `source: scheduler` / `source: workflow:*` / `userId: parent:*`，即闲聊主动触发、
   跨会话委派与定时/工作流/子任务派发）
2. **语义检索**: 经 `agent:prompt` 贡献点（turn-context 锚位），组装请求时：
   - 将用户最新消息 embed 为查询向量
   - 从 vectorstore 检索 topK×4 候选（`recallRoles: others-only` 时 ×8，补偿角色过滤损耗），按 minScore / 跨会话模式过滤后时间衰减加权重排
   - 命中点经 memory 范围查询扩出前后邻居还原情景，与当前会话内容去重
   - 注入为独立 system 消息；assistant/notice/tool 消息按角色标注
     （`Assistant·你自己` 等），AI 自己的历史回复不会以他人发言形态回流
   - `recallRoles` 配置控制 AI 自身回复是否参与召回（`all` 默认 / `others-only`）；
     角色标注不随该开关关闭。存量未打 role 的旧向量按对方对待

## 依赖

- **vectorstore**: 向量存储服务（如 plugin-vectorstore-flat 或 plugin-vectorstore-lancedb）
- **embedding**: 文本嵌入服务（如 plugin-embedding-ollama 或 plugin-embedding-openai）
