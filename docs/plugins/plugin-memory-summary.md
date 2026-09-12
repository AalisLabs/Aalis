# plugin-memory-summary — 对话摘要压缩

**包名**: `@aalis/plugin-memory-summary`  
**源码**: `packages/plugin-memory-summary/src/index.ts`

## 概述

LLM 驱动的对话摘要插件：会话历史达到阈值或上下文使用率达到预压缩阈值时，把较旧消息压缩成摘要注入上下文，并将这些消息归档以节省上下文空间。摘要同时参与 `memory:clear` 统一清除（类型 `summary`）。

## 插件声明

```typescript
meta.name = '@aalis/plugin-memory-summary'
meta.inject = { required: ['memory', 'llm'], optional: ['message-archive'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `threshold` | number | `30` | 摘要触发阈值：当会话历史超过此条数时，触发旧消息摘要 |
| `keepRecent` | number | `20` | 保留最近消息数：摘要后保留的最近消息条数（不参与摘要的部分） |
| `summaryTokenRatio` | number | `0.05` | 摘要 Token 占比：摘要占模型上下文窗口的比例 (0~1)，例如 0.05 表示 5%。 实际 token 上限 = contextLength × 比例，自动适配不同模型 |
| `autoCompressThreshold` | number | `0.7` | Token 预压缩阈值：监听 agent 发出的 token:usage 事件，当使用率超过此比例 (0~1) 时启动后台压缩。默认 0.7 实现“临界前预压缩”，让本轮调用仍然能用原始上下文完成，压缩后的成果下一轮生效。设为 0 则禁用 token 触发。 |
| `summaryPrompt` | string | `''` | 摘要生成提示词：用于指导 LLM 生成摘要的系统提示词 |
| `summaryModelMode` | select | `'global'` | 摘要模型来源：global=沿用全局默认 LLM；custom=使用下方 summaryLLM 指定的模型。session（沿用会话当轮模型）暂未实现。 |
| `summaryLLM` | llm-ref | — | 摘要模型：仅当 summaryModelMode=custom 时生效；provider 为 LLM 插件实例 contextId，model 为实例内某个模型名。 |

## 工作方式

1. 每轮对话结束后（`agent:turn:after`，中止或出错的回合除外）异步检查是否需要摘要
2. 当消息数 ≥ `threshold` 时触发摘要
3. 另外监听 `token:usage` 事件，上下文使用率达到 `autoCompressThreshold` 时发出 `session:compress`（reason=`auto`）启动后台压缩；收到 `session:compress`（reason 为 `manual` 或 `auto`）时不看 `threshold`，只要历史条数多于 `keepRecent` 就压缩，并通过 `session:compressing` 事件报告 start/done/error
4. 读取最近 max(`threshold`, `keepRecent`+1, 200) 条历史，把除最近 `keepRecent` 条以外的 user/assistant 消息连同已有摘要交给 LLM，生成更新后的摘要（提示词为 `summaryPrompt`，留空则用内置提示词）
5. 摘要写入后调用 memory 的 `trimHistory` 把较旧消息标记为归档，只保留最近 `keepRecent` 条（裁剪点会避开 tool call 组中间）；摘要生成失败或返回空内容时降级为只裁切、不写摘要。若 `message-archive` 服务可用，额外写入一条压缩分隔事件消息
6. 摘要通过 `agent:prompt` 贡献点（`context` 锚位）在 LLM 调用前注入，由 agent 组装为头部 system 区的一条 system 消息；摘要长度超出 token 预算（摘要模型上下文窗口 × `summaryTokenRatio`，下限 512）时截断
7. 摘要经 memory 服务的 metadata 接口持久化（namespace `summary`，key 为会话 ID），与对话历史共用同一存储后端（取决于所用 memory 插件）
