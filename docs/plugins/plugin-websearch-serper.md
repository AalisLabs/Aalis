# plugin-websearch-serper — Web 搜索

**包名**: `@aalis/plugin-websearch-serper`  
**源码**: `packages/plugin-websearch-serper/src/index.ts`

## 概述

注册 `web_search` 与 `search_images` 两个工具（归入 `search` 工具分组），通过 Serper.dev API 执行 Google 网页搜索和图片搜索；同时提供 `web-search` 服务（`providerName` 为 `serper`），供其他插件调用。两个工具内置三重限流保护。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-websearch-serper',
  provides: [webSearch],
  uses: {
    tools: optional(tools),
    logger,
    config,
    provide,
    llm: optional(llm),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `apiKey` | string | 必填 | Serper API Key：Serper.dev API 密钥（secret）。**缺失时 apply 直接抛错，插件转 error 态**——启动不中断，但网络搜索不可用 |
| `maxPerMinute` | number | `10` | 每分钟最大次数：频率限制：每分钟最多搜索次数 |
| `maxPerDay` | number | `100` | 每天最大次数：频率限制：每天最多搜索次数 |
| `maxConcurrent` | number | `3` | 最大并发：同时进行的搜索请求数上限 |
| `defaultNumResults` | number | `5` | 默认结果数：每次搜索返回的结果条数 |
| `enableCompression` | boolean | `false` | 启用搜索结果压缩：启用后，搜索结果将先经过 LLM 压缩整合后再返回给 Agent，减少 Token 消耗并提升信息质量。 |
| `compressionLLM` | llm-ref | — | 压缩模型：选择用于压缩搜索结果的模型。留空则使用默认 LLM 提供者。 |
| `compressionPrompt` | textarea | `''` | 压缩提示词：自定义压缩搜索结果的提示词。留空使用默认提示。提示词中可使用 {query} 代表搜索关键词。 |

## 注册的工具

### `web_search`

参数: `{ query: string, numResults?: number }`

`numResults` 缺省取 `defaultNumResults`，并限定在 1-10 之间。

结果按以下顺序拼成文本：直接回答（answerBox）、知识图谱（仅在有 description 时输出）、自然搜索结果（序号、标题、链接、摘要），整体标注为不可信内容；没有任何结果时返回「未找到搜索结果。」。

启用 `enableCompression` 后，这段文本会先交给 LLM 压缩成摘要再返回；压缩失败或没有可用模型时返回原文。请求失败或被限流时返回 JSON 字符串 `{ error }`，被限流时另附当前限流状态 `status`。

### `search_images`

参数: `{ query: string, numResults?: number }`

`numResults` 的缺省值与取值范围同 `web_search`。

调用 Serper 图片搜索，返回 JSON：`{ query, count, images }`。`images` 为各候选图的 title、imageUrl、thumbnailUrl、source、link、width、height 序列化后的文本，整体标注为不可信内容。通常先用它取得候选图片 URL，再交给 `send_attachment` 发送。

## 限流

内置 `RateLimiter` 实现三重保护：
- 分钟窗口限流
- 天窗口限流
- 并发数限制

`web_search` 与 `search_images` 共用同一个限流器，超限时返回 JSON 错误信息，不抛异常；`web-search` 服务的 `search()` 不经过此限流器。
