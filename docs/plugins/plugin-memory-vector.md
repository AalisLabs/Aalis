# plugin-memory-vector — 语义记忆

**包名**: `@aalis/plugin-memory-vector`  
**源码**: `packages/plugin-memory-vector/src/index.ts`

## 概述

向量语义记忆插件。将消息嵌入向量空间，在 LLM 调用前自动检索相关历史片段注入上下文。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-vector'
meta.subsystem = 'memory'
meta.provides = ['semantic-memory']
meta.inject = { required: ['vectorstore', 'embedding'], optional: ['memory'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `search` | object | — | 搜索设置 |
| `search.topK` | number | `5` | 最大返回数：语义搜索返回的命中条数（每条会再带上下文窗口） |
| `search.timeWeight` | number | `0.3` | 时间权重：0=纯语义，1=纯时间近因 |
| `search.userPriorityBoost` | number | `2` | 同用户加权系数：在 user 模式下对同一用户消息的命中分数乘以该系数（&gt;1 表示优先） |
| `search.perItemMaxChars` | number | `0` | 单条截断字数：每条消息呈现给 LLM 时的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。 |
| `search.minScore` | number | `0` | 最低相似度阈值：0~1，命中分数（时间加权前的语义分）低于该值则丢弃。0 表示不过滤 |
| `contextExpand` | object | — | 上下文情景扩展：命中后自动取该消息在原会话中的前后 N 条相邻消息（含 user/assistant/system/tool）还原情景。0 = 关闭。 |
| `contextExpand.window` | number | `2` | 扩展窗口（前后各 N 条消息）：0 = 仅命中本身。建议 2~5。负数会报错 |
| `contextExpand.crossSession` | boolean | `true` | 跨会话也扩展：若命中消息来自其他会话（user/all 模式可能发生），是否对那个会话也取上下文 |
| `indexing` | object | — | 索引设置：控制后台向量索引的削峰与并发。搜索路径不受该队列影响。 |
| `indexing.concurrency` | number | `10` | 最大并发索引数：同时进行的后台 embedding + 向量写入任务数。0 或负数表示不限制；建议 2~10，过高可能压垮本地 embedding 服务。 |
| `indexing.maxQueueSize` | number | `500` | 最大索引队列长度：待索引消息队列上限。0 或负数表示不限制；超出后丢弃最旧待索引消息，避免内存无限增长。 |
| `recallRoles` | select | `'all'` | 召回角色范围：AI 自己的历史回复（role=assistant）是否作为语义命中参与召回。others-only 档过滤的是**命中点**（候选池自动放大一倍补偿）；命中点的上下文扩窗邻居不过滤、仍可能以「Assistant·你自己」标注出现（保留情景完整性）。无论何档，assistant 条目渲染必带角色标注（防自我强化地基，不随开关关闭）。存量未打 role 的旧向量按 user（对方）对待 |
| `crossSessionMode` | select | `'all'` | 跨会话检索模式：控制向量记忆的跨会话可见范围 |

## 工作原理

1. **消息入库**: 监听 `inbound:message:archived`（入站 user 消息）与 `assistant:message:archived`
   （AI 自身落库回复）两个事件，metadata 带 `role`。入站侧 embed 归档文本（message-archive
   已烘入引用与附件描述，非 webui/cli 平台还带发送者前缀）；assistant 侧在取得自身身份时，
   embed 前经 `prefixSender` 加自身发送者前缀；
   AI/系统撰写的伪 incoming 不入库（`source: idle-trigger` / `triggerType: proactive` /
   `source: scheduler` / `source: workflow:*` / `userId: parent:*`，即闲聊主动触发、
   跨会话委派与定时/工作流/子任务派发）
2. **语义检索**: 经 `agent:prompt` 贡献点（turn-context 锚位），组装请求时：
   - 将用户最新消息 embed 为查询向量
   - 从 vectorstore 检索 topK×4 候选（`recallRoles: others-only` 时 ×8，补偿角色过滤损耗），按 minScore / 跨会话模式过滤后时间衰减加权重排
   - 当 `contextExpand.window > 0` 且 memory 服务支持 `getMessagesBySessionRange` 时，命中点经范围查询
     扩出前后各 N 条邻居还原情景（`contextExpand.crossSession` 关闭时不扩展其他会话的命中）；
     否则只注入命中本身。结果与当前会话已有内容去重
   - 注入为独立 system 消息；assistant/notice/tool 消息按角色标注
     （`Assistant·你自己` 等），AI 自己的历史回复不会以他人发言形态回流
   - `recallRoles` 配置控制 AI 自身回复是否参与召回（`all` 默认 / `others-only`）；
     角色标注不随该开关关闭。存量未打 role 的旧向量按对方对待

## 依赖

- **vectorstore**: 向量存储服务（如 plugin-vectorstore-flat 或 plugin-vectorstore-lancedb）
- **embedding**: 文本嵌入服务（如 plugin-embedding-ollama 或 plugin-embedding-openai）
- **memory**（可选）: 消息存储服务；提供 `getMessagesBySessionRange` 时用于命中点的上下文情景扩展，缺失或不支持时退化为仅取命中本身。该服务在每次扩窗时惰性查询、能力也在调用点判定，故 memory provider 晚于本插件注册或重载后无需重启即生效
