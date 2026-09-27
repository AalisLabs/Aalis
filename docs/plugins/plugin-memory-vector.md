# plugin-memory-vector — 语义记忆

**包名**: `@aalis/plugin-memory-vector`  
**源码**: `packages/plugin-memory-vector/src/index.ts`

## 概述

向量语义记忆插件。将消息嵌入向量空间，在 LLM 调用前自动检索相关历史片段注入上下文。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-memory-vector',
  subsystem: 'memory',
  provides: [semanticMemory],
  uses: {
    vectorstore,
    embedding,
    memory: optional(memory),
    tools: optional(tools),
    events,
    hooks,
    contributions,
    provide,
    logger,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
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
   已烘入引用与附件描述，非 webui/cli 平台还带发送者前缀）；assistant 侧 embed 可见正文
   （落库内容是结构化输出信封时取 metadata 的 `visibleContent`，缺省为 `content`），在取得自身身份时
   embed 前经 `prefixSender` 加自身发送者前缀；
   AI/系统撰写的伪 incoming 不入库（`source: idle-trigger` / `triggerType: proactive` /
   `source: scheduler` / `source: workflow:*` / `userId: parent:*`，即闲聊主动触发、
   workflow agent 节点与定时/工作流/子任务派发）
2. **语义检索**: 经 `agent:prompt` 贡献点（turn-context 锚位），组装请求时：
   - 将用户最新消息 embed 为查询向量
   - 从 vectorstore 检索 topK×4 候选（`recallRoles: others-only` 时 ×8，补偿角色过滤损耗），按 embedding 模型（见下节）、minScore 与跨会话模式过滤后时间衰减加权重排；
     `crossSessionMode: user` 时，当前用户本人发言或被 @ 的命中再乘 `search.userPriorityBoost`
   - 当 `contextExpand.window > 0` 且 memory 服务支持 `getMessagesBySessionRange` 时，命中点经范围查询
     扩出前后各 N 条邻居还原情景（`contextExpand.crossSession` 关闭时不扩展其他会话的命中）；
     否则只注入命中本身。结果与当前会话已有内容去重
   - 注入为独立 system 消息；assistant/notice/tool 消息按角色标注
     （`Assistant·你自己` 等），AI 自己的历史回复不会以他人发言形态回流；正文优先取 metadata 的
     `visibleContent`，缺省按 `content` 呈现（升级前落库的消息没有该键）
   - `recallRoles` 配置控制 AI 自身回复是否参与召回（`all` 默认 / `others-only`）；
     角色标注不随该开关关闭。存量未打 role 的旧向量按对方对待
3. **主动召回**: 注册 `memory_recall` 工具，按任意 query 检索，与被动注入共用同一检索排序
   （候选放大、模型过滤、角色过滤、minScore、可见范围、时间衰减、`user` 模式的同用户加权）与扩窗取数；
   `scope` 与 `contextWindow` / `crossSession` 参数只能比插件配置更窄，不能更宽

## embedding 模型与存量向量

只有同一 embedding 模型算出的向量才能互相比较。embedding 提供者声明了 `modelId`（向量空间标识，第一方提供者为 `ollama:<model>` / `openai:<model>`）时：

- **写入**：新向量的 metadata 带 `modelId`，取自算这条向量的同一提供者实例。
- **检索**：被动注入与 `memory_recall` 只保留与查询向量同模型的候选，同维度换模型后其它模型的向量也不会混入排序。排除发生在取回候选之后，候选池大小不变；库里其它模型的向量占多数时，实际命中会少于 `topK`，甚至为零。
- **存量向量**：升级前写入的向量不带 `modelId`。插件首次检索时读取记忆元数据中的存量标记（namespace `memory-vector`、key `legacy-model`）：已有记录则把存量向量视为该模型生成，没有记录则记下当前模型。memory 服务不在或元数据读写出错时，本次把存量向量视为与当前模型一致（与升级前相同），下次检索时再试；读写连续出错只记一次 warn。
- **告警**：因模型不一致排除候选时，每个当前模型在一次运行中只记一次 warn，列出被排除向量的模型。要继续召回这些记忆，改回原模型或用当前模型重新 embed 这些向量；不再需要时用 `/clear all -t vector` 清空向量库，由新消息重建。

提供者未声明 `modelId` 时，写入不带该键，检索也不按模型过滤。

存量标记记的是升级后首次检索时的模型，存放在记忆元数据里。只清消息历史（如 `/clear all -t context`）不动它；全局清空向量库（`/clear all -t vector`，或不带类型的 `/clear all`）时，插件一并删除存量标记并复位缓存，之后的检索按当时的模型重新记下；删除失败只记一条 warn，不影响清空结果。以下两种情况存量向量会被记成当时的模型、继续混入检索，需清空向量库：升级时同时换了模型；memory 后端是元数据不持久的 plugin-memory-inmemory 而向量库持久化，换模型后一重启，标记就按新模型重记。

## 依赖

- **vectorstore**: 向量存储服务（如 plugin-vectorstore-flat 或 plugin-vectorstore-lancedb）
- **embedding**: 文本嵌入服务（如 plugin-embedding-ollama 或 plugin-embedding-openai）
- **memory**（可选）: 消息存储服务，两个用途：提供 `getMessagesBySessionRange` 时用于命中点的上下文情景扩展，缺失或不支持时退化为仅取命中本身；记忆元数据存放存量标记（见上节），缺失时存量向量按当前模型对待。该服务在调用点惰性查询、能力也在调用点判定，故 memory provider 晚于本插件注册或重载后无需重启即生效。plugin-memory-inmemory 的元数据不持久，与持久化向量库（plugin-vectorstore-flat / plugin-vectorstore-lancedb）搭配时，每次重启都会按当时的模型重记存量标记
